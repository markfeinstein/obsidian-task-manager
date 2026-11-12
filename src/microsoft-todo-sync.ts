import { ProviderHttpError, requestResponse as boundedRequest, retryAfterMilliseconds } from './network-request';
/**
 * Microsoft To Do Bidirectional Sync
 *
 * Sync tasks with Microsoft To Do and Microsoft Graph API.
 * Requires OAuth2 authentication. The plugin uses a safe manual/token-paste
 * OAuth subset; it does not run a localhost callback server.
 */

import type { AdapterCapability, FieldConflict, SyncAdapter } from './sync-contract';
import type { MarkdownTask } from './task-model';
import { normalizeTaskText, stripTaskMetadata } from './task-model';
import { explicitTaskKey } from './task-identity';
import { buildPkceAuthorizationUrl, exchangeAuthorizationCodeForToken, parseOAuthCode, refreshOAuthAccessToken, type OAuthPkceStart, type OAuthTokenResponse } from './oauth-pkce';
import { isValidIsoDate } from './date-utils';
import { taskLineCheckbox, taskLineCompleted, taskLinePriority, taskLineServiceId, taskLineTitle } from './sync-task-line';
import { sanitizeUntrustedInlineFieldValue, sanitizeUntrustedTaskText, sanitizeUntrustedTaskTextLines } from './untrusted-task-text';
import { utf8ByteLength } from './input-budgets';
import { isProviderRunCancellation } from './provider-sync-safety';
import { canonicalProjection, canonicalProjectionOrThrow, projectionsEqual, reconcileSupportedProjections, type ProjectionReconciliation, type SupportedFieldProjection } from './sync-reconciliation';

export interface MicrosoftTodoConfig {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  expiresAt?: number;
  listId?: string;
  bidirectionalSync: boolean;
  deleteMissingRemote?: boolean;
  localSnapshotComplete?: boolean;
  maxDeletePercentage?: number;
  syncIntervalMinutes: number;
  vaultImportPath: string;
  lastSync?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

async function microsoftTodoRequest(config: MicrosoftTodoConfig, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  config.assertCurrent?.();
  const response = await boundedRequest(
    input,
    { ...init, signal: config.signal },
    { signal: config.signal, redirect: 'error' },
  );
  config.assertCurrent?.();
  return response;
}

async function microsoftTodoResponseError(response: Response, prefix: string): Promise<ProviderHttpError> {
  let detail = '';
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    detail = [body.error?.message, body.error?.code].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' - ').slice(0, 512);
  } catch { detail = ''; }
  return new ProviderHttpError(`${prefix}: ${response.status}${detail ? ` - ${detail}` : ''}`, response.status, retryAfterMilliseconds(response));
}

function microsoftTodoContextError(prefix: string, error: unknown): Error {
  if (isProviderRunCancellation(error)) return error instanceof Error ? error : new Error(String(error));
  return error instanceof ProviderHttpError
    ? new ProviderHttpError(`${prefix}: ${error.message}`, error.statusCode, error.retryAfterMs)
    : new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}

export interface MicrosoftTodoTask {
  id: string;
  title: string;
  body?: string | { content?: string; contentType?: string };
  isReminderOn: boolean;
  dueDateTime?: { dateTime: string; timeZone: string };
  importance?: 'low' | 'normal' | 'high';
  status?: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
  lastModifiedDateTime?: string;
  '@odata.etag'?: string;
}

export interface MicrosoftTodoList {
  id: string;
  displayName?: string;
  wellknownListName?: string;
}

function microsoftBodyContent(body: MicrosoftTodoTask['body']): string | undefined {
  if (!body) return undefined;
  if (typeof body === 'string') return body;
  return body.content;
}

const MICROSOFT_TODO_STATUSES = new Set<NonNullable<MicrosoftTodoTask['status']>>(['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred']);
const MICROSOFT_TODO_IMPORTANCES = new Set<NonNullable<MicrosoftTodoTask['importance']>>(['low', 'normal', 'high']);
const MICROSOFT_GRAPH_ORIGIN = 'https://graph.microsoft.com';
const MICROSOFT_TODO_ID_PATTERN = /^[^\s\[\]\r\n]+$/u;
const MICROSOFT_TODO_PAGE_SIZE = 100;
const MICROSOFT_TODO_MAX_TASK_PAGES = 200;
const MICROSOFT_TODO_MAX_SNAPSHOT_TASKS = 20_000;
const MICROSOFT_TODO_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MICROSOFT_TODO_MAX_NEXT_LINK_BYTES = 16 * 1024;
const MICROSOFT_TODO_MAX_ID_BYTES = 4 * 1024;
const MICROSOFT_TODO_MAX_TITLE_BYTES = 1024;
const MICROSOFT_TODO_MAX_BODY_BYTES = 1024 * 1024;
const MICROSOFT_TODO_MAX_DATE_TIME_BYTES = 128;
const MICROSOFT_TODO_MAX_TIME_ZONE_BYTES = 1024;
const MICROSOFT_TODO_MAX_VERSION_BYTES = 4 * 1024;
const MICROSOFT_TODO_MAX_BODY_TYPE_BYTES = 64;
const MICROSOFT_TODO_MAX_LISTS = 100;
const MICROSOFT_TODO_MAX_LIST_METADATA_BYTES = 1024 * 1024;
const MICROSOFT_TODO_MAX_LIST_NAME_BYTES = 4 * 1024;

function isSafeMicrosoftTodoId(value: string): boolean {
  return MICROSOFT_TODO_ID_PATTERN.test(value) && utf8ByteLength(value) <= MICROSOFT_TODO_MAX_ID_BYTES;
}

function microsoftFieldFits(value: unknown, maximum: number): boolean {
  return typeof value !== 'string' || utf8ByteLength(value) <= maximum;
}

