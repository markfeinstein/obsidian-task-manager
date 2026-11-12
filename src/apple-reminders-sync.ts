import { isValidIsoDate } from './date-utils';
import { priorityLabelFromNumber, taskLineCompleted, taskLineDueDate, taskLinePriority, taskLineTitle } from './sync-task-line';
import { sanitizeUntrustedTaskText, sanitizeUntrustedTaskTextLines } from './untrusted-task-text';
import { APPLE_REMINDER_ID_MAX_BYTES, APPLE_REMINDER_NOTES_MAX_BYTES, APPLE_REMINDER_TITLE_MAX_BYTES, APPLE_REMINDERS_MAX_ITEMS, APPLE_REMINDERS_RENDERED_MAX_BYTES, utf8ByteLength } from './input-budgets';

export interface AppleRemindersConfig {
  listName: string;
  bidirectionalSync: boolean;
  syncOnChange: boolean;
  syncIntervalMinutes: number;
  vaultImportPath: string;
  lastSync?: number;
}

export interface AppleReminder {
  id: string;
  title: string;
  notes?: string;
  dueDate?: string;
  isCompleted: boolean;
  /** Apple Reminders priority: 0=none, 1=low, 2=medium, 3=high. */
  priority?: number;
  modifiedDate?: string;
}

export function appleReminderToTaskLine(reminder: AppleReminder): string {
  const parts: string[] = [];

  parts.push(reminder.isCompleted ? '- [x]' : '- [ ]');
  parts.push(sanitizeUntrustedTaskText(reminder.title) || 'Untitled reminder');

  if (reminder.dueDate) parts.push(`📅 ${reminder.dueDate}`);

  const priority = priorityLabelFromNumber(reminder.priority, { 1: 'low', 2: 'medium', 3: 'high' });
  if (priority) parts.push(`🎯 ${priority}`);

  parts.push(`[id:: apple-reminder:${reminder.id}]`);
  if (reminder.modifiedDate && !Number.isNaN(Date.parse(reminder.modifiedDate))) {
    parts.push(`[apple-modified:: ${new Date(reminder.modifiedDate).toISOString()}]`);
  }

  const line = parts.join(' ');
  // Split multi-line notes into separate 💬 comment bullets, matching the behavior
  // of the other provider adapters. Each line is sanitized before rendering
  // to prevent injection of fake task lines or task metadata, but multi-line
  // content is preserved as multiple comments so TaskScanner can parse them into
  // metadata.comments correctly.
  const commentLines = sanitizeUntrustedTaskTextLines(reminder.notes);
  return commentLines.length > 0 ? `${line}${commentLines.map((comment) => `\n  - 💬 ${comment}`).join('')}` : line;
}

export function taskLineToAppleReminder(taskLine: string, taskId?: string): AppleReminder {
  const priority = taskLinePriority(taskLine);

  return {
    id: taskId || `task-${Date.now()}`,
    title: taskLineTitle(taskLine, /\s+[📅🎯]/u),
    dueDate: taskLineDueDate(taskLine),
    isCompleted: taskLineCompleted(taskLine),
    priority: priority ? { high: 3, medium: 2, low: 1 }[priority] : 0,
  };
}

export const APPLE_REMINDERS_NATIVE_UNSUPPORTED = 'Native Apple Reminders bridge is not available';

export function fetchAppleReminders(config: AppleRemindersConfig): Promise<AppleReminder[]> {
  void config;
  console.warn(`Task Manager: ${APPLE_REMINDERS_NATIVE_UNSUPPORTED}. Use the Shortcuts/webhook import bridge or install/configure a native bridge.`);
  return Promise.resolve([]);
}

export function updateAppleReminder(
  reminder: AppleReminder,
  config: AppleRemindersConfig,
): Promise<void> {
  void reminder;
  void config;
  return Promise.reject(new Error(APPLE_REMINDERS_NATIVE_UNSUPPORTED));
}

export function deleteAppleReminder(reminderId: string, config: AppleRemindersConfig): Promise<void> {
  void reminderId;
  void config;
  return Promise.reject(new Error(APPLE_REMINDERS_NATIVE_UNSUPPORTED));
}

export function resolveAppleRemindersConflict(
  vaultVersion: AppleReminder,
  appleVersion: AppleReminder,
  strategy: 'vault-first' | 'service-first',
): AppleReminder {
  return strategy === 'vault-first' ? vaultVersion : appleVersion;
}

export function syncVaultToAppleReminders(
  tasks: Array<{ line: string; id?: string }>,
  config: AppleRemindersConfig,
  onProgress?: (status: string) => void,
): Promise<number> {
  void tasks;
  void config;
  onProgress?.(`${APPLE_REMINDERS_NATIVE_UNSUPPORTED}; no remote changes were written.`);
  return Promise.resolve(0);
}

export async function syncAppleRemindersToVault(
  config: AppleRemindersConfig,
  onProgress?: (status: string) => void,
): Promise<AppleReminder[]> {
  onProgress?.('Fetching from Apple Reminders requires a native EventKit/Shortcuts bridge.');

  const reminders = await fetchAppleReminders(config);

  onProgress?.(`Fetched ${reminders.length} reminders from Apple Reminders`);
  return reminders;
}

