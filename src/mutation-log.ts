/**
 * Mutation Log for Task Manager
 * Records all task modifications from MCP, CLI, UI, and workflows for automation safety and recovery.
 * 
 * Features:
 * - Append-only JSONL log storage
 * - Automatic rotation at maxEntries (default 10000)
 * - Idempotency via idempotencyKey deduplication
 * - Mutation audit trail for external recovery workflows
 * - Query interface for auditing
 */

import { App, TFile } from 'obsidian';
import type { TaskManagerSettings } from './types';
import { ensureParentFolders, normalizeVaultRelativePath } from './vault-utils';

export type MutationSource = 'ui' | 'mcp' | 'cli' | 'workflow' | 'sync';
export type MutationAction = 'create' | 'update' | 'complete' | 'delete' | 'restore' | 'tag' | 'untag' | 'reschedule' | 'reprioritize' | 'other';

/**
 * A single mutation entry in the log.
 */
export interface MutationEntry {
  // Unique identifier for this operation (UUID)
  operationId: string;
  // ISO 8601 timestamp of when the mutation occurred
  timestamp: string;
  // Where the mutation originated from
  source: MutationSource;
  // What type of action was performed
  action: MutationAction;
  // Task identifier (usually filePath:lineNumber)
  taskKey: string;
  // Task content/text before the change
  before: Record<string, unknown> | null;
  // Task content/text after the change
  after: Record<string, unknown> | null;
  // Optional idempotency key to prevent duplicate mutations
  idempotencyKey?: string;
  // Optional user/agent that initiated the mutation
  initiator?: string;
  // Optional description of what happened
  description?: string;
  // Error message if the mutation failed
  error?: string;
}

export interface MutationQuery {
  // Filter by task key
  taskKey?: string;
  // Filter by source
  source?: MutationSource;
  // Filter by action
  action?: MutationAction;
  // Filter by date range (ISO 8601)
  from?: string;
  to?: string;
  // Limit results
  limit?: number;
  // Offset for pagination
  offset?: number;
}

function normalizePaginationLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizePaginationOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidMutationEntry(value: unknown): value is MutationEntry {
  if (!isPlainObject(value)) return false;
  return isString(value.operationId)
    && isString(value.timestamp)
    && isString(value.source)
    && isString(value.action)
    && isString(value.taskKey)
    && ('before' in value)
    && ('after' in value)
    && (value.idempotencyKey === undefined || isString(value.idempotencyKey))
    && (value.initiator === undefined || isString(value.initiator))
    && (value.description === undefined || isString(value.description))
    && (value.error === undefined || isString(value.error));
}