export function accumulateMicrosoftTodoSnapshotBudget(
  taskCount: number,
  byteCount: number,
  item: unknown,
  limits: { maxTasks: number; maxBytes: number } = { maxTasks: MICROSOFT_TODO_MAX_SNAPSHOT_TASKS, maxBytes: MICROSOFT_TODO_MAX_SNAPSHOT_BYTES },
): number {
  if (taskCount >= limits.maxTasks) throw new Error(`Microsoft To Do snapshot exceeded ${limits.maxTasks} tasks`);
  const nextBytes = byteCount + utf8ByteLength(JSON.stringify(item) ?? '');
  if (nextBytes > limits.maxBytes) throw new Error(`Microsoft To Do snapshot exceeded ${limits.maxBytes} aggregate bytes`);
  return nextBytes;
}

function assertSafeMicrosoftTodoTaskPageUrl(value: string, listId: string): string {
  if (utf8ByteLength(value) > MICROSOFT_TODO_MAX_NEXT_LINK_BYTES) {
    throw new Error(`Microsoft To Do next page URL exceeded ${MICROSOFT_TODO_MAX_NEXT_LINK_BYTES} bytes`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Microsoft To Do pagination returned an invalid next page URL');
  }
  const expectedPath = `/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks`;
  if (url.origin !== MICROSOFT_GRAPH_ORIGIN || url.pathname !== expectedPath) {
    throw new Error('Microsoft To Do pagination returned an unexpected next page URL');
  }
  return url.toString();
}

function microsoftBodyFromUnknown(value: unknown): MicrosoftTodoTask['body'] | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const body: { content?: string; contentType?: string } = {};
  if (typeof record.content === 'string') body.content = record.content;
  if (typeof record.contentType === 'string') body.contentType = record.contentType;
  return body.content !== undefined || body.contentType !== undefined ? body : undefined;
}

function microsoftDueDateTimeFromUnknown(value: unknown): MicrosoftTodoTask['dueDateTime'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.dateTime !== 'string' || typeof record.timeZone !== 'string') return undefined;
  return { dateTime: record.dateTime, timeZone: record.timeZone };
}

function normalizeMicrosoftTodoTaskPayload(value: unknown, strictSnapshot = false): MicrosoftTodoTask | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id !== record.id.trim() || !isSafeMicrosoftTodoId(record.id)) return null;
  if (strictSnapshot && (typeof record.title !== 'string' || typeof record.isReminderOn !== 'boolean')) return null;
  if (!microsoftFieldFits(record.id, MICROSOFT_TODO_MAX_ID_BYTES)
    || !microsoftFieldFits(record.title, MICROSOFT_TODO_MAX_TITLE_BYTES)
    || !microsoftFieldFits(record.lastModifiedDateTime, MICROSOFT_TODO_MAX_DATE_TIME_BYTES)
    || !microsoftFieldFits(record['@odata.etag'], MICROSOFT_TODO_MAX_VERSION_BYTES)) return null;

  const task: MicrosoftTodoTask = {
    id: record.id,
    title: typeof record.title === 'string' ? record.title : '',
    isReminderOn: record.isReminderOn === true,
  };

  if (record.body !== undefined && record.body !== null) {
    if (strictSnapshot && typeof record.body === 'string' && !microsoftFieldFits(record.body, MICROSOFT_TODO_MAX_BODY_BYTES)) return null;
    if (strictSnapshot && typeof record.body === 'object') {
      const bodyRecord = record.body as Record<string, unknown>;
      if ((bodyRecord.content !== undefined && typeof bodyRecord.content !== 'string')
        || (bodyRecord.contentType !== undefined && typeof bodyRecord.contentType !== 'string')
        || !microsoftFieldFits(bodyRecord.content, MICROSOFT_TODO_MAX_BODY_BYTES)
        || !microsoftFieldFits(bodyRecord.contentType, MICROSOFT_TODO_MAX_BODY_TYPE_BYTES)
        || (typeof bodyRecord.contentType === 'string' && !['text', 'html'].includes(bodyRecord.contentType.toLowerCase()))) return null;
    }
    const body = microsoftBodyFromUnknown(record.body);
    if (strictSnapshot && body === undefined) return null;
    if (body !== undefined) task.body = body;
  }
  if (record.dueDateTime !== undefined && record.dueDateTime !== null) {
    const dueDateTime = microsoftDueDateTimeFromUnknown(record.dueDateTime);
    if (strictSnapshot && (!dueDateTime
      || !microsoftFieldFits(dueDateTime.dateTime, MICROSOFT_TODO_MAX_DATE_TIME_BYTES)
      || !microsoftFieldFits(dueDateTime.timeZone, MICROSOFT_TODO_MAX_TIME_ZONE_BYTES))) return null;
    if (dueDateTime) task.dueDateTime = dueDateTime;
  }
  if (record.importance !== undefined) {
    if (typeof record.importance !== 'string' || !MICROSOFT_TODO_IMPORTANCES.has(record.importance as NonNullable<MicrosoftTodoTask['importance']>)) return null;
    task.importance = record.importance as NonNullable<MicrosoftTodoTask['importance']>;
  }
  if (record.status !== undefined) {
    if (typeof record.status !== 'string' || !MICROSOFT_TODO_STATUSES.has(record.status as NonNullable<MicrosoftTodoTask['status']>)) return null;
    task.status = record.status as NonNullable<MicrosoftTodoTask['status']>;
  } else if (strictSnapshot) return null;
  if (record.lastModifiedDateTime !== undefined) {
    if (strictSnapshot && typeof record.lastModifiedDateTime !== 'string') return null;
    if (typeof record.lastModifiedDateTime === 'string') task.lastModifiedDateTime = record.lastModifiedDateTime;
  }
  if (record['@odata.etag'] !== undefined) {
    if (strictSnapshot && typeof record['@odata.etag'] !== 'string') return null;
    if (typeof record['@odata.etag'] === 'string') task['@odata.etag'] = record['@odata.etag'];
  }
  return task;
}

