import { ProviderHttpError, requestResponse as boundedRequest, retryAfterMilliseconds } from './network-request';
/**
 * Google Tasks OAuth sync safe subset.
 *
 * This module intentionally supports bearer-token/manual OAuth configuration only;
 * the plugin does not run a localhost OAuth callback server. All network methods
 * can be dry-run or fetch-mocked in tests.
 */

import type { AdapterCapability, FieldConflict, SyncAdapter } from './sync-contract';
import type { MarkdownTask } from './task-model';
import { normalizeTaskText, stripTaskMetadata } from './task-model';
import { explicitTaskKey } from './task-identity';
import { buildPkceAuthorizationUrl, exchangeAuthorizationCodeForToken, parseOAuthCode, refreshOAuthAccessToken, type OAuthPkceStart, type OAuthTokenResponse } from './oauth-pkce';
import { sanitizeUntrustedTaskText, sanitizeUntrustedTaskTextLines } from './untrusted-task-text';
import { utf8ByteLength } from './input-budgets';
import { isProviderRunCancellation } from './provider-sync-safety';
import { canonicalProjection, canonicalProjectionOrThrow, projectionsEqual, reconcileSupportedProjections, type ProjectionReconciliation, type SupportedFieldProjection } from './sync-reconciliation';

export interface GoogleTasksConfig {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  apiKey?: string;
  listId?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  status?: 'needsAction' | 'completed';
  due?: string;
  updated?: string;
  etag?: string;
  completed?: string;
}

const GOOGLE_TASKS_PAGE_SIZE = 100;
const GOOGLE_TASKS_MAX_PAGES = 200;
const GOOGLE_TASKS_MAX_SNAPSHOT_TASKS = 20_000;
const GOOGLE_TASKS_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const GOOGLE_TASKS_MAX_PAGE_TOKEN_BYTES = 4 * 1024;
const GOOGLE_TASKS_MAX_ID_BYTES = 4 * 1024;
const GOOGLE_TASKS_MAX_TITLE_BYTES = 4 * 1024;
const GOOGLE_TASKS_MAX_NOTES_BYTES = 32 * 1024;
const GOOGLE_TASKS_MAX_DATE_BYTES = 128;
const GOOGLE_TASKS_MAX_VERSION_BYTES = 4 * 1024;
const GOOGLE_TASKS_MAX_LIST_ID_BYTES = 4 * 1024;

export function accumulateGoogleTasksSnapshotBudget(
  taskCount: number,
  byteCount: number,
  item: unknown,
  limits: { maxTasks: number; maxBytes: number } = { maxTasks: GOOGLE_TASKS_MAX_SNAPSHOT_TASKS, maxBytes: GOOGLE_TASKS_MAX_SNAPSHOT_BYTES },
): number {
  if (taskCount >= limits.maxTasks) throw new Error(`Invalid Google Tasks response: exceeded ${limits.maxTasks} tasks`);
  const nextBytes = byteCount + utf8ByteLength(JSON.stringify(item) ?? '');
  if (nextBytes > limits.maxBytes) throw new Error(`Invalid Google Tasks response: exceeded ${limits.maxBytes} aggregate bytes`);
  return nextBytes;
}

export function googleTasksAuthHeader(config: GoogleTasksConfig): Record<string, string> {
  const accessToken = config.accessToken?.trim();
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

async function googleTasksRequest(config: GoogleTasksConfig, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  config.assertCurrent?.();
  const response = await boundedRequest(
    input,
    { ...init, signal: config.signal },
    { signal: config.signal, redirect: 'error' },
  );
  config.assertCurrent?.();
  return response;
}

export function hasGoogleTasksCredentials(config: GoogleTasksConfig): boolean {
  return Boolean(config.accessToken?.trim() || config.apiKey?.trim());
}

export function hasGoogleTasksMutationCredentials(config: GoogleTasksConfig): boolean {
  return Boolean(config.accessToken?.trim());
}

export function assertGoogleTasksCredentials(config: GoogleTasksConfig): void {
  if (!hasGoogleTasksCredentials(config)) {
    throw new Error('Not authenticated with Google Tasks');
  }
}

export function assertGoogleTasksMutationCredentials(config: GoogleTasksConfig): void {
  if (!hasGoogleTasksMutationCredentials(config)) {
    throw new Error('Google Tasks write operations require an OAuth access token');
  }
}

export function googleTasksListId(config: GoogleTasksConfig): string {
  return config.listId?.trim() || '@default';
}

function googleTasksErrorDetailFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as {
    error?: unknown;
    error_description?: unknown;
    message?: unknown;
  };

  if (record.error && typeof record.error === 'object') {
    const nested = record.error as { message?: unknown; status?: unknown; code?: unknown };
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim();
    if (typeof nested.status === 'string' && nested.status.trim()) return nested.status.trim();
    if (typeof nested.code === 'string' && nested.code.trim()) return nested.code.trim();
  }

  if (typeof record.error === 'string' && typeof record.error_description === 'string') {
    return `${record.error}: ${record.error_description}`;
  }
  if (typeof record.error_description === 'string' && record.error_description.trim()) return record.error_description.trim();
  if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  return undefined;
}

