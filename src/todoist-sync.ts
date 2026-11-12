import { requestResponse as boundedRequest, retryAfterMilliseconds } from './network-request';
/**
 * Todoist Sync Adapter (Todoist API v1, using the shared sync contract)
 *
 * Implements SyncAdapter interface for unified sync behavior.
 * Supports create/update/delete/reopen with stable identity mapping and dry-run.
 */

import type { SyncAdapter, AdapterCapability, FieldConflict } from './sync-contract';
import type { MarkdownTask, TaskPriority } from './task-model';
import { isValidIsoDate } from './date-utils';
import { normalizeTaskText, stripTaskMetadata } from './task-model';
import { IdentityMapper } from './sync-identity-mapper';
import { explicitTaskKey } from './task-identity';
import { isProviderRunCancellation, SyncOperationQueue } from './sync-operations';
import { sanitizeUntrustedTag, sanitizeUntrustedTaskText, sanitizeUntrustedTaskTextLines } from './untrusted-task-text';
import { canonicalProjectionOrThrow, projectionsEqual, reconcileSupportedProjections, type ProjectionReconciliation, type SupportedFieldProjection } from './sync-reconciliation';

export interface TodoistConfig {
  apiKey: string;
  projectId?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

/**
 * Todoist task representation
 */
export interface TodoistTask {
  id: string;
  content: string;
  description?: string;
  due?: {
    date: string;
    datetime?: string;
    string?: string;
    timezone?: string | null;
    is_recurring?: boolean;
  } | null;
  priority: number; // 1-4 (4=high, 3=medium, 2=low, 1=none)
  parent_id?: string;
  section_id?: string;
  order?: number;
  labels?: string[];
  assigned_by_uid?: string;
  assignee_id?: string;
  completed_at?: string | null;
  added_at: string;
  updated_at: string;
  url?: string;
}

/**
 * Field support matrix for Todoist
 */
const TODOIST_FIELD_SUPPORT: Record<string, 'native' | 'mapped' | 'unsupported' | 'experimental'> = {
  title: 'native',
  description: 'native',
  due: 'native',
  priority: 'native',
  status: 'native',
  tags: 'native',
  assigned_to: 'unsupported',
  repeating: 'unsupported',
  subtask: 'unsupported',
  duration: 'unsupported',
  recurring_string: 'unsupported',
  custom_fields: 'unsupported'
};

/**
 * Maps Todoist priority numbers to the vault priority emoji + label rendered into a
 * task line. Keeping the emoji and the metadata label in a single source ensures an
 * imported task and the same task re-scanned from its markdown line hash identically.
 */
const TODOIST_PRIORITY_TO_VAULT: Record<number, { emoji: string; label: TaskPriority }> = {
  4: { emoji: ' 🔺', label: 'highest' },
  3: { emoji: ' ⏫', label: 'high' },
  2: { emoji: ' 🔼', label: 'medium' },
  1: { emoji: '', label: 'normal' },
};
const TODOIST_EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

function safeTodoistExternalId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && TODOIST_EXTERNAL_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function todoistExternalIdFromTask(task: MarkdownTask): string | undefined {
  const id = task.metadata.id?.trim();
  if (!id) return undefined;
  const colon = id.match(/^todoist:(.+)$/u);
  const dash = id.match(/^todoist-(.+)$/u);
  return safeTodoistExternalId(colon?.[1] ?? dash?.[1]);
}

export function todoistVaultKeyForExternalId(_filePath: string, externalId: string): string {
  return explicitTaskKey(`todoist:${externalId}`);
}

export function isTodoistManagedTask(task: MarkdownTask): boolean {
  return task.tags.some((tag) => tag.replace(/^#/u, '').toLowerCase() === 'todoist') || Boolean(todoistExternalIdFromTask(task));
}

export interface TodoistVaultOperationPlan {
  creates: number;
  updates: number;
  conflicts: number;
  skipped: number;
}

export interface TodoistImportMapping {
  vaultKey: string;
  externalId: string;
  baseline?: SupportedFieldProjection;
  remoteVersion?: string;
}

export interface TodoistImportPlan {
  lines: string[];
  mappings: TodoistImportMapping[];
}

export function planTodoistImports(
  serviceTasks: Array<{ externalId: string; payload: Record<string, unknown> }>,
  mapper: IdentityMapper,
  adapter: TodoistAdapter,
  inboxFilePath: string,
): TodoistImportPlan {
  const lines: string[] = [];
  const mappings: TodoistImportMapping[] = [];
  const plannedExternalIds = new Set<string>();
  for (const remote of serviceTasks) {
    if (plannedExternalIds.has(remote.externalId) || mapper.lookupByExternalId('todoist', remote.externalId)) continue;
    const task = adapter.fromServicePayload(remote.payload, inboxFilePath);
    const vaultKey = todoistVaultKeyForExternalId(inboxFilePath, remote.externalId);
    lines.push(task.rawLine);
    const localProjection = todoistProjectionFromVaultTask(task);
    const remoteProjection = todoistProjectionFromRemotePayload(remote.payload);
    mappings.push({
      vaultKey,
      externalId: remote.externalId,
      ...(projectionsEqual(localProjection, remoteProjection) ? { baseline: localProjection } : {}),
      remoteVersion: typeof remote.payload.updated_at === 'string' ? remote.payload.updated_at : undefined,
    });
    plannedExternalIds.add(remote.externalId);
  }
  return { lines, mappings };
}

export function applyTodoistImportMappings(mapper: IdentityMapper, mappings: readonly TodoistImportMapping[]): void {
  for (const mapping of mappings) {
    mapper.mapExternalId(mapping.vaultKey, 'todoist', mapping.externalId);
    if (mapping.baseline) mapper.recordBaseline(mapping.vaultKey, 'todoist', mapping.baseline, mapping.remoteVersion);
  }
}

export function bootstrapTodoistIdentityMappings(tasks: MarkdownTask[], mapper: IdentityMapper): number {
  let mapped = 0;
  for (const task of tasks) {
    const externalId = todoistExternalIdFromTask(task);
    if (!externalId) continue;
    if (mapper.getExternalId(task.key, 'todoist') !== externalId) {
      mapper.mapExternalId(task.key, 'todoist', externalId);
      mapped += 1;
    }
  }
  return mapped;
}

export function canonicalTodoistPayloadHashSource(task: MarkdownTask, adapter: TodoistAdapter): string {
  return JSON.stringify(adapter.toServicePayload(task));
}

export function todoistProjectionFromVaultTask(task: MarkdownTask): SupportedFieldProjection {
  return canonicalProjectionOrThrow({
    title: todoistContentFromTask(task),
    description: todoistDescriptionFromTask(task) ?? '',
    due: todoistDueStringFromTask(task),
    priority: Number(task.metadata.priority === 'highest' ? 4 : task.metadata.priority === 'high' ? 3 : task.metadata.priority === 'medium' ? 2 : 1),
    status: task.status === 'done' ? 'completed' : task.status === 'cancelled' ? 'cancelled' : 'active',
    tags: todoistLabelsFromTask(task).sort(),
  });
}

export function todoistProjectionFromRemotePayload(payload: Record<string, unknown>): SupportedFieldProjection {
  const task = validateTodoistTaskPayload(payload);
  const due = todoistDateMetadataFromDue(task.due);
  return canonicalProjectionOrThrow({
    title: normalizeTaskText(task.content) || 'Untitled',
    description: (task.description ?? '').replace(/\r\n?/gu, '\n'),
    due: due.due ? `${due.due}${due.dueTime ? ` ${due.dueTime}${due.dueTimezone ? ` ${due.dueTimezone}` : ''}` : ''}` : '',
    priority: task.priority,
    status: task.completed_at ? 'completed' : 'active',
    tags: [...new Set(task.labels ?? [])].sort(),
  });
}

export function reconcileTodoistTask(
  task: MarkdownTask,
  remote: { payload: Record<string, unknown> } | undefined,
  mapper: IdentityMapper,
): ProjectionReconciliation {
  const result = reconcileSupportedProjections({
    service: 'todoist',
    local: todoistProjectionFromVaultTask(task),
    remote: remote ? todoistProjectionFromRemotePayload(remote.payload) : undefined,
    baseline: mapper.getBaseline(task.key, 'todoist'),
    remoteVersion: remote && typeof remote.payload.updated_at === 'string' ? remote.payload.updated_at : undefined,
  });
  if (task.status !== 'cancelled' || result.mode === 'conflict') return result;
  const status = result.fields.find((field) => field.field === 'status');
  return {
    ...result,
    mode: 'conflict', outbound: {}, inbound: {}, nextBaseline: undefined,
    fields: result.fields.map((field) => field.field === 'status' ? { ...field, decision: 'conflict', reason: 'divergent-dual-change' } : field),
    conflicts: [{ field: 'status', vaultValue: 'cancelled', serviceValue: status?.remoteValue, service: 'todoist', detectedAt: result.evidence.capturedAt }],
    evidence: { ...result.evidence, mode: 'conflict' },
  };
}

function todoistLabelInline(value: string): string {
  return sanitizeUntrustedTag(value);
}

function stripHashTags(text: string): string {
  return text.replace(/(^|\s)#[^\s#]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function todoistContentFromTask(task: MarkdownTask): string {
  const normalized = normalizeTaskText(task.normalizedText || stripTaskMetadata(task.body));
  const withoutTags = stripHashTags(normalized);
  return withoutTags || normalized || task.body.trim();
}

function todoistDescriptionFromTask(task: MarkdownTask): string | undefined {
  const comments = task.metadata.comments?.map((comment) => comment.trim()).filter(Boolean) ?? [];
  return comments.length > 0 ? comments.join('\n') : undefined;
}

function todoistCommentLinesFromDescription(description: string | undefined): string[] {
  return sanitizeUntrustedTaskTextLines(description);
}

function todoistLabelsFromTask(task: MarkdownTask): string[] {
  return [...new Set(task.tags
    .map((tag) => tag.replace(/^#/u, '').trim())
    .filter((tag) => tag.length > 0 && tag.toLowerCase() !== 'todoist'))];
}

function todoistDueStringFromTask(task: MarkdownTask): string {
  const due = task.metadata.dates.due;
  if (!due) return '';
  const dueTime = task.metadata.dates.dueTime;
  if (task.metadata.dueTimezone) new Intl.DateTimeFormat('en', { timeZone: task.metadata.dueTimezone });
  return dueTime ? `${due} ${dueTime}${task.metadata.dueTimezone ? ` ${task.metadata.dueTimezone}` : ''}` : due;
}

function isValidTodoistDueTime(value: string): boolean {
  const match = value.match(/^(\d{1,2}):(\d{2})$/u);
  if (!match) return false;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60;
}

function todoistDateMetadataFromDue(due: TodoistTask['due']): { due?: string; dueTime?: string; dueTimezone?: string } {
  const value = due?.datetime ?? due?.date;
  if (!value) return {};
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/u);
  if (!match || !isValidIsoDate(match[1])) return {};
  if (!match[2] || !isValidTodoistDueTime(match[2])) return { due: match[1] };
  const dueTimezone = due?.timezone ?? (match[3] ? 'UTC' : undefined);
  if (dueTimezone) new Intl.DateTimeFormat('en', { timeZone: dueTimezone });
  if (match[3]) {
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) throw new Error('Invalid Todoist due timestamp');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: dueTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', numberingSystem: 'latn',
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? '';
    return { due: `${part('year')}-${part('month')}-${part('day')}`, dueTime: `${part('hour')}:${part('minute')}`, dueTimezone };
  }
  return { due: match[1], dueTime: match[2].padStart(5, '0'), ...(dueTimezone ? { dueTimezone } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTodoistTaskPayload(payload: unknown): TodoistTask {
  if (!isRecord(payload)) {
    throw new Error('Invalid Todoist task payload: expected an object');
  }

  if (typeof payload.id !== 'string' || !payload.id.trim()) {
    throw new Error('Invalid Todoist task payload: missing task id');
  }
  if (!TODOIST_EXTERNAL_ID_PATTERN.test(payload.id)) {
    throw new Error('Invalid Todoist task payload: invalid task id');
  }
  if (typeof payload.content !== 'string' || !payload.content.trim()) {
    throw new Error('Invalid Todoist task payload: missing task content');
  }
  if (payload.content.length > TODOIST_MAX_CONTENT_CHARS) throw new Error('Invalid Todoist task payload: task content is too large');
  if (payload.description !== undefined && (typeof payload.description !== 'string' || payload.description.length > TODOIST_MAX_DESCRIPTION_CHARS)) {
    throw new Error('Invalid Todoist task payload: invalid task description');
  }
  const priority = payload.priority;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 4) {
    throw new Error('Invalid Todoist task payload: invalid task priority');
  }

  if (payload.labels !== undefined && (!Array.isArray(payload.labels) || payload.labels.length > TODOIST_MAX_LABELS || !payload.labels.every((label) => typeof label === 'string' && label.length <= TODOIST_MAX_LABEL_CHARS))) {
    throw new Error('Invalid Todoist task payload: labels must be a bounded string list');
  }
  if (payload.due !== undefined && payload.due !== null) {
    if (!isRecord(payload.due)) {
      throw new Error('Invalid Todoist task payload: due must be an object');
    }
    if (payload.due.date !== undefined && (typeof payload.due.date !== 'string' || payload.due.date.length > TODOIST_MAX_DUE_FIELD_CHARS)) {
      throw new Error('Invalid Todoist task payload: due.date must be a bounded string');
    }
    if (payload.due.datetime !== undefined && (typeof payload.due.datetime !== 'string' || payload.due.datetime.length > TODOIST_MAX_DUE_FIELD_CHARS)) {
      throw new Error('Invalid Todoist task payload: due.datetime must be a bounded string');
    }
    if (payload.due.string !== undefined && (typeof payload.due.string !== 'string' || payload.due.string.length > TODOIST_MAX_DUE_FIELD_CHARS)) {
      throw new Error('Invalid Todoist task payload: due.string must be a bounded string');
    }
    if (payload.due.timezone !== undefined && payload.due.timezone !== null && (typeof payload.due.timezone !== 'string' || payload.due.timezone.length > 100 || !/^[A-Za-z0-9_+./-]+$/u.test(payload.due.timezone))) {
      throw new Error('Invalid Todoist task payload: due.timezone must be a bounded string');
    }
  }

  return payload as unknown as TodoistTask;
}

export function enqueueTodoistVaultOperations(
  tasks: MarkdownTask[],
  mapper: IdentityMapper,
  queue: SyncOperationQueue,
  adapter: TodoistAdapter,
  dryRun: boolean,
  serviceTasks: Array<{ externalId: string; payload: Record<string, unknown> }> = [],
): TodoistVaultOperationPlan {
  const plan: TodoistVaultOperationPlan = { creates: 0, updates: 0, conflicts: 0, skipped: 0 };
  const remoteById = new Map<string, (typeof serviceTasks)[number]>();
  for (const remote of serviceTasks) {
    if (remoteById.has(remote.externalId)) throw new Error(`Todoist returned duplicate remote ID ${remote.externalId}; no sync writes were planned`);
    remoteById.set(remote.externalId, remote);
  }
  for (const task of tasks) {
    if (task.metadata.excludeFromSync) {
      plan.skipped += 1;
      continue;
    }
    if (!isTodoistManagedTask(task)) {
      plan.skipped += 1;
      continue;
    }

    const explicitExternalId = todoistExternalIdFromTask(task);
    const externalId = mapper.getExternalId(task.key, 'todoist') ?? explicitExternalId;

    if (externalId) {
      if (!mapper.getExternalId(task.key, 'todoist')) {
        mapper.mapExternalId(task.key, 'todoist', externalId);
      }
      const reconciliation = reconcileTodoistTask(task, remoteById.get(externalId), mapper);
      queue.removeReconciliationOperations(task.key, 'todoist', externalId);
      if (reconciliation.mode === 'conflict') {
        if (!queue.hasOperationFor(task.key, 'todoist', ['update'], externalId)) {
          queue.enqueueReconciliationConflict(task, 'todoist', externalId, reconciliation.conflicts, reconciliation.evidence);
          plan.conflicts += 1;
        } else plan.skipped += 1;
        continue;
      }
      if (reconciliation.mode === 'establish-baseline' || reconciliation.mode === 'advance-baseline' || reconciliation.mode === 'unchanged') {
        if (!dryRun && reconciliation.nextBaseline) mapper.recordBaseline(task.key, 'todoist', reconciliation.nextBaseline, reconciliation.evidence.remoteVersion);
        plan.skipped += 1;
        continue;
      }
      // Todoist is deliberately local-authoritative. Remote-only changes are held,
      // never overwritten directionally, even though the generic reconciler can identify them.
      if (reconciliation.mode === 'inbound' || Object.keys(reconciliation.inbound).length > 0) {
        const conflicts = reconciliation.fields
          .filter((field) => field.decision === 'inbound')
          .map((field) => ({ field: field.field, vaultValue: field.localValue, serviceValue: field.remoteValue, service: 'todoist', detectedAt: reconciliation.evidence.capturedAt }));
        if (!queue.hasOperationFor(task.key, 'todoist', ['update'], externalId)) {
          queue.enqueueReconciliationConflict(task, 'todoist', externalId, conflicts, { ...reconciliation.evidence, mode: 'conflict' });
          plan.conflicts += 1;
        }
        continue;
      }
      const changedFields = Object.keys(reconciliation.outbound);
      if (changedFields.includes('status')) {
        const statusConflict = [{ field: 'status', vaultValue: reconciliation.evidence.local.status, serviceValue: reconciliation.evidence.remote?.status, service: 'todoist', detectedAt: reconciliation.evidence.capturedAt }];
        if (!queue.hasOperationFor(task.key, 'todoist', ['update'], externalId)) {
          queue.enqueueReconciliationConflict(task, 'todoist', externalId, statusConflict, { ...reconciliation.evidence, mode: 'conflict' });
          plan.conflicts += 1;
        }
        continue;
      }
      const changedPayload = adapter.toServicePayload(task, changedFields);
      if (changedFields.length > 0 && !queue.hasOperationFor(task.key, 'todoist', ['update'], externalId)) {
        queue.enqueueUpdate(task, 'todoist', externalId, changedPayload, changedFields, 'normal', dryRun, reconciliation.evidence);
        plan.updates += 1;
      } else plan.skipped += 1;
      continue;
    }

    if (task.status === 'done' || task.status === 'cancelled') {
      plan.skipped += 1;
      continue;
    }
    if (queue.hasOperationFor(task.key, 'todoist', ['create'])) {
      plan.skipped += 1;
      continue;
    }
    queue.enqueueCreate(task, 'todoist', adapter.toServicePayload(task), 'normal', dryRun);
    plan.creates += 1;
  }
  return plan;
}

const TODOIST_API_BASE = 'https://api.todoist.com/api/v1';
const TODOIST_PAGE_SIZE = 200;
const TODOIST_MAX_PAGES = 100;
const TODOIST_MAX_CURSOR_LENGTH = 4096;
const TODOIST_MAX_RETRY_AFTER_MS = 30_000;
const TODOIST_MAX_SNAPSHOT_TASKS = 20_000;
const TODOIST_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const TODOIST_MAX_CONTENT_CHARS = 65_536;
const TODOIST_MAX_DESCRIPTION_CHARS = 262_144;
const TODOIST_MAX_LABELS = 500;
const TODOIST_MAX_LABEL_CHARS = 1_024;
const TODOIST_MAX_DUE_FIELD_CHARS = 4_096;
const TODOIST_ERROR_TAG_PATTERN = /^[A-Z0-9_-]{1,64}$/u;

export function accumulateTodoistSnapshotBudget(
  taskCount: number,
  byteCount: number,
  item: unknown,
  limits: { maxTasks: number; maxBytes: number } = { maxTasks: TODOIST_MAX_SNAPSHOT_TASKS, maxBytes: TODOIST_MAX_SNAPSHOT_BYTES },
): number {
  if (taskCount >= limits.maxTasks) throw new Error(`Invalid Todoist tasks response: exceeded ${limits.maxTasks} tasks`);
  const itemBytes = new TextEncoder().encode(JSON.stringify(item) ?? '').byteLength;
  const nextBytes = byteCount + itemBytes;
  if (nextBytes > limits.maxBytes) throw new Error(`Invalid Todoist tasks response: exceeded ${limits.maxBytes} aggregate bytes`);
  return nextBytes;
}

export class TodoistApiError extends Error {
  readonly status: number;
  readonly statusCode: number;

  constructor(message: string, statusCode: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'TodoistApiError';
    this.status = statusCode;
    this.statusCode = statusCode;
  }
}

function todoistBodyRetryAfterMs(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const extra = value.error_extra;
  if (!isRecord(extra) || typeof extra.retry_after !== 'number' || !Number.isFinite(extra.retry_after)) return undefined;
  return Math.max(0, Math.min(TODOIST_MAX_RETRY_AFTER_MS, extra.retry_after * 1000));
}

async function todoistResponseError(response: Response, operation: string): Promise<TodoistApiError> {
  let tag = '';
  let bodyRetryAfterMs: number | undefined;
  try {
    const payload = await response.json() as unknown;
    if (isRecord(payload)) {
      tag = typeof payload.error_tag === 'string' && TODOIST_ERROR_TAG_PATTERN.test(payload.error_tag)
        ? payload.error_tag
        : '';
      bodyRetryAfterMs = todoistBodyRetryAfterMs(payload);
    }
  } catch {
    // Error bodies are optional and provider-controlled. Status is sufficient.
  }
  const retryAfterMs = retryAfterMilliseconds(response, TODOIST_MAX_RETRY_AFTER_MS) ?? bodyRetryAfterMs;
  return new TodoistApiError(
    `${operation} failed with HTTP ${response.status}${tag ? ` (${tag})` : ''}`,
    response.status,
    retryAfterMs,
  );
}

function contextualTodoistError(context: string, error: unknown): Error {
  if (isProviderRunCancellation(error)) return error instanceof Error ? error : new Error(String(error));
  if (error instanceof TodoistApiError) {
    return new TodoistApiError(`${context}: ${error.message}`, error.statusCode, error.retryAfterMs);
  }
  return new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

function todoistPageUrl(projectId: string | undefined, cursor?: string): string {
  const url = new URL(`${TODOIST_API_BASE}/tasks`);
  url.searchParams.set('limit', String(TODOIST_PAGE_SIZE));
  if (projectId) url.searchParams.set('project_id', projectId);
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

export class TodoistAdapter implements SyncAdapter {
  private config: TodoistConfig;
  private apiBase = TODOIST_API_BASE;

  constructor(config: TodoistConfig) {
    this.config = config;
  }

  private async request(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    this.config.assertCurrent?.();
    const response = await boundedRequest(
      input,
      { ...init, signal: this.config.signal },
      { signal: this.config.signal, redirect: 'error' },
    );
    this.config.assertCurrent?.();
    return response;
  }

  private apiKey(): string {
    return this.config.apiKey.trim();
  }

  private requireApiKey(): string {
    const apiKey = this.apiKey();
    if (!apiKey) throw new Error('Not authenticated with Todoist');
    return apiKey;
  }

  /**
   * Build HTTP headers for Todoist API requests
   */
  private getHeaders(includeContentType = false): Record<string, string> {
    const apiKey = this.requireApiKey();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    if (includeContentType) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  /**
   * Report Todoist capabilities
   */
  getCapabilities(): AdapterCapability {
    return {
      service: 'todoist',
      status: 'experimental',
      supports: {
        create: true,
        update: true,
        delete: true,
        reopen: true,
      },
      fields: TODOIST_FIELD_SUPPORT,
      notes: 'Title, description, due date/time, priority, status, and labels are managed. Assignment, recurrence, hierarchy, duration, and custom fields are not mapped.',
    };
  }

  /**
   * Check if configured and authenticated
   */
  async isConfigured(): Promise<boolean> {
    const apiKey = this.apiKey();
    if (!apiKey) return false;

    try {
      const response = await this.request(`${this.apiBase}/projects?limit=1`, {
        method: 'GET',
        headers: this.getHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Convert vault task to Todoist payload
   */
  toServicePayload(task: MarkdownTask, fields?: string[]): Record<string, unknown> {
    const payload: Record<string, unknown> = {};

    // Title (required). Use the scanner-equivalent normalized task text with
    // Markdown metadata/tags removed so hashes are stable before and after an
    // imported task is written to the vault and scanned back.
    if (!fields || fields.includes('title')) {
      payload.content = todoistContentFromTask(task);
    }

    // Description — always include so an empty value clears the Todoist description
    // when inline comments are removed from the vault task.
    if (!fields || fields.includes('description')) {
      const notes = todoistDescriptionFromTask(task);
      payload.description = notes ?? '';
    }

    // Due date
    if (!fields || fields.includes('due')) {
      payload.due_string = todoistDueStringFromTask(task);
    }

    // Priority (map emoji to Todoist priority 1-4)
    if (!fields || fields.includes('priority')) {
      const metadataPriorityMap: Record<string, number> = {
        highest: 4,
        high: 3,
        medium: 2,
        normal: 1,
        low: 1,
        lowest: 1,
      };
      const priorityMap: Record<string, number> = {
        '🔺': 4,
        '⏫': 3,
        '🔼': 2,
        '🔽': 1,
        '⏬': 1,
      };

      payload.priority = metadataPriorityMap[task.metadata.priority] ?? 1;
      for (const [emoji, level] of Object.entries(priorityMap)) {
        if (task.body.includes(emoji)) {
          payload.priority = level;
          break;
        }
      }
      if (!('priority' in payload)) payload.priority = 1;
    }

    // Status (completed). Include explicit false for open (non-cancelled) mapped
    // tasks so the normal update planning path can reach Todoist's /reopen
    // endpoint. Cancelled vault tasks must NOT emit is_completed: false — that
    // would incorrectly call /reopen and un-cancel the Todoist item.
    if (!fields || fields.includes('status')) {
      if (task.status === 'done') {
        payload.is_completed = true;
      } else if (task.status !== 'cancelled') {
        payload.is_completed = false;
      }
      // cancelled: do not touch is_completed in Todoist
    }

    // Labels (map tags). Always include the array for tag updates so removing
    // all vault tags clears stale Todoist labels instead of leaving them behind.
    if (!fields || fields.includes('tags')) {
      payload.labels = todoistLabelsFromTask(task);
    }

    return payload;
  }

  /**
   * Convert Todoist task to vault markdown
   */
  fromServicePayload(payload: Record<string, unknown>, vaultPath: string): MarkdownTask {
    const task = validateTodoistTaskPayload(payload);
    const { dueTimezone, ...dueMetadata } = todoistDateMetadataFromDue(task.due);
    const dueText = dueMetadata.due ? `${dueMetadata.due}${dueMetadata.dueTime ? ` ${dueMetadata.dueTime}` : ''}` : undefined;
    const content = sanitizeUntrustedTaskText(task.content) || 'Untitled';
    const labels = (task.labels ?? []).map(todoistLabelInline).filter(Boolean);

    // Build task line
    let line = task.completed_at ? '- [x] ' : '- [ ] ';
    line += content;

    // Priority. Render the emoji and set metadata.priority from the same source so
    // the imported task and the task re-scanned from this line produce identical
    // toServicePayload hashes — otherwise prioritised imports trigger a spurious
    // update push back to Todoist on the next sync.
    const priorityInfo = TODOIST_PRIORITY_TO_VAULT[task.priority] ?? TODOIST_PRIORITY_TO_VAULT[1];
    if (priorityInfo.emoji) {
      line += priorityInfo.emoji;
    }

    // Due date
    if (dueText) {
      line += ` 📅 ${dueText}`;
      if (dueTimezone) line += ` [dueTimezone:: ${dueTimezone}]`;
    }

    // Tags
    if (labels.length) {
      line += ` ${labels.map((label) => `#${label}`).join(' ')}`;
    }

    // External ID
    line += ` [id:: todoist:${task.id}]`;

    // Description as scanner-compatible comment bullets so imported notes round-trip
    // back to Todoist instead of being dropped on the next sync.
    const comments = todoistCommentLinesFromDescription(task.description);
    if (comments.length > 0) {
      line += comments.map((comment) => `\n  - 💬 ${comment}`).join('');
    }

    const normalizedText = normalizeTaskText([content, ...labels.map((label) => `#${label}`)].join(' '));

    // Create mock MarkdownTask
    const key = explicitTaskKey(`todoist:${task.id}`);
    return {
      key,
      stableKey: key,
      filePath: vaultPath,
      lineNumber: 0,
      rawLine: line,
      linePrefix: '',
      indentation: '',
      listMarker: '-',
      checkbox: task.completed_at ? 'x' : ' ',
      body: content,
      normalizedText,
      status: task.completed_at ? 'done' : 'todo',
      tags: labels,
      contexts: [],
      metadata: {
        id: `todoist:${task.id}`,
        dates: dueMetadata,
        ...(dueTimezone ? { dueTimezone } : {}),
        invalidDates: {},
        priority: priorityInfo.label,
        dependsOn: [],
        ...(comments.length > 0 ? { comments } : {}),
      },
    };
  }

  /**
   * Create task in Todoist
   */
  async create(payload: Record<string, unknown>, dryRun = false): Promise<{ externalId: string; hash: string }> {
    if (dryRun || this.config.dryRun) {
      return {
        externalId: `todo-mock-${Date.now()}`,
        hash: this.hashPayload(payload),
      };
    }

    const body: Record<string, unknown> = {
      content: payload.content || 'Untitled',
    };

    if (payload.description) body.description = payload.description;
    if ('due_string' in payload) body.due_string = payload.due_string;
    if (payload.priority) body.priority = payload.priority;
    if (payload.labels) body.labels = payload.labels;
    if (this.config.projectId) body.project_id = this.config.projectId;

    try {
      const response = await this.request(`${this.apiBase}/tasks`, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify(body),
      });

      if (!response.ok) throw await todoistResponseError(response, 'Create Todoist task');

      const created = validateTodoistTaskPayload(await response.json());
      return {
        externalId: created.id,
        hash: this.hashPayload(created as unknown as Record<string, unknown>),
      };
    } catch (error) {
      throw contextualTodoistError('Todoist create failed', error);
    }
  }

  /**
   * Update task in Todoist
   */
  async update(
    externalId: string,
    payload: Record<string, unknown>,
    dryRun = false,
  ): Promise<{ hash: string; conflicts?: FieldConflict[] }> {
    if (dryRun || this.config.dryRun) {
      return {
        hash: this.hashPayload(payload),
      };
    }

    const body: Record<string, unknown> = {};

    if ('content' in payload) {
      const content = typeof payload.content === 'string' ? payload.content.trim() : '';
      body.content = content || 'Untitled';
    }
    // Use 'in' check (not truthy) so description: '' is sent to Todoist when
    // inline comments are cleared, properly erasing the remote description.
    if ('description' in payload) body.description = payload.description;
    if ('due_string' in payload) body.due_string = payload.due_string;
    if ('priority' in payload) body.priority = payload.priority;
    if (payload.labels) body.labels = payload.labels;

    if (Object.keys(body).length > 0) {
      try {
        const response = await this.request(`${this.apiBase}/tasks/${encodeURIComponent(externalId)}`, {
          method: 'POST',
          headers: this.getHeaders(true),
          body: JSON.stringify(body),
        });

        if (!response.ok) throw await todoistResponseError(response, 'Update Todoist task');
      } catch (error) {
        throw contextualTodoistError('Todoist update failed', error);
      }
    }

    this.config.assertCurrent?.();
    if (payload.is_completed === true) {
      await this.close(externalId, false);
    } else if (payload.is_completed === false) {
      await this.reopen(externalId, false);
    }
    this.config.assertCurrent?.();

    return {
      hash: this.hashPayload(payload),
    };
  }

  /**
   * Delete task from Todoist
   */
  async delete(externalId: string, dryRun = false): Promise<void> {
    if (dryRun || this.config.dryRun) {
      return;
    }

    try {
      const response = await this.request(`${this.apiBase}/tasks/${encodeURIComponent(externalId)}`, {
        method: 'DELETE',
        headers: this.getHeaders(),
      });

      if (!response.ok) throw await todoistResponseError(response, 'Delete Todoist task');
    } catch (error) {
      throw contextualTodoistError('Todoist delete failed', error);
    }
  }

  /**
   * Complete task in Todoist using the close endpoint.
   */
  async close(externalId: string, dryRun = false): Promise<void> {
    if (dryRun || this.config.dryRun) {
      return;
    }

    try {
      const response = await this.request(`${this.apiBase}/tasks/${encodeURIComponent(externalId)}/close`, {
        method: 'POST',
        headers: this.getHeaders(),
      });

      if (!response.ok) throw await todoistResponseError(response, 'Close Todoist task');
    } catch (error) {
      throw contextualTodoistError('Todoist close failed', error);
    }
  }

  /**
   * Reopen (uncomplete) task in Todoist
   */
  async reopen(externalId: string, dryRun = false): Promise<void> {
    if (dryRun || this.config.dryRun) {
      return;
    }

    try {
      const response = await this.request(`${this.apiBase}/tasks/${encodeURIComponent(externalId)}/reopen`, {
        method: 'POST',
        headers: this.getHeaders(),
      });

      if (!response.ok) throw await todoistResponseError(response, 'Reopen Todoist task');
    } catch (error) {
      throw contextualTodoistError('Todoist reopen failed', error);
    }
  }

  /**
   * Fetch all tasks from Todoist
   */
  async fetchAll(): Promise<
    Array<{
      externalId: string;
      payload: Record<string, unknown>;
      hash: string;
    }>
  > {
    try {
      const tasks: TodoistTask[] = [];
      const taskIds = new Set<string>();
      const seenCursors = new Set<string>();
      let snapshotBytes = 0;
      let cursor: string | undefined;

      for (let page = 0; page < TODOIST_MAX_PAGES; page++) {
        this.config.assertCurrent?.();
        const response = await this.request(todoistPageUrl(this.config.projectId?.trim() || undefined, cursor), {
          headers: this.getHeaders(),
        });
        if (!response.ok) throw await todoistResponseError(response, 'Fetch Todoist tasks');

        const payload = await response.json() as unknown;
        if (!isRecord(payload) || !Array.isArray(payload.results) || !Object.prototype.hasOwnProperty.call(payload, 'next_cursor')) {
          throw new Error('Invalid Todoist tasks response: expected { results, next_cursor }');
        }
        if (payload.results.length > TODOIST_PAGE_SIZE) throw new Error(`Invalid Todoist tasks response: page exceeded ${TODOIST_PAGE_SIZE} tasks`);
        for (const item of payload.results) {
          snapshotBytes = accumulateTodoistSnapshotBudget(tasks.length, snapshotBytes, item);
          const task = validateTodoistTaskPayload(item);
          if (taskIds.has(task.id)) throw new Error(`Invalid Todoist tasks response: duplicate task id ${task.id}`);
          taskIds.add(task.id);
          tasks.push(task);
        }

        const nextCursor = payload.next_cursor;
        if (nextCursor === null) {
          return tasks.map((task) => ({
            externalId: task.id,
            payload: task as unknown as Record<string, unknown>,
            hash: this.hashPayload(task as unknown as Record<string, unknown>),
          }));
        }
        if (typeof nextCursor !== 'string' || nextCursor.length === 0 || nextCursor.length > TODOIST_MAX_CURSOR_LENGTH) {
          throw new Error('Invalid Todoist tasks response: malformed next_cursor');
        }
        if (seenCursors.has(nextCursor)) throw new Error('Invalid Todoist tasks response: repeated next_cursor');
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw new Error(`Invalid Todoist tasks response: exceeded ${TODOIST_MAX_PAGES} pages`);
    } catch (error) {
      throw contextualTodoistError('Todoist fetch failed', error);
    }
  }

  /**
   * Test connection to Todoist API
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.request(`${this.apiBase}/projects?limit=1`, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        const error = await todoistResponseError(response, 'Test Todoist connection');
        return { ok: false, error: error.message };
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Hash payload for conflict detection
   */
  private hashPayload(payload: Record<string, unknown>): string {
    const str = JSON.stringify(payload);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }
}