function normalizeMicrosoftTodoTime(time: string): string | undefined {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/u);
  if (!match) return undefined;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return undefined;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

const MICROSOFT_TODO_TIMEZONE_FIELD = 'ms-todo-timezone';

function microsoftTodoTimezoneFromTaskLine(taskLine: string): string | undefined {
  const match = taskLine.match(/[\[(]ms-todo-timezone::\s*([^\]\)\r\n]+)[\])]/iu);
  const value = match?.[1]?.replace(/\s+/gu, ' ').trim();
  return value || undefined;
}

function microsoftDueTimeZone(task: MicrosoftTodoTask): string | undefined {
  const value = task.dueDateTime?.timeZone?.replace(/\s+/gu, ' ').trim();
  return value || undefined;
}

function shouldPersistMicrosoftTodoTimeZone(timeZone: string | undefined): boolean {
  return Boolean(timeZone && timeZone.toUpperCase() !== 'UTC');
}

function microsoftTodoTimeZoneForComparison(timeZone: string | undefined): string {
  const normalized = timeZone?.replace(/\s+/gu, ' ').trim();
  return normalized && normalized.toUpperCase() !== 'UTC' ? normalized : 'UTC';
}

function microsoftDueDateTime(task: MicrosoftTodoTask): { date?: string; time?: string } {
  const dateTime = task.dueDateTime?.dateTime?.trim();
  if (!dateTime) return {};

  const match = dateTime.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/u);
  const date = match?.[1];
  if (!date || !isValidIsoDate(date)) return {};

  const time = match?.[2] ? normalizeMicrosoftTodoTime(match[2]) : undefined;
  return time ? { date, time } : { date };
}

function microsoftDueDate(task: MicrosoftTodoTask): string | undefined {
  return microsoftDueDateTime(task).date;
}

function microsoftDueTime(task: MicrosoftTodoTask): string | undefined {
  return microsoftDueDateTime(task).time;
}

function taskLineDueDateTime(taskLine: string): { date?: string; time?: string } {
  const match = taskLine.match(/[📅📆🗓]\uFE0F?\s*(?:\[\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?(?:\|[^\]]*)?\]\]|(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?)(?=\]\]|[|\s]|$)/u);
  const date = match?.[1] ?? match?.[3];
  if (!date || !isValidIsoDate(date)) return {};

  const time = match?.[2] ?? match?.[4];
  const normalizedTime = time ? normalizeMicrosoftTodoTime(time) : undefined;
  return normalizedTime ? { date, time: normalizedTime } : { date };
}

function microsoftCheckboxFromStatus(status: MicrosoftTodoTask['status']): string {
  if (status === 'completed') return 'x';
  if (status === 'inProgress') return '/';
  if (status === 'deferred') return '>';
  return ' ';
}

function microsoftTaskTitle(task: MarkdownTask): string {
  return normalizeTaskText(stripTaskMetadata(task.normalizedText || task.body))
    .replace(/(^|\s)#[^\s#]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || 'Untitled';
}

function microsoftStatusFromVault(task: MarkdownTask): MicrosoftTodoTask['status'] | undefined {
  if (task.status === 'done') return 'completed';
  if (task.status === 'in_progress') return 'inProgress';
  if (task.status === 'deferred') return 'deferred';
  if (task.status === 'todo') return 'notStarted';
  return undefined;
}

export function microsoftTodoProjectionFromVaultTask(task: MarkdownTask): SupportedFieldProjection {
  const dueTimeZone = microsoftTodoTimezoneFromTaskLine(task.rawLine || task.body) ?? 'UTC';
  const status = microsoftStatusFromVault(task);
  return canonicalProjectionOrThrow({
    title: microsoftTaskTitle(task),
    description: task.metadata.comments?.join('\n') ?? '',
    due: task.metadata.dates.due ? {
      date: task.metadata.dates.due,
      time: normalizeMicrosoftTodoTime(task.metadata.dates.dueTime ?? '') ?? '00:00',
      timeZone: microsoftTodoTimeZoneForComparison(dueTimeZone),
    } : null,
    priority: task.metadata.priority === 'high' || task.metadata.priority === 'highest' ? 'high' : task.metadata.priority === 'low' || task.metadata.priority === 'lowest' ? 'low' : 'normal',
    status: status ?? `unsupported:${task.status}`,
  });
}

export function microsoftTodoProjectionFromRemoteTask(task: MicrosoftTodoTask): SupportedFieldProjection {
  const due = microsoftDueDateTime(task);
  return canonicalProjectionOrThrow({
    title: normalizeTaskText(task.title) || 'Untitled Microsoft To Do task',
    description: (microsoftBodyContent(task.body) ?? '').replace(/\r\n?/gu, '\n'),
    due: due.date ? { date: due.date, time: due.time ?? '00:00', timeZone: microsoftTodoTimeZoneForComparison(microsoftDueTimeZone(task)) } : null,
    priority: task.importance ?? 'normal',
    status: task.status === 'waitingOnOthers' ? 'unsupported:waitingOnOthers' : task.status ?? 'notStarted',
  });
}

export function microsoftTodoRemoteVersion(task: MicrosoftTodoTask): string | undefined {
  return task['@odata.etag'] ?? task.lastModifiedDateTime;
}

export function reconcileMicrosoftTodoTask(
  local: MarkdownTask,
  remote: MicrosoftTodoTask | undefined,
  baseline?: unknown,
): ProjectionReconciliation {
  const result = reconcileSupportedProjections({
    service: 'microsoft-todo',
    local: microsoftTodoProjectionFromVaultTask(local),
    remote: remote ? microsoftTodoProjectionFromRemoteTask(remote) : undefined,
    baseline,
    remoteVersion: remote ? microsoftTodoRemoteVersion(remote) : undefined,
  });
  const unsupported = result.fields.filter((field) =>
    field.field === 'status'
    && [field.localValue, field.remoteValue].some((value) => typeof value === 'string' && value.startsWith('unsupported:')),
  );
  if (unsupported.length === 0) return result;
  const detectedAt = result.evidence.capturedAt;
  return {
    ...result,
    mode: 'conflict',
    outbound: {},
    inbound: {},
    nextBaseline: undefined,
    fields: result.fields.map((field) => unsupported.some((candidate) => candidate.field === field.field) ? { ...field, decision: 'conflict', reason: 'divergent-dual-change' } : field),
    conflicts: unsupported.map((field) => ({ field: field.field, vaultValue: field.localValue, serviceValue: field.remoteValue, service: 'microsoft-todo', detectedAt })),
    evidence: { ...result.evidence, mode: 'conflict' },
  };
}

export function microsoftTodoPayloadFromProjection(projection: SupportedFieldProjection): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if ('title' in projection) payload.title = projection.title;
  if ('description' in projection) payload.body = { content: projection.description, contentType: 'text' };
  if ('due' in projection) {
    const due = projection.due;
    payload.dueDateTime = due && typeof due === 'object' && !Array.isArray(due)
      && typeof due.date === 'string' && typeof due.time === 'string' && typeof due.timeZone === 'string'
      ? { dateTime: `${due.date}T${due.time}:00`, timeZone: due.timeZone }
      : null;
  }
  if ('priority' in projection) payload.importance = projection.priority;
  if ('status' in projection && typeof projection.status === 'string' && !projection.status.startsWith('unsupported:')) payload.status = projection.status;
  return payload;
}