function googleTasksContextError(prefix: string, error: unknown): Error {
  if (isProviderRunCancellation(error)) return error instanceof Error ? error : new Error(String(error));
  return error instanceof ProviderHttpError
    ? new ProviderHttpError(`${prefix}: ${error.message}`, error.statusCode, error.retryAfterMs)
    : new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}

async function throwGoogleTasksApiError(response: Response, prefix: string): Promise<never> {
  let detail = '';
  try {
    const text = (await response.text()).trim();
    if (text) {
      try {
        detail = googleTasksErrorDetailFromPayload(JSON.parse(text)) ?? '';
      } catch {
        detail = '';
      }
    }
  } catch {
    detail = '';
  }

  const statusText = response.statusText?.trim() ?? '';
  const suffix = (detail || statusText).slice(0, 512);
  throw new ProviderHttpError(`${prefix}: ${response.status}${suffix ? ` - ${suffix}` : ''}`, response.status, retryAfterMilliseconds(response));
}

function requireGoogleTasksEtag(value: string | undefined): string {
  if (!value || value.length > GOOGLE_TASKS_MAX_VERSION_BYTES || !/^"[\x21\x23-\x7e]+"$/u.test(value)) {
    throw new Error('Google Tasks mutation requires the strong ETag from a fresh remote snapshot');
  }
  return value;
}