export function bidirectionalSyncAppleReminders(
  vaultTasks: Array<{ line: string; id?: string }>,
  config: AppleRemindersConfig,
  strategy: 'vault-first' | 'service-first',
  onProgress?: (status: string) => void,
): Promise<{ created: number; updated: number; deleted: number; conflicts: number }> {
  void vaultTasks;
  void config;
  void strategy;
  const stats = { created: 0, updated: 0, deleted: 0, conflicts: 0 };
  onProgress?.(`${APPLE_REMINDERS_NATIVE_UNSUPPORTED}; bidirectional native sync was not run.`);
  console.warn(`[Sync Skipped] Apple Reminders: ${APPLE_REMINDERS_NATIVE_UNSUPPORTED}`);
  return Promise.resolve(stats);
}

export function scheduleAppleReminderSync(
  config: AppleRemindersConfig,
  onSync: () => Promise<void>,
): ReturnType<typeof setInterval> | null {
  if (config.syncIntervalMinutes <= 0) return null;

  return setInterval(
    () => {
      void onSync();
    },
    config.syncIntervalMinutes * 60 * 1000,
  );
}

export interface AppleRemindersWebhookOptions {
  enabled: boolean;
  secret?: string;
  inboxPath?: string;
  dryRun?: boolean;
}

export const APPLE_REMINDERS_WEBHOOK_PROTOCOL = 'task-manager.apple-reminders.webhook.v1';

export interface AppleRemindersWebhookPayload {
  protocol?: string;
  secret?: string;
  listName?: string;
  reminders?: AppleReminder[];
  items?: AppleReminder[];
}

export interface AppleRemindersWebhookResult {
  accepted: boolean;
  reason?: 'disabled' | 'invalid-secret' | 'invalid-payload' | 'resource-limit';
  reminders: AppleReminder[];
  lines: string[];
}

export interface AppleRemindersImportPlan extends AppleRemindersWebhookResult {
  newLines: string[];
  skippedDuplicateIds: string[];
  updatedIds: string[];
  updatedMarkdown: string;
}

function isSafeAppleReminderId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value.trim());
}

function isAppleReminderLike(value: unknown): value is AppleReminder {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return isSafeAppleReminderId(record.id) && typeof record.title === 'string';
}

function normalizeAppleReminderDueDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/u);
  if (!match) return undefined;
  const date = match[1];
  return isValidIsoDate(date) ? date : undefined;
}

function normalizeAppleReminder(item: AppleReminder): AppleReminder {
  return {
    id: item.id.trim(),
    title: item.title.trim() || 'Untitled reminder',
    notes: typeof item.notes === 'string' ? item.notes : undefined,
    dueDate: normalizeAppleReminderDueDate(item.dueDate),
    isCompleted: item.isCompleted === true,
    priority: typeof item.priority === 'number' ? Math.max(0, Math.min(3, Math.floor(item.priority))) : undefined,
    modifiedDate: typeof item.modifiedDate === 'string' ? item.modifiedDate : undefined,
  };
}

function appleReminderPayloadItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as AppleRemindersWebhookPayload;
  return Array.isArray(record.reminders) ? record.reminders ?? [] : Array.isArray(record.items) ? record.items ?? [] : [];
}

function appleReminderPayloadWithinLimits(payload: unknown): boolean {
  const items = appleReminderPayloadItems(payload);
  if (items.length > APPLE_REMINDERS_MAX_ITEMS) return false;
  return items.every((item) => {
    if (!item || typeof item !== 'object') return true;
    const record = item as Record<string, unknown>;
    return (typeof record.id !== 'string' || utf8ByteLength(record.id) <= APPLE_REMINDER_ID_MAX_BYTES)
      && (typeof record.title !== 'string' || utf8ByteLength(record.title) <= APPLE_REMINDER_TITLE_MAX_BYTES)
      && (typeof record.notes !== 'string' || utf8ByteLength(record.notes) <= APPLE_REMINDER_NOTES_MAX_BYTES);
  });
}

export function normalizeAppleRemindersWebhookPayload(payload: unknown): AppleReminder[] {
  return appleReminderPayloadItems(payload).filter(isAppleReminderLike).map(normalizeAppleReminder);
}

export function createAppleRemindersWebhookPayload(
  reminders: AppleReminder[],
  options: { secret?: string; listName?: string } = {},
): AppleRemindersWebhookPayload {
  return {
    protocol: APPLE_REMINDERS_WEBHOOK_PROTOCOL,
    ...(options.secret?.trim() ? { secret: options.secret.trim() } : {}),
    ...(options.listName?.trim() ? { listName: options.listName.trim() } : {}),
    reminders: normalizeAppleRemindersWebhookPayload(reminders),
  };
}

export function appleReminderIdFromTaskLine(line: string): string | undefined {
  return line.match(/\[id::\s*apple-reminder:([^\]\s]+)\s*\]/iu)?.[1]?.trim();
}