function markdownInline(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export const MICROSOFT_TODO_SCOPE = 'Tasks.Read Tasks.ReadWrite offline_access';
export const MICROSOFT_TODO_AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const MICROSOFT_TODO_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const MICROSOFT_TODO_DEFAULT_REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';

export function microsoftTodoOAuthUrl(clientId: string, redirectUri = MICROSOFT_TODO_DEFAULT_REDIRECT_URI): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: MICROSOFT_TODO_SCOPE,
  });
  return `${MICROSOFT_TODO_AUTH_ENDPOINT}?${params.toString()}`;
}

export async function microsoftTodoPkceOAuthStart(
  clientId: string,
  options: { redirectUri?: string; state?: string; codeVerifier?: string } = {},
): Promise<OAuthPkceStart> {
  return buildPkceAuthorizationUrl({
    authorizationEndpoint: MICROSOFT_TODO_AUTH_ENDPOINT,
    clientId,
    redirectUri: options.redirectUri ?? MICROSOFT_TODO_DEFAULT_REDIRECT_URI,
    scope: MICROSOFT_TODO_SCOPE,
    state: options.state,
    codeVerifier: options.codeVerifier,
    extraParams: { prompt: 'select_account' },
  });
}

export async function exchangeMicrosoftTodoAuthorizationCode(options: {
  clientId: string;
  codeOrCallbackUrl: string;
  codeVerifier: string;
  redirectUri?: string;
  expectedState?: string;
  signal?: AbortSignal;
}): Promise<OAuthTokenResponse> {
  const { code, state } = parseOAuthCode(options.codeOrCallbackUrl);
  if (options.expectedState !== undefined && state !== options.expectedState) {
    throw new Error('OAuth callback state did not match the active login session');
  }
  return exchangeAuthorizationCodeForToken({
    tokenEndpoint: MICROSOFT_TODO_TOKEN_ENDPOINT,
    clientId: options.clientId,
    code,
    codeVerifier: options.codeVerifier,
    redirectUri: options.redirectUri ?? MICROSOFT_TODO_DEFAULT_REDIRECT_URI,
    signal: options.signal,
  });
}

export async function refreshMicrosoftTodoAccessToken(options: {
  clientId: string;
  refreshToken: string;
  signal?: AbortSignal;
}): Promise<OAuthTokenResponse> {
  return refreshOAuthAccessToken({
    tokenEndpoint: MICROSOFT_TODO_TOKEN_ENDPOINT,
    clientId: options.clientId,
    refreshToken: options.refreshToken,
    scope: MICROSOFT_TODO_SCOPE,
    signal: options.signal,
  });
}

function requireMicrosoftTodoAccessToken(config: Pick<MicrosoftTodoConfig, 'accessToken'>): string {
  const accessToken = config.accessToken?.trim();
  if (!accessToken) throw new Error('Not authenticated with Microsoft To Do');
  return accessToken;
}