function googleTaskDate(value: string | undefined): string | undefined {
  const date = value?.slice(0, 10);
  return date && isValidGoogleTaskDate(date) ? date : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeGoogleTaskId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

function assertGoogleTaskFieldBytes(field: string, value: unknown, maximum: number): void {
  if (typeof value === 'string' && utf8ByteLength(value) > maximum) {
    throw new Error(`Invalid Google Tasks payload: ${field} exceeded ${maximum} bytes`);
  }
}

function validateGoogleTaskPayload(payload: unknown): GoogleTask {
  if (!isRecord(payload)) {
    throw new Error('Invalid Google Tasks payload: expected an object');
  }

  if (typeof payload.id !== 'string' || !payload.id.trim()) {
    throw new Error('Invalid Google Tasks payload: missing task id');
  }
  if (!isSafeGoogleTaskId(payload.id)) {
    throw new Error('Invalid Google Tasks payload: invalid task id');
  }
  if (typeof payload.title !== 'string') {
    throw new Error('Invalid Google Tasks payload: missing task title');
  }
  assertGoogleTaskFieldBytes('task id', payload.id, GOOGLE_TASKS_MAX_ID_BYTES);
  assertGoogleTaskFieldBytes('title', payload.title, GOOGLE_TASKS_MAX_TITLE_BYTES);
  assertGoogleTaskFieldBytes('notes', payload.notes, GOOGLE_TASKS_MAX_NOTES_BYTES);
  for (const field of ['due', 'updated', 'completed'] as const) assertGoogleTaskFieldBytes(field, payload[field], GOOGLE_TASKS_MAX_DATE_BYTES);
  assertGoogleTaskFieldBytes('etag', payload.etag, GOOGLE_TASKS_MAX_VERSION_BYTES);
  if (payload.status !== undefined && payload.status !== 'needsAction' && payload.status !== 'completed') {
    throw new Error('Invalid Google Tasks payload: invalid task status');
  }
  for (const field of ['notes', 'due', 'updated', 'etag', 'completed'] as const) {
    if (payload[field] !== undefined && typeof payload[field] !== 'string') {
      throw new Error(`Invalid Google Tasks payload: ${field} must be a string`);
    }
  }

  return payload as unknown as GoogleTask;
}

function isValidGoogleTaskDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function cleanTitleFromTask(task: MarkdownTask): string {
  return normalizeTaskText(stripTaskMetadata(task.normalizedText || task.body))
    .replace(/(^|\s)#[^\s#]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || 'Untitled Google Task';
}

function googleTaskCommentLines(notes: string | undefined): string[] {
  return sanitizeUntrustedTaskTextLines(notes);
}

export function googleTaskToMarkdownLine(task: GoogleTask): string {
  if (!isSafeGoogleTaskId(task.id)) {
    throw new Error('Invalid Google Tasks payload: invalid task id');
  }
  const title = sanitizeUntrustedTaskText(task.title) || 'Untitled Google Task';
  const checkbox = task.status === 'completed' ? 'x' : ' ';
  const due = googleTaskDate(task.due);
  const comments = googleTaskCommentLines(task.notes);
  const line = `- [${checkbox}] ${title}${due ? ` 📅 ${due}` : ''} [id:: google-tasks:${task.id}]`;
  return comments.length > 0 ? `${line}${comments.map((comment) => `\n  - 💬 ${comment}`).join('')}` : line;
}

function googleStatusFromVault(task: MarkdownTask): GoogleTask['status'] | undefined {
  if (task.status === 'done') return 'completed';
  if (task.status === 'todo') return 'needsAction';
  return undefined;
}

export function googleTasksProjectionFromVaultTask(task: MarkdownTask): SupportedFieldProjection {
  return canonicalProjectionOrThrow({
    title: cleanTitleFromTask(task),
    description: task.metadata.comments?.join('\n') ?? '',
    due: task.metadata.dates.due ?? null,
    status: googleStatusFromVault(task) ?? `unsupported:${task.status}`,
  });
}

export function googleTasksProjectionFromRemoteTask(task: GoogleTask): SupportedFieldProjection {
  return canonicalProjectionOrThrow({
    title: normalizeTaskText(task.title) || 'Untitled Google Task',
    description: (task.notes ?? '').replace(/\r\n?/gu, '\n'),
    due: googleTaskDate(task.due) ?? null,
    status: task.status ?? 'needsAction',
  });
}

export function googleTasksRemoteVersion(task: GoogleTask): string | undefined {
  return task.etag ?? task.updated;
}

export function reconcileGoogleTask(
  local: MarkdownTask,
  remote: GoogleTask | undefined,
  baseline?: unknown,
): ProjectionReconciliation {
  const result = reconcileSupportedProjections({
    service: 'google-tasks',
    local: googleTasksProjectionFromVaultTask(local),
    remote: remote ? googleTasksProjectionFromRemoteTask(remote) : undefined,
    baseline,
    remoteVersion: remote ? googleTasksRemoteVersion(remote) : undefined,
  });
  const unsupported = result.fields.filter((field) => field.field === 'status' && typeof field.localValue === 'string' && field.localValue.startsWith('unsupported:'));
  if (unsupported.length === 0) return result;
  return {
    ...result,
    mode: 'conflict', outbound: {}, inbound: {}, nextBaseline: undefined,
    fields: result.fields.map((field) => field.field === 'status' ? { ...field, decision: 'conflict', reason: 'divergent-dual-change' } : field),
    conflicts: unsupported.map((field) => ({ field: field.field, vaultValue: field.localValue, serviceValue: field.remoteValue, service: 'google-tasks', detectedAt: result.evidence.capturedAt })),
    evidence: { ...result.evidence, mode: 'conflict' },
  };
}

export function googleTasksPayloadFromProjection(projection: SupportedFieldProjection): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if ('title' in projection) payload.title = projection.title;
  if ('description' in projection) payload.notes = projection.description;
  if ('due' in projection) payload.due = typeof projection.due === 'string' ? `${projection.due}T00:00:00.000Z` : null;
  if ('status' in projection) payload.status = projection.status;
  return payload;
}

export function markdownTaskToGoogleTask(task: MarkdownTask): Omit<GoogleTask, 'id'> & { id?: string } {
  if (task.metadata.excludeFromSync) {
    return { title: '', status: 'needsAction' };
  }
  const id = task.metadata.id?.replace(/^google-tasks:/u, '').replace(/^gtasks-/u, '');
  return {
    ...(id ? { id } : {}),
    title: cleanTitleFromTask(task),
    notes: task.metadata.comments?.join('\n'),
    due: task.metadata.dates.due ? `${task.metadata.dates.due}T00:00:00.000Z` : undefined,
    status: googleStatusFromVault(task),
  };
}

export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
export const GOOGLE_TASKS_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TASKS_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_TASKS_DEFAULT_REDIRECT_URI = 'http://localhost:42813/oauth/google-tasks/callback';

export async function googleTasksPkceOAuthStart(
  clientId: string,
  options: { redirectUri?: string; state?: string; codeVerifier?: string } = {},
): Promise<OAuthPkceStart> {
  return buildPkceAuthorizationUrl({
    authorizationEndpoint: GOOGLE_TASKS_AUTH_ENDPOINT,
    clientId,
    redirectUri: options.redirectUri ?? GOOGLE_TASKS_DEFAULT_REDIRECT_URI,
    scope: GOOGLE_TASKS_SCOPE,
    state: options.state,
    codeVerifier: options.codeVerifier,
    extraParams: { access_type: 'offline', prompt: 'consent' },
  });
}

export async function exchangeGoogleTasksAuthorizationCode(options: {
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
    tokenEndpoint: GOOGLE_TASKS_TOKEN_ENDPOINT,
    clientId: options.clientId,
    code,
    codeVerifier: options.codeVerifier,
    redirectUri: options.redirectUri ?? GOOGLE_TASKS_DEFAULT_REDIRECT_URI,
    signal: options.signal,
  });
}