export function collectAppleReminderIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  for (const line of markdown.split(/\r?\n/u)) {
    const id = appleReminderIdFromTaskLine(line);
    if (id) ids.add(id);
  }
  return ids;
}

function utf8Bytes(value: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);

  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const codePoint = value.codePointAt(i);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) i += 1;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const maxSecretBytes = 1024;
  const aBytes = utf8Bytes(a);
  const bBytes = utf8Bytes(b);
  if (aBytes.length > maxSecretBytes || bBytes.length > maxSecretBytes) return false;
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxSecretBytes; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export function handleAppleRemindersWebhook(payload: unknown, options: AppleRemindersWebhookOptions): AppleRemindersWebhookResult {
  if (!options.enabled) return { accepted: false, reason: 'disabled', reminders: [], lines: [] };
  const isLegacyArrayPayload = Array.isArray(payload);
  const record = payload && typeof payload === 'object' && !isLegacyArrayPayload ? payload as AppleRemindersWebhookPayload : undefined;
  if (!isLegacyArrayPayload && record?.protocol !== APPLE_REMINDERS_WEBHOOK_PROTOCOL) {
    return { accepted: false, reason: 'invalid-payload', reminders: [], lines: [] };
  }
  const expectedSecret = options.secret?.trim();
  if (expectedSecret) {
    const provided = (record?.secret ?? '').trim();
    // Portable fixed-iteration comparison keeps the bridge mobile-safe and
    // avoids bundling Node crypto solely for local secret verification.
    const secretsMatch = constantTimeStringEqual(provided, expectedSecret);
    if (!secretsMatch) {
      return { accepted: false, reason: 'invalid-secret', reminders: [], lines: [] };
    }
  }
  if (!appleReminderPayloadWithinLimits(payload)) return { accepted: false, reason: 'resource-limit', reminders: [], lines: [] };
  const reminders = normalizeAppleRemindersWebhookPayload(payload);
  if (reminders.length === 0) return { accepted: false, reason: 'invalid-payload', reminders: [], lines: [] };
  const lines = reminders.map(appleReminderToTaskLine);
  if (utf8ByteLength(lines.join('\n')) > APPLE_REMINDERS_RENDERED_MAX_BYTES) {
    return { accepted: false, reason: 'resource-limit', reminders: [], lines: [] };
  }
  return { accepted: true, reminders, lines };
}

export function planAppleRemindersWebhookImport(
  payload: unknown,
  options: AppleRemindersWebhookOptions,
  existingMarkdown = '',
  updateExisting = false,
): AppleRemindersImportPlan {
  const result = handleAppleRemindersWebhook(payload, options);
  if (!result.accepted) {
    return { ...result, newLines: [], skippedDuplicateIds: [], updatedIds: [], updatedMarkdown: existingMarkdown };
  }

  const eol = existingMarkdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = existingMarkdown.split(/\r?\n/u);
  const existingLineById = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const id = appleReminderIdFromTaskLine(lines[index] ?? '');
    if (id && !existingLineById.has(id)) existingLineById.set(id, index);
  }
  const seenIncomingIds = new Set<string>();
  const newLines: string[] = [];
  const skippedDuplicateIds: string[] = [];
  const updatedIds: string[] = [];
  for (let index = 0; index < result.reminders.length; index += 1) {
    const reminder = result.reminders[index];
    if (seenIncomingIds.has(reminder.id)) {
      skippedDuplicateIds.push(reminder.id);
      continue;
    }
    seenIncomingIds.add(reminder.id);
    const existingIndex = existingLineById.get(reminder.id);
    if (existingIndex === undefined) {
      newLines.push(result.lines[index]);
      continue;
    }

    const existingModified = (lines[existingIndex] ?? '').match(/\[apple-modified::\s*([^\]]+)\]/iu)?.[1]?.trim();
    const incomingModified = reminder.modifiedDate && !Number.isNaN(Date.parse(reminder.modifiedDate))
      ? new Date(reminder.modifiedDate).toISOString()
      : undefined;
    if (!updateExisting || !existingModified || !incomingModified || Date.parse(incomingModified) <= Date.parse(existingModified)) {
      skippedDuplicateIds.push(reminder.id);
      continue;
    }

    let blockEnd = existingIndex + 1;
    while (blockEnd < lines.length && /^\s+-\s+💬/u.test(lines[blockEnd] ?? '')) blockEnd += 1;
    const replacementLines = result.lines[index].split('\n');
    const removedCount = blockEnd - existingIndex;
    lines.splice(existingIndex, removedCount, ...replacementLines);
    const delta = replacementLines.length - removedCount;
    if (delta !== 0) {
      for (const [id, lineIndex] of existingLineById) {
        if (lineIndex > existingIndex) existingLineById.set(id, lineIndex + delta);
      }
    }
    updatedIds.push(reminder.id);
  }

  return { ...result, newLines, skippedDuplicateIds, updatedIds, updatedMarkdown: lines.join(eol) };
}