export async function resolveMicrosoftTodoListId(config: MicrosoftTodoConfig): Promise<string> {
  if (config.listId?.trim()) {
    const configured = config.listId.trim();
    if (!isSafeMicrosoftTodoId(configured)) throw new Error('Microsoft To Do list ID is invalid or too large');
    return configured;
  }
  try {
    const accessToken = requireMicrosoftTodoAccessToken(config);
    const response = await microsoftTodoRequest(config, 'https://graph.microsoft.com/v1.0/me/todo/lists', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw await microsoftTodoResponseError(response, 'Microsoft To Do list lookup failed');
    const data = await response.json() as unknown;
    if (typeof data !== 'object' || data === null || !Array.isArray((data as { value?: unknown }).value)) {
      throw new Error('Microsoft To Do returned an invalid list response');
    }
    if ((data as { '@odata.nextLink'?: unknown })['@odata.nextLink'] !== undefined) {
      throw new Error('Microsoft To Do list lookup returned a partial paginated collection; configure an explicit list ID');
    }
    const rawLists = (data as { value: unknown[] }).value;
    if (rawLists.length > MICROSOFT_TODO_MAX_LISTS) throw new Error(`Microsoft To Do list response exceeded ${MICROSOFT_TODO_MAX_LISTS} lists`);
    if (utf8ByteLength(JSON.stringify(rawLists) ?? '') > MICROSOFT_TODO_MAX_LIST_METADATA_BYTES) {
      throw new Error(`Microsoft To Do list response exceeded ${MICROSOFT_TODO_MAX_LIST_METADATA_BYTES} bytes`);
    }
    const lists = rawLists.map((value) => {
      if (typeof value !== 'object' || value === null) throw new Error('Microsoft To Do returned an invalid list payload');
      const list = value as Record<string, unknown>;
      if (typeof list.id !== 'string' || !isSafeMicrosoftTodoId(list.id)
        || !microsoftFieldFits(list.displayName, MICROSOFT_TODO_MAX_LIST_NAME_BYTES)
        || !microsoftFieldFits(list.wellknownListName, MICROSOFT_TODO_MAX_LIST_NAME_BYTES)) {
        throw new Error('Microsoft To Do returned an invalid or oversized list payload');
      }
      return list as unknown as MicrosoftTodoList;
    });
    const defaultList = lists.find((list) => list.wellknownListName === 'defaultList') ?? lists[0];
    if (!defaultList?.id) throw new Error('No Microsoft To Do lists found');
    return defaultList.id;
  } catch (error) {
    throw microsoftTodoContextError('Microsoft To Do list resolution failed', error);
  }
}

export function microsoftTodoToTaskLine(task: MicrosoftTodoTask): string {
  if (!isSafeMicrosoftTodoId(task.id)) {
    throw new Error('Invalid Microsoft To Do payload: invalid task id');
  }
  const parts: string[] = [];

  parts.push(`- [${microsoftCheckboxFromStatus(task.status)}]`);
  parts.push(sanitizeUntrustedTaskText(task.title) || 'Untitled Microsoft To Do task');

  const dueDate = microsoftDueDate(task);
  if (dueDate) {
    const dueTime = microsoftDueTime(task);
    parts.push(`📅 ${dueDate}${dueTime ? ` ${dueTime}` : ''}`);
  }

  if (task.importance === 'high') parts.push('🎯 high');
  else if (task.importance === 'low') parts.push('🎯 low');

  const timeZone = sanitizeUntrustedInlineFieldValue(microsoftDueTimeZone(task));
  if (shouldPersistMicrosoftTodoTimeZone(timeZone)) parts.push(`[${MICROSOFT_TODO_TIMEZONE_FIELD}:: ${timeZone}]`);

  parts.push(`[id:: ms-todo:${task.id}]`);

  const line = parts.join(' ');
  const body = microsoftBodyContent(task.body);
  const commentLines = sanitizeUntrustedTaskTextLines(body);
  return commentLines.length > 0 ? `${line}${commentLines.map((comment) => `\n  - 💬 ${comment}`).join('')}` : line;
}

export function taskLineToMicrosoftTodo(taskLine: string, taskId?: string): MicrosoftTodoTask {
  const isCompleted = taskLineCompleted(taskLine);
  const checkbox = taskLineCheckbox(taskLine);
  const isInProgress = checkbox === '/';
  const isDeferred = checkbox === '>';
  const due = taskLineDueDateTime(taskLine);
  const dueTimeZone = microsoftTodoTimezoneFromTaskLine(taskLine);
  const priority = taskLinePriority(taskLine);

  const importance = priority
    ? { high: 'high' as const, medium: 'normal' as const, low: 'low' as const }[priority]
    : 'normal';

  let status: MicrosoftTodoTask['status'] = 'notStarted';
  if (isCompleted) status = 'completed';
  else if (isInProgress) status = 'inProgress';
  else if (isDeferred) status = 'deferred';

  return {
    id: taskId || taskLineServiceId(taskLine, 'ms-todo') || `task-${randomTaskId()}`,
    title: taskLineTitle(taskLine, /\s+[📅🎯]/u),
    dueDateTime: due.date
      ? { dateTime: `${due.date}T${due.time ? `${due.time}:00` : '00:00:00'}`, timeZone: dueTimeZone ?? 'UTC' }
      : undefined,
    importance,
    status,
    isReminderOn: false,
  };
}

function randomTaskId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function explicitMicrosoftTodoTaskId(task: { line: string; id?: string }): string | undefined {
  const firstLine = task.line.split(/\r?\n/u)[0] ?? task.line;
  const candidate = task.id?.trim() || taskLineServiceId(firstLine, 'ms-todo');
  return candidate?.replace(/^ms-todo:/u, '').trim() || undefined;
}

export async function fetchMicrosoftTodoTasks(config: MicrosoftTodoConfig): Promise<MicrosoftTodoTask[]> {
  try {
    const accessToken = requireMicrosoftTodoAccessToken(config);
    const listId = await resolveMicrosoftTodoListId(config);
    const allTasks: MicrosoftTodoTask[] = [];
    const seenTaskIds = new Set<string>();
    let snapshotBytes = 0;
    let nextUrl: string | undefined =
      `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks?$top=${MICROSOFT_TODO_PAGE_SIZE}`;

    const seenPageUrls = new Set<string>();
    do {
      config.assertCurrent?.();
      nextUrl = assertSafeMicrosoftTodoTaskPageUrl(nextUrl, listId);
      if (seenPageUrls.has(nextUrl) || seenPageUrls.size >= MICROSOFT_TODO_MAX_TASK_PAGES) {
        throw new Error('Microsoft To Do pagination did not terminate safely');
      }
      seenPageUrls.add(nextUrl);

      const response = await microsoftTodoRequest(config, nextUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) throw await microsoftTodoResponseError(response, response.status === 401 ? 'Microsoft To Do authentication expired' : 'Microsoft To Do API error');

      const data = await response.json() as { value?: unknown; '@odata.nextLink'?: unknown };
      if (!Array.isArray(data.value)) throw new Error('Microsoft To Do returned an invalid task page');
      if (data.value.length > MICROSOFT_TODO_PAGE_SIZE) throw new Error(`Microsoft To Do returned a task page exceeding ${MICROSOFT_TODO_PAGE_SIZE} tasks`);
      for (const [index, value] of data.value.entries()) {
        snapshotBytes = accumulateMicrosoftTodoSnapshotBudget(allTasks.length, snapshotBytes, value);
        const task = normalizeMicrosoftTodoTaskPayload(value, true);
        if (!task) throw new Error(`Microsoft To Do returned an invalid task at page item ${index + 1} (malformed or oversized)`);
        if (seenTaskIds.has(task.id)) throw new Error(`Microsoft To Do returned duplicate task id ${task.id}`);
        seenTaskIds.add(task.id);
        allTasks.push(task);
      }
      const rawNextUrl = data['@odata.nextLink'];
      if (rawNextUrl !== undefined && (typeof rawNextUrl !== 'string' || rawNextUrl.length === 0)) {
        throw new Error('Microsoft To Do returned an invalid next page URL');
      }
      nextUrl = rawNextUrl;
    } while (nextUrl);

    return allTasks;
  } catch (error) {
    throw microsoftTodoContextError('Microsoft To Do fetch failed', error);
  }
}

function microsoftPayloadBodyContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const content = (value as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

function graphTaskPayloadFromFields(fields: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (typeof fields.title === 'string') payload.title = fields.title;
  if (fields.body !== undefined) {
    payload.body = typeof fields.body === 'string'
      ? { content: fields.body, contentType: 'text' }
      : fields.body;
  }
  if (fields.dueDateTime !== undefined) payload.dueDateTime = fields.dueDateTime;
  if (fields.importance !== undefined) payload.importance = fields.importance;
  if (fields.isReminderOn !== undefined) payload.isReminderOn = fields.isReminderOn;
  if (fields.status !== undefined) payload.status = fields.status;
  return payload;
}

function graphTaskPayloadFromTask(task: MicrosoftTodoTask): Record<string, unknown> {
  return graphTaskPayloadFromFields({
    title: task.title,
    body: microsoftBodyContent(task.body) !== undefined ? { content: microsoftBodyContent(task.body) ?? '', contentType: 'text' } : undefined,
    dueDateTime: task.dueDateTime,
    importance: task.importance,
    isReminderOn: task.isReminderOn,
    status: task.status,
  });
}

async function microsoftTodoGraphRequest(
  config: MicrosoftTodoConfig,
  method: 'POST' | 'PATCH',
  taskId: string | undefined,
  payload: Record<string, unknown>,
): Promise<MicrosoftTodoTask> {
  try {
    const accessToken = requireMicrosoftTodoAccessToken(config);
    const listId = await resolveMicrosoftTodoListId(config);
    config.assertCurrent?.();
    const url = taskId
      ? `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`
      : `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks`;
    const response = await microsoftTodoRequest(config, url, {
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw await microsoftTodoResponseError(response, `Failed to ${method === 'POST' ? 'create' : 'update'} Microsoft To Do task`);
    if (response.status === 204) {
      return { id: taskId ?? '', title: String(payload.title as string | null | undefined ?? ''), isReminderOn: false };
    }
    const task = normalizeMicrosoftTodoTaskPayload(await response.json());
    if (!task) throw new Error('Microsoft To Do API response did not include a valid task id');
    return task;
  } catch (error) {
    throw microsoftTodoContextError('Microsoft To Do API request failed', error);
  }
}

export async function createMicrosoftTodoTask(
  payload: Record<string, unknown>,
  config: MicrosoftTodoConfig,
): Promise<MicrosoftTodoTask> {
  const graphPayload = graphTaskPayloadFromFields(payload);
  if (typeof graphPayload.title !== 'string' || graphPayload.title.trim().length === 0) {
    graphPayload.title = 'Untitled';
  }
  return microsoftTodoGraphRequest(config, 'POST', undefined, graphPayload);
}

export async function patchMicrosoftTodoTask(
  taskId: string,
  payload: Record<string, unknown>,
  config: MicrosoftTodoConfig,
): Promise<MicrosoftTodoTask> {
  return microsoftTodoGraphRequest(config, 'PATCH', taskId, graphTaskPayloadFromFields(payload));
}

export async function updateMicrosoftTodoTask(
  task: MicrosoftTodoTask,
  config: MicrosoftTodoConfig,
): Promise<MicrosoftTodoTask> {
  const isCreate = task.id.startsWith('task-');
  return microsoftTodoGraphRequest(config, isCreate ? 'POST' : 'PATCH', isCreate ? undefined : task.id, graphTaskPayloadFromTask(task));
}

export async function deleteMicrosoftTodoTask(taskId: string, config: MicrosoftTodoConfig): Promise<void> {
  const accessToken = requireMicrosoftTodoAccessToken(config);
  const listId = await resolveMicrosoftTodoListId(config);
  config.assertCurrent?.();
  const response = await microsoftTodoRequest(
    config,
    `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) throw await microsoftTodoResponseError(response, 'Failed to delete Microsoft To Do task');
}

export function resolveMicrosoftTodoConflict(
  vaultVersion: MicrosoftTodoTask,
  serviceVersion: MicrosoftTodoTask,
  strategy: 'vault-first' | 'service-first' = 'vault-first',
): MicrosoftTodoTask {
  return strategy === 'vault-first' ? vaultVersion : serviceVersion;
}

function microsoftTodoTasksEquivalent(vaultTask: MicrosoftTodoTask, serviceTask: MicrosoftTodoTask): boolean {
  const vaultDue = microsoftDueDateTime(vaultTask);
  const serviceDue = microsoftDueDateTime(serviceTask);
  const vaultImportance = vaultTask.importance ?? 'normal';
  const serviceImportance = serviceTask.importance ?? 'normal';
  const vaultStatus = vaultTask.status ?? 'notStarted';
  const serviceStatus = serviceTask.status ?? 'notStarted';
  const vaultBody = markdownInline(microsoftBodyContent(vaultTask.body) ?? '');
  const serviceBody = markdownInline(microsoftBodyContent(serviceTask.body) ?? '');
  const dueTimeZoneEquivalent = !vaultDue.date && !serviceDue.date
    ? true
    : microsoftTodoTimeZoneForComparison(microsoftDueTimeZone(vaultTask)) === microsoftTodoTimeZoneForComparison(microsoftDueTimeZone(serviceTask));

  return vaultTask.title === serviceTask.title
    && vaultDue.date === serviceDue.date
    && vaultDue.time === serviceDue.time
    && dueTimeZoneEquivalent
    && vaultImportance === serviceImportance
    && vaultStatus === serviceStatus
    && vaultBody === serviceBody
    && Boolean(vaultTask.isReminderOn) === Boolean(serviceTask.isReminderOn);
}

export async function syncVaultToMicrosoftTodo(
  tasks: Array<{ line: string; id?: string }>,
  config: MicrosoftTodoConfig,
  onProgress?: (status: string) => void,
): Promise<number> {
  onProgress?.('Syncing to Microsoft To Do...');

  let updated = 0;
  for (const task of tasks) {
    if (task.line.includes('[exclude_from_sync:: true]') || task.line.includes('[sync:: false]')) {
      continue;
    }
    const todoTask = taskLineToMicrosoftTodo(task.line, task.id);
    try {
      await updateMicrosoftTodoTask(todoTask, config);
      updated++;
    } catch (err) {
      console.error('Failed to sync task to Microsoft To Do:', err);
    }
  }

  onProgress?.(`Synced ${updated} tasks to Microsoft To Do`);
  return updated;
}

export async function syncMicrosoftTodoToVault(
  config: MicrosoftTodoConfig,
  onProgress?: (status: string) => void,
): Promise<MicrosoftTodoTask[]> {
  onProgress?.('Fetching from Microsoft To Do...');

  const tasks = await fetchMicrosoftTodoTasks(config);

  onProgress?.(`Fetched ${tasks.length} tasks from Microsoft To Do`);
  return tasks;
}

export async function bidirectionalSyncMicrosoftTodo(
  vaultTasks: Array<{ line: string; id?: string }>,
  config: MicrosoftTodoConfig,
  strategy: 'vault-first' | 'service-first',
  onProgress?: (status: string) => void,
): Promise<{ created: number; updated: number; deleted: number; conflicts: number }> {
  onProgress?.('Starting bidirectional sync with Microsoft To Do...');

  const todoTasks = await fetchMicrosoftTodoTasks(config);
  const explicitVaultTodoIds = new Set(vaultTasks.map(explicitMicrosoftTodoTaskId).filter((id): id is string => Boolean(id)));
  const vaultTodoTasks = vaultTasks.map((t) => taskLineToMicrosoftTodo(t.line, t.id));

  const stats = { created: 0, updated: 0, deleted: 0, conflicts: 0 };

  for (const vaultTask of vaultTodoTasks) {
    const existing = todoTasks.find((t) => t.id === vaultTask.id);
    if (!existing) {
      try {
        await updateMicrosoftTodoTask(vaultTask, config);
        stats.created++;
      } catch (err) {
        console.error('Failed to create task:', err);
      }
    } else if (!microsoftTodoTasksEquivalent(vaultTask, existing)) {
      stats.conflicts++;
      if (strategy === 'service-first') {
        // No vault writer is available in this low-level helper; retain the
        // conflict rather than redundantly writing the service copy remotely.
        continue;
      }
      try {
        await updateMicrosoftTodoTask(vaultTask, config);
        stats.updated++;
      } catch (err) {
        console.error('Failed to update task:', err);
      }
    }
  }

  if (config.deleteMissingRemote === true) {
    const missing = todoTasks.filter((task) => !explicitVaultTodoIds.has(task.id));
    const ratio = todoTasks.length === 0 ? 0 : missing.length / todoTasks.length;
    const maxRatio = Math.max(0, Math.min(1, (config.maxDeletePercentage ?? 25) / 100));
    if (config.localSnapshotComplete !== true) {
      console.warn('Microsoft To Do deleteMissingRemote skipped because the local snapshot was not certified complete.');
    } else if (explicitVaultTodoIds.size === 0 && todoTasks.length > 0) {
      console.warn('Microsoft To Do deleteMissingRemote skipped because no local Microsoft-linked tasks were provided.');
    } else if (ratio > maxRatio) {
      console.warn(`Microsoft To Do deleteMissingRemote skipped because ${missing.length}/${todoTasks.length} deletions exceed the safety threshold.`);
    } else {
      for (const todoTask of missing) {
        try {
          await deleteMicrosoftTodoTask(todoTask.id, config);
          stats.deleted++;
        } catch (err) {
          console.error('Failed to delete task:', err);
        }
      }
    }
  }

  onProgress?.(
    `Sync complete: ${stats.created} created, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.conflicts} conflicts`,
  );
  return stats;
}

export function microsoftTodoToMarkdownTaskPayload(task: MicrosoftTodoTask): Record<string, unknown> {
  return { ...task };
}

export class MicrosoftTodoAdapter implements SyncAdapter {
  constructor(private readonly config: MicrosoftTodoConfig) {}

  getCapabilities(): AdapterCapability {
    return {
      service: 'microsoft-todo',
      status: 'experimental',
      supports: { create: true, update: true, delete: true, reopen: true },
      fields: {
        title: 'native',
        description: 'native',
        due: 'native',
        priority: 'native',
        status: 'native',
        tags: 'unsupported',
      },
      notes: 'Experimental Microsoft Graph adapter using a user-pasted OAuth access token; no localhost OAuth callback is started.',
    };
  }

  isConfigured(): Promise<boolean> {
    return Promise.resolve(Boolean(this.config.accessToken?.trim()));
  }

  toServicePayload(task: MarkdownTask, fields?: string[]): Record<string, unknown> {
    const taskLine = task.rawLine || `- [${task.checkbox}] ${task.body}`;
    const todo = taskLineToMicrosoftTodo(taskLine, task.metadata.id?.replace(/^ms-todo:/u, ''));
    const dueTimeZone = todo.dueDateTime?.timeZone ?? microsoftTodoTimezoneFromTaskLine(task.body);
    todo.title = microsoftTaskTitle(task);
    todo.dueDateTime = task.metadata.dates.due
      ? {
          dateTime: `${task.metadata.dates.due}T${task.metadata.dates.dueTime ? `${normalizeMicrosoftTodoTime(task.metadata.dates.dueTime) ?? '00:00'}:00` : '00:00:00'}`,
          timeZone: dueTimeZone ?? 'UTC',
        }
      : undefined;
    const payload: Record<string, unknown> = {};
    if (!fields || fields.includes('title')) payload.title = todo.title;
    if (!fields || fields.includes('description')) {
      payload.body = { content: task.metadata.comments?.join('\n') ?? '', contentType: 'text' };
    }
    if (!fields || fields.includes('due')) payload.dueDateTime = todo.dueDateTime ?? null;
    if (!fields || fields.includes('priority')) payload.importance = todo.importance ?? 'normal';
    if (!fields || fields.includes('status')) {
      // Map vault statuses to Microsoft To Do Graph API values.
      // 'cancelled' has no direct Graph equivalent; it is intentionally left as
      // 'notStarted' so the task remains visible in To Do rather than being
      // silently re-opened or lost.
      const status = microsoftStatusFromVault(task);
      if (status) payload.status = status;
    }
    return payload;
  }

  fromServicePayload(payload: Record<string, unknown>, vaultPath: string): MarkdownTask {
    const task = normalizeMicrosoftTodoTaskPayload(payload);
    if (!task) throw new Error('Invalid Microsoft To Do payload: missing task id');
    const rawLine = microsoftTodoToTaskLine(task);
    const firstLine = rawLine.split(/\r?\n/u)[0] ?? rawLine;
    const body = firstLine.replace(/^- \[[^\]]+\]\s*/u, '');
    const comments = sanitizeUntrustedTaskTextLines(microsoftBodyContent(task.body));
    const key = explicitTaskKey(`ms-todo:${task.id}`);
    return {
      key,
      stableKey: key,
      filePath: vaultPath,
      lineNumber: 0,
      rawLine,
      linePrefix: '',
      indentation: '',
      listMarker: '-',
      checkbox: microsoftCheckboxFromStatus(task.status),
      body,
      normalizedText: normalizeTaskText(stripTaskMetadata(body)),
      status: task.status === 'completed' ? 'done' : task.status === 'inProgress' ? 'in_progress' : task.status === 'deferred' ? 'deferred' : 'todo',
      tags: [],
      contexts: [],
      metadata: {
        id: `ms-todo:${task.id}`,
        dates: { due: microsoftDueDate(task), dueTime: microsoftDueTime(task) },
        invalidDates: {},
        priority: task.importance === 'high' ? 'high' : task.importance === 'low' ? 'low' : 'normal',
        dependsOn: [],
        ...(comments.length > 0 ? { comments } : {}),
      },
    };
  }

  async create(payload: Record<string, unknown>, dryRun = false): Promise<{ externalId: string; hash: string }> {
    if (dryRun) return { externalId: `ms-todo-mock-${Date.now()}`, hash: JSON.stringify(payload) };
    const created = await createMicrosoftTodoTask(payload, this.config);
    return { externalId: created.id, hash: JSON.stringify(created) };
  }

  async update(externalId: string, payload: Record<string, unknown>, dryRun = false): Promise<{ hash: string; conflicts?: FieldConflict[]; projection?: SupportedFieldProjection; remoteVersion?: string }> {
    if (dryRun) return { hash: JSON.stringify(payload) };
    const updated = await patchMicrosoftTodoTask(externalId, payload, this.config);
    const returnedProjection = microsoftTodoProjectionFromRemoteTask(updated);
    const requestedProjection = canonicalProjection({
      ...(Object.prototype.hasOwnProperty.call(payload, 'title') ? { title: payload.title } : {}),
      ...(Object.prototype.hasOwnProperty.call(payload, 'body') ? { description: microsoftPayloadBodyContent(payload.body) } : {}),
      ...(Object.prototype.hasOwnProperty.call(payload, 'dueDateTime') ? { due: payload.dueDateTime === null ? null : microsoftTodoProjectionFromRemoteTask({ id: externalId, title: '', isReminderOn: false, dueDateTime: payload.dueDateTime as MicrosoftTodoTask['dueDateTime'] }).due } : {}),
      ...(Object.prototype.hasOwnProperty.call(payload, 'importance') ? { priority: payload.importance } : {}),
      ...(Object.prototype.hasOwnProperty.call(payload, 'status') ? { status: payload.status } : {}),
    });
    if (!requestedProjection) throw new Error('Microsoft To Do update payload was not canonical');
    const returnedChangedFields = canonicalProjectionOrThrow(Object.fromEntries(Object.keys(requestedProjection).map((field) => [field, returnedProjection[field]])));
    if (!projectionsEqual(requestedProjection, returnedChangedFields)) {
      throw new Error('Microsoft To Do post-write verification failed; returned projection differs from requested fields');
    }
    return { hash: JSON.stringify(returnedProjection), projection: returnedProjection, remoteVersion: microsoftTodoRemoteVersion(updated) };
  }

  async delete(externalId: string, dryRun = false): Promise<void> {
    if (dryRun) return;
    await deleteMicrosoftTodoTask(externalId, this.config);
  }

  async reopen(externalId: string, dryRun = false): Promise<void> {
    this.config.assertCurrent?.();
    await this.update(externalId, { status: 'notStarted' }, dryRun);
    this.config.assertCurrent?.();
  }

  async fetchAll(): Promise<Array<{ externalId: string; payload: Record<string, unknown>; hash: string }>> {
    const tasks = await fetchMicrosoftTodoTasks(this.config);
    return tasks.map((task) => ({ externalId: task.id, payload: microsoftTodoToMarkdownTaskPayload(task), hash: JSON.stringify(task) }));
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await resolveMicrosoftTodoListId(this.config);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