export async function refreshGoogleTasksAccessToken(options: {
  clientId: string;
  refreshToken: string;
  signal?: AbortSignal;
}): Promise<OAuthTokenResponse> {
  return refreshOAuthAccessToken({
    tokenEndpoint: GOOGLE_TASKS_TOKEN_ENDPOINT,
    clientId: options.clientId,
    refreshToken: options.refreshToken,
    scope: GOOGLE_TASKS_SCOPE,
    signal: options.signal,
  });
}

export async function fetchGoogleTasks(config: GoogleTasksConfig, options: { maxResults?: number } = {}): Promise<GoogleTask[]> {
  assertGoogleTasksCredentials(config);
  const listId = googleTasksListId(config);
  if (utf8ByteLength(listId) > GOOGLE_TASKS_MAX_LIST_ID_BYTES) throw new Error(`Invalid Google Tasks configuration: list id exceeded ${GOOGLE_TASKS_MAX_LIST_ID_BYTES} bytes`);
  const allTasks: GoogleTask[] = [];
  const seenTaskIds = new Set<string>();
  let snapshotBytes = 0;
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  let pageCount = 0;

  const requestedMax = options.maxResults;
  if (requestedMax !== undefined && (!Number.isFinite(requestedMax) || requestedMax <= 0)) {
    throw new Error('Invalid Google Tasks maxResults option');
  }
  const requestedPageSize = requestedMax === undefined
    ? GOOGLE_TASKS_PAGE_SIZE
    : Math.max(1, Math.min(GOOGLE_TASKS_PAGE_SIZE, Math.floor(requestedMax)));

  try {
    do {
      config.assertCurrent?.();
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) {
          throw new Error('Google Tasks pagination returned a repeated nextPageToken');
        }
        seenPageTokens.add(pageToken);
      }
      pageCount += 1;
      if (pageCount > GOOGLE_TASKS_MAX_PAGES) {
        throw new Error(`Google Tasks pagination exceeded ${GOOGLE_TASKS_MAX_PAGES} pages`);
      }
      const params = new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: String(requestedPageSize) });
      if (!config.accessToken?.trim() && config.apiKey?.trim()) params.set('key', config.apiKey.trim());
      if (pageToken) params.set('pageToken', pageToken);
      const response = await googleTasksRequest(config, `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?${params.toString()}`, {
        headers: googleTasksAuthHeader(config),
      });
      if (!response.ok) await throwGoogleTasksApiError(response, 'Google Tasks API error');
      const data = await response.json() as unknown;
      if (!isRecord(data)) {
        throw new Error('Invalid Google Tasks response: expected an object');
      }
      if (data.items !== undefined && !Array.isArray(data.items)) {
        throw new Error('Invalid Google Tasks response: items must be an array');
      }
      if (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string') {
        throw new Error('Invalid Google Tasks response: nextPageToken must be a string');
      }
      if (typeof data.nextPageToken === 'string' && (data.nextPageToken.length === 0 || utf8ByteLength(data.nextPageToken) > GOOGLE_TASKS_MAX_PAGE_TOKEN_BYTES)) {
        throw new Error(`Invalid Google Tasks response: nextPageToken exceeded ${GOOGLE_TASKS_MAX_PAGE_TOKEN_BYTES} bytes or was empty`);
      }
      const items = data.items === undefined ? [] : data.items;
      if (items.length > requestedPageSize) throw new Error(`Invalid Google Tasks response: page exceeded ${requestedPageSize} tasks`);
      for (const item of items) {
        snapshotBytes = accumulateGoogleTasksSnapshotBudget(allTasks.length, snapshotBytes, item);
        const task = validateGoogleTaskPayload(item);
        if (seenTaskIds.has(task.id)) throw new Error(`Invalid Google Tasks response: duplicate task id ${task.id}`);
        seenTaskIds.add(task.id);
        allTasks.push(task);
      }
      pageToken = data.nextPageToken;

      if (requestedMax && allTasks.length >= requestedMax) {
        return allTasks.slice(0, requestedMax);
      }
    } while (pageToken);

    return allTasks;
  } catch (error) {
    throw googleTasksContextError('Google Tasks fetch request failed', error);
  }
}