function appendUniqueMutationEntries(content: string, entries: readonly MutationEntry[]): string {
  const operationIds = new Set<string>();
  for (const line of content.split('\n')) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isPlainObject(parsed) && isString(parsed.operationId)) operationIds.add(parsed.operationId);
    } catch { /* preserve malformed historical lines without treating them as IDs */ }
  }
  const additions = entries.filter((entry) => !operationIds.has(entry.operationId)).map((entry) => JSON.stringify(entry));
  if (additions.length === 0) return content;
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}${additions.join('\n')}`;
}

/**
 * Manages append-only mutation logging for task modifications.
 */
export class MutationLog {
  private logFile: TFile | null = null;
  private recentIdempotencyKeys = new Map<string, string>(); // retained idempotencyKey -> operationId
  private inFlightIdempotencyKeys = new Map<string, string>(); // synchronously reserved before enqueue
  private entries: MutationEntry[] = [];
  private isInitialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private app: App,
    private getSettings: () => TaskManagerSettings,
  ) {}

  /**
   * Initialize the mutation log by loading the log file and cache.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      const settings = this.getSettings();
      if (!settings.mutationLogEnabled) {
        return;
      }

      const logFilePath = normalizeVaultRelativePath(settings.mutationLogFile || '.mutation-log.jsonl', 'Mutation log path');
      let file = this.app.vault.getAbstractFileByPath(logFilePath);

      if (!file) {
        // Create the log file if it doesn't exist
        await ensureParentFolders(this.app, logFilePath);
        await this.app.vault.create(logFilePath, '');
        file = this.app.vault.getAbstractFileByPath(logFilePath);
      }

      if (file && file instanceof TFile) {
        this.logFile = file;
        await this.loadRecentEntries();
        this.isInitialized = true;
      }
    } catch (err) {
      console.error('[MutationLog] Initialization failed:', err);
    }
  }

  /**
   * Load recent entries from the log file to populate idempotency cache.
   * Loads all retained entries so idempotency survives plugin restarts.
   */
  private async loadRecentEntries(): Promise<void> {
    if (!this.logFile) return;

    try {
      const content = await this.app.vault.read(this.logFile);
      if (!content.trim()) return;

      const lines = content.trim().split('\n');

      this.entries = [];
      this.recentIdempotencyKeys.clear();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!isValidMutationEntry(parsed)) {
            console.warn('[MutationLog] Ignoring invalid entry:', parsed);
            continue;
          }
          this.entries.push(parsed);
          if (parsed.idempotencyKey) {
            this.recentIdempotencyKeys.set(parsed.idempotencyKey, parsed.operationId);
          }
        } catch (err) {
          console.warn('[MutationLog] Failed to parse entry:', err);
        }
      }
    } catch (err) {
      console.error('[MutationLog] Failed to load entries:', err);
    }
  }

  /**
   * Check if an idempotency key has already been processed.
   */
  isDuplicate(idempotencyKey: string | undefined): boolean {
    if (!idempotencyKey) return false;
    return this.recentIdempotencyKeys.has(idempotencyKey) || this.inFlightIdempotencyKeys.has(idempotencyKey);
  }

  /**
   * Record a mutation to the log. The full append/cache/rotation transaction is
   * serialized so two different keys cannot rotate one shared log concurrently.
   */
  async logMutation(entry: Omit<MutationEntry, 'operationId' | 'timestamp'>): Promise<MutationEntry | null> {
    if (!this.isInitialized || !this.logFile) return null;
    if (entry.idempotencyKey && this.isDuplicate(entry.idempotencyKey)) return null;

    const operationId = this.generateOperationId();
    const completeEntry: MutationEntry = {
      operationId,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    if (entry.idempotencyKey) this.inFlightIdempotencyKeys.set(entry.idempotencyKey, operationId);

    return this.enqueueWrite(async () => {
      try {
        try {
          await this.app.vault.process(this.logFile as TFile, (content) =>
            (content ? content + '\n' : '') + JSON.stringify(completeEntry),
          );
        } catch (error) {
          console.error('[MutationLog] Failed to append mutation:', error);
          return null;
        }

        this.entries.push(completeEntry);
        if (entry.idempotencyKey) this.recentIdempotencyKeys.set(entry.idempotencyKey, operationId);

        // Rotation is maintenance after a committed append. It must never make a
        // committed entry look failed or release its idempotency key for retry.
        try {
          await this.checkAndRotate();
        } catch (error) {
          console.error('[MutationLog] Rotation maintenance failed:', error);
        }
        return completeEntry;
      } finally {
        if (entry.idempotencyKey && this.inFlightIdempotencyKeys.get(entry.idempotencyKey) === operationId) {
          this.inFlightIdempotencyKeys.delete(entry.idempotencyKey);
        }
      }
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /**
   * Query the mutation log.
   */
  queryMutations(query: MutationQuery = {}): Promise<MutationEntry[]> {
    if (!this.isInitialized) {
      return Promise.resolve([]);
    }

    let results = [...this.entries];

    // Apply filters
    if (query.taskKey) {
      results = results.filter((e) => e.taskKey === query.taskKey);
    }
    if (query.source) {
      results = results.filter((e) => e.source === query.source);
    }
    if (query.action) {
      results = results.filter((e) => e.action === query.action);
    }
    if (query.from) {
      const from = query.from;
      results = results.filter((e) => e.timestamp >= from);
    }
    if (query.to) {
      const to = query.to;
      results = results.filter((e) => e.timestamp <= to);
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Paginate
    const offset = normalizePaginationOffset(query.offset);
    const limit = normalizePaginationLimit(query.limit, 100);
    return Promise.resolve(results.slice(offset, offset + limit));
  }

  /**
   * Vault-content undo is not implemented here. Returning false prevents callers
   * from treating an audit-log entry as a restored task.
   */
  undoMutation(operationId: string): Promise<boolean> {
    const entry = this.entries.find((e) => e.operationId === operationId);
    if (!entry) {
      console.warn('[MutationLog] Cannot undo mutation:', operationId);
      return Promise.resolve(false);
    }

    console.warn('[MutationLog] Vault-content undo is not implemented:', operationId);
    return Promise.resolve(false);
  }

  /**
   * Check if rotation is needed and perform it if necessary.
   */
  private async checkAndRotate(): Promise<void> {
    if (!this.logFile) return;
    try {
      const maxEntries = this.getSettings().mutationLogMaxEntries || 10000;
      if (this.entries.length <= maxEntries) return;

      const archiveCount = this.entries.length - maxEntries;
      const entriesToArchive = this.entries.slice(0, archiveCount);
      const retainedEntries = this.entries.slice(archiveCount);
      const now = new Date();
      const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const backupPath = this.rotationBackupPath(timestamp);

      const backupFile = this.app.vault.getAbstractFileByPath(backupPath);
      if (backupFile && backupFile instanceof TFile) {
        await this.app.vault.process(backupFile, (content) => appendUniqueMutationEntries(content, entriesToArchive));
      } else {
        await ensureParentFolders(this.app, backupPath);
        await this.app.vault.create(backupPath, entriesToArchive.map((entry) => JSON.stringify(entry)).join('\n'));
      }

      // Backup first, then trim the active file. Do not mutate memory until both
      // durable writes succeed. A retry deduplicates operation IDs in the backup.
      const newLogContent = retainedEntries.map((entry) => JSON.stringify(entry)).join('\n');
      await this.app.vault.process(this.logFile, () => newLogContent);
      this.entries = retainedEntries;
      this.rebuildIdempotencyCache();
    } catch (err) {
      console.error('[MutationLog] Rotation failed:', err);
    }
  }

  private rotationBackupPath(timestamp: string): string {
    const logPath = this.logFile?.path ?? normalizeVaultRelativePath(this.getSettings().mutationLogFile || '.mutation-log.jsonl', 'Mutation log path');
    const pathParts = logPath.split('/');
    const fileName = pathParts.pop() || '.mutation-log.jsonl';
    const folder = pathParts.join('/');
    const baseName = fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length) : fileName;
    const backupName = `${baseName}.${timestamp}.jsonl`;
    return folder ? `${folder}/${backupName}` : backupName;
  }

  /**
   * Generate a unique operation ID.
   */
  private generateOperationId(): string {
    return `op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private rebuildIdempotencyCache(): void {
    this.recentIdempotencyKeys.clear();
    for (const entry of this.entries) {
      if (entry.idempotencyKey) {
        this.recentIdempotencyKeys.set(entry.idempotencyKey, entry.operationId);
      }
    }
  }

  /**
   * Get mutation log statistics.
   */
  getStats(): Promise<{ totalEntries: number; bySource: Record<string, number>; byAction: Record<string, number> }> {
    const stats = {
      totalEntries: this.entries.length,
      bySource: {} as Record<string, number>,
      byAction: {} as Record<string, number>,
    };

    for (const entry of this.entries) {
      stats.bySource[entry.source] = (stats.bySource[entry.source] || 0) + 1;
      stats.byAction[entry.action] = (stats.byAction[entry.action] || 0) + 1;
    }

    return Promise.resolve(stats);
  }

  /**
   * Export recent mutations as JSON.
   */
  export(limit: number = 100): Promise<MutationEntry[]> {
    const normalizedLimit = normalizePaginationLimit(limit, 100);
    if (normalizedLimit === 0) return Promise.resolve([]);
    return Promise.resolve(this.entries.slice(-normalizedLimit));
  }

  /**
   * Clear the mutation log (for testing only).
   */
  async clear(): Promise<void> {
    if (!this.logFile) return;
    await this.enqueueWrite(async () => {
      try {
        await this.app.vault.process(this.logFile as TFile, () => '');
        this.entries = [];
        this.recentIdempotencyKeys.clear();
      } catch (err) {
        console.error('[MutationLog] Failed to clear log:', err);
      }
    });
  }

  /**
   * Check if the mutation log is enabled and initialized.
   */
  isEnabled(): boolean {
    return this.isInitialized && this.getSettings().mutationLogEnabled;
  }
}

/**
 * Global mutation log instance (set by TaskManagerPlugin).
 */
let globalMutationLog: MutationLog | null = null;

export function setGlobalMutationLog(log: MutationLog): void {
  globalMutationLog = log;
}

export function getGlobalMutationLog(): MutationLog | null {
  return globalMutationLog;
}

/**
 * Convenience helper to log a mutation globally.
 */
export async function logMutation(entry: Omit<MutationEntry, 'operationId' | 'timestamp'>): Promise<MutationEntry | null> {
  const log = getGlobalMutationLog();
  if (!log) return null;
  return log.logMutation(entry);
}

/**
 * Convenience helper to query mutations globally.
 */
export async function queryMutations(query?: MutationQuery): Promise<MutationEntry[]> {
  const log = getGlobalMutationLog();
  if (!log) return [];
  return log.queryMutations(query);
}

/**
 * Convenience helper for mutation undo requests. Returns false until
 * vault-content undo is implemented.
 */
export async function undoMutation(operationId: string): Promise<boolean> {
  const log = getGlobalMutationLog();
  if (!log) return false;
  return log.undoMutation(operationId);
}