export class GoogleTasksAdapter implements SyncAdapter {
  constructor(private readonly config: GoogleTasksConfig) {}

  getCapabilities(): AdapterCapability {
    return {
      service: 'google-tasks',
      status: 'experimental',
      supports: { create: true, update: true, delete: true, reopen: true },
      fields: {
        title: 'native',
        description: 'native',
        due: 'native',
        status: 'native',
        priority: 'unsupported',
        tags: 'unsupported',
      },
      notes: 'Experimental bearer-token/manual OAuth adapter. Reads may use a legacy API key, but create/update/delete require an OAuth access token. No localhost OAuth callback is started by the plugin.',
    };
  }

  isConfigured(): Promise<boolean> {
    return Promise.resolve(hasGoogleTasksMutationCredentials(this.config));
  }

  toServicePayload(task: MarkdownTask, fields?: string[]): Record<string, unknown> {
    if (task.metadata.excludeFromSync) return {};
    const googleTask = markdownTaskToGoogleTask(task);
    const payload: Record<string, unknown> = {};
    if (!fields || fields.includes('title')) payload.title = googleTask.title;
    // Always include notes when the description field is part of the payload so
    // removing all vault comments clears stale Google Tasks notes on update.
    if (!fields || fields.includes('description')) payload.notes = googleTask.notes ?? '';
    if (!fields || fields.includes('due')) payload.due = googleTask.due ?? null;
    if ((!fields || fields.includes('status')) && googleTask.status) payload.status = googleTask.status;
    return payload;
  }

  fromServicePayload(payload: Record<string, unknown>, vaultPath: string): MarkdownTask {
    const task = validateGoogleTaskPayload(payload);
    const line = googleTaskToMarkdownLine(task);
    const firstLine = line.split(/\r?\n/u)[0] ?? line;
    const body = firstLine.replace(/^- \[[^\]]+\]\s*/u, '');
    const comments = googleTaskCommentLines(task.notes);
    const key = explicitTaskKey(`google-tasks:${task.id}`);
    return {
      key,
      stableKey: key,
      filePath: vaultPath,
      lineNumber: 0,
      rawLine: line,
      linePrefix: '',
      indentation: '',
      listMarker: '-',
      checkbox: task.status === 'completed' ? 'x' : ' ',
      body,
      normalizedText: normalizeTaskText(stripTaskMetadata(body)),
      status: task.status === 'completed' ? 'done' : 'todo',
      tags: [],
      contexts: [],
      metadata: { id: `google-tasks:${task.id}`, dates: { due: googleTaskDate(task.due) }, invalidDates: {}, priority: 'normal', dependsOn: [], ...(comments.length > 0 ? { comments } : {}) },
    };
  }

  async create(payload: Record<string, unknown>, dryRun = false): Promise<{ externalId: string; hash: string }> {
    if (dryRun || this.config.dryRun) return { externalId: `google-mock-${Date.now()}`, hash: JSON.stringify(payload) };
    assertGoogleTasksMutationCredentials(this.config);
    try {
      const response = await googleTasksRequest(this.config, `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(googleTasksListId(this.config))}/tasks`, {
        method: 'POST',
        headers: { ...googleTasksAuthHeader(this.config), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) await throwGoogleTasksApiError(response, 'Failed to create Google task');
      const created = validateGoogleTaskPayload(await response.json());
      const expected = canonicalProjection({
        ...googleTasksProjectionFromRemoteTask(created),
        ...Object.fromEntries(Object.entries(googleTasksProjectionFromRemoteTask(created)).filter(([field]) => field in googleTasksProjectionFromRemoteTask(created))),
      });
      if (!expected) throw new Error('Created Google task did not return a canonical projection');
      return { externalId: created.id, hash: JSON.stringify(expected) };
    } catch (error) {
      throw googleTasksContextError('Google Tasks create request failed', error);
    }
  }

  async update(externalId: string, payload: Record<string, unknown>, dryRun = false, expectedVersion?: string): Promise<{ hash: string; conflicts?: FieldConflict[]; projection?: SupportedFieldProjection; remoteVersion?: string }> {
    if (dryRun || this.config.dryRun) return { hash: JSON.stringify(payload) };
    assertGoogleTasksMutationCredentials(this.config);
    try {
      const response = await googleTasksRequest(this.config, `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(googleTasksListId(this.config))}/tasks/${encodeURIComponent(externalId)}`, {
        method: 'PATCH',
        headers: { ...googleTasksAuthHeader(this.config), 'Content-Type': 'application/json', 'If-Match': requireGoogleTasksEtag(expectedVersion) },
        body: JSON.stringify(payload),
      });
      if (response.status === 412) throw new ProviderHttpError('Google task changed remotely; fetch and reconcile again before updating', 412);
      if (!response.ok) await throwGoogleTasksApiError(response, 'Failed to update Google task');
      const updated = validateGoogleTaskPayload(await response.json());
      const returnedProjection = googleTasksProjectionFromRemoteTask(updated);
      const expectedProjection = canonicalProjection({
        ...(Object.prototype.hasOwnProperty.call(payload, 'title') ? { title: payload.title } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'notes') ? { description: payload.notes } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'due') ? { due: typeof payload.due === 'string' ? googleTaskDate(payload.due) ?? null : null } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'status') ? { status: payload.status } : {}),
      });
      if (!expectedProjection) throw new Error('Google Tasks update payload was not canonical');
      const returnedChangedFields = canonicalProjectionOrThrow(Object.fromEntries(Object.keys(expectedProjection).map((field) => [field, returnedProjection[field]])));
      if (!projectionsEqual(expectedProjection, returnedChangedFields)) {
        throw new Error('Google Tasks post-write verification failed; returned projection differs from requested fields');
      }
      return { hash: JSON.stringify(returnedProjection), projection: returnedProjection, remoteVersion: googleTasksRemoteVersion(updated) };
    } catch (error) {
      throw googleTasksContextError('Google Tasks update request failed', error);
    }
  }

  async delete(externalId: string, dryRun = false, expectedVersion?: string): Promise<void> {
    if (dryRun || this.config.dryRun) return;
    assertGoogleTasksMutationCredentials(this.config);
    try {
      const response = await googleTasksRequest(this.config, `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(googleTasksListId(this.config))}/tasks/${encodeURIComponent(externalId)}`, {
        method: 'DELETE',
        headers: { ...googleTasksAuthHeader(this.config), 'If-Match': requireGoogleTasksEtag(expectedVersion) },
      });
      if (!response.ok) await throwGoogleTasksApiError(response, 'Failed to delete Google task');
    } catch (error) {
      throw googleTasksContextError('Google Tasks delete request failed', error);
    }
  }

  async reopen(externalId: string, dryRun = false, expectedVersion?: string): Promise<void> {
    this.config.assertCurrent?.();
    await this.update(externalId, { status: 'needsAction' }, dryRun, expectedVersion);
    this.config.assertCurrent?.();
  }

  async fetchAll(): Promise<Array<{ externalId: string; payload: Record<string, unknown>; hash: string }>> {
    const tasks = await fetchGoogleTasks(this.config);
    return tasks.map((task) => ({ externalId: task.id, payload: task as unknown as Record<string, unknown>, hash: JSON.stringify(task) }));
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await fetchGoogleTasks({ ...this.config, listId: googleTasksListId(this.config) }, { maxResults: 1 });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
