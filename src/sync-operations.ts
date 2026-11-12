/**
 * Sync Operation Queue & Executor
 *
 * Manages a queue of sync operations with:
 * - Queuing, prioritization, and batching
 * - Dry-run preview
 * - Per-field conflict tracking
 * - Transaction-like semantics for batch operations
 */

import type { SyncAdapter, SyncOperation, OperationQueueState, DryRunOutput, FieldConflict, ReconciliationEvidence } from './sync-contract';
import type { MarkdownTask } from './task-model';
import { isProviderRunCancellation } from './provider-sync-safety';
export { assertProviderRunCurrent, commitProviderImports, isProviderRunCancellation, ProviderRunCancelledError, ProviderSyncCoordinator, type ProviderImportCandidate, type ProviderRunContext, type ProviderSyncKey } from './provider-sync-safety';
export { refreshGoogleCalendarTokenSettings, refreshGoogleTasksTokenSettings, refreshMicrosoftTodoTokenSettings } from './provider-token-refresh';

/**
 * Priority levels for sync operations
 */
type OperationPriority = 'high' | 'normal' | 'low';

const MAX_COMPLETED_OPERATIONS = 100;
const READ_FIRST_RECONCILIATION_SERVICES = new Set(['todoist', 'google-tasks', 'microsoft-todo', 'ms-todo']);
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_AFTER_MS = 30_000;

function retryStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const record = error as { status?: unknown; statusCode?: unknown };
    const value = typeof record.status === 'number' ? record.status : typeof record.statusCode === 'number' ? record.statusCode : undefined;
    if (value !== undefined) return value;
  }
  const match = String(error instanceof Error ? error.message : error).match(/(?:HTTP|status|error)\s*(\d{3})/iu);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, value))
    : undefined;
}

function isRetryableSyncError(error: unknown): boolean {
  const status = retryStatus(error);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  if (error instanceof TypeError) return true;
  return /network|timeout|timed out|fetch failed|connection|temporar/iu.test(error instanceof Error ? error.message : String(error));
}

async function waitForRetry(delayMs: number, assertCurrent?: () => void): Promise<void> {
  const deadline = Date.now() + Math.max(0, delayMs);
  while (true) {
    assertCurrent?.();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }
}

/**
 * Queue entry with metadata
 */
interface QueueEntry {
  operation: SyncOperation;
  priority: OperationPriority;
  retries: number;
  maxRetries: number;
}

/**
 * Manages a queue of sync operations and their execution
 */
export class SyncOperationQueue {
  private queue: QueueEntry[] = [];
  private completed: (SyncOperation & { completedAt: number })[] = [];
  private adapters: Map<string, SyncAdapter> = new Map();
  private operationId = 0;
  private state: OperationQueueState;
  private executionLock: Promise<void> = Promise.resolve();

  constructor(initialState?: OperationQueueState) {
    this.state = initialState ? structuredClone(initialState) : { operations: [], completed: [], version: 2 };
    this.loadState();
  }

  /**
   * Register a sync adapter
   */
  registerAdapter(service: string, adapter: SyncAdapter): void {
    this.adapters.set(service, adapter);
  }

  /**
   * Load queue from persisted state
   */
  private loadState(): void {
    this.queue = [];
    this.completed = this.state.completed.slice(-MAX_COMPLETED_OPERATIONS);
    this.state.completed = this.completed;

    for (const op of [...this.completed, ...this.state.operations]) {
      // Restore the ID counter from all persisted operations, including completed
      // history, so a reload cannot reuse a recently completed operation ID.
      if (typeof op.id !== 'string') continue;
      const opNum = Number.parseInt(op.id.split('-')[2] ?? '', 10);
      if (!Number.isNaN(opNum) && opNum > this.operationId) {
        this.operationId = opNum;
      }
    }

    for (const op of this.state.operations) {
      if (op.status === 'executing') {
        if (READ_FIRST_RECONCILIATION_SERVICES.has(op.service)) {
          Object.assign(op, {
            status: 'conflict' as const,
            payload: {},
            fields: [],
            error: 'A provider mutation was interrupted after dispatch and requires a fresh remote read; it will not be replayed automatically.',
          });
        } else op.status = 'queued';
      }
      this.queue.push({
        operation: op,
        priority: 'normal',
        retries: op.attempts ?? 0,
        maxRetries: op.type === 'create' ? 0 : 3,
      });
    }
  }

  /**
   * Generate unique operation ID
   */
  private generateOperationId(): string {
    return `sync-op-${++this.operationId}`;
  }

  /**
   * Enqueue a create operation
   */
  enqueueCreate(
    vaultTask: MarkdownTask,
    service: string,
    payload: Record<string, unknown>,
    priority: OperationPriority = 'normal',
    dryRun = false,
  ): SyncOperation {
    const id = this.generateOperationId();
    const operation: SyncOperation = {
      id,
      type: 'create',
      service,
      vaultTask,
      payload,
      status: 'queued',
      queuedAt: Date.now(),
      dryRun,
      idempotencyKey: `${service}:${id}`,
      attempts: 0,
    };

    this.queue.push({
      operation,
      priority,
      retries: 0,
      maxRetries: 0,
    });

    this.state.operations.push(operation);
    return operation;
  }

  /**
   * Enqueue an update operation
   */
  enqueueUpdate(
    vaultTask: MarkdownTask,
    service: string,
    externalId: string,
    payload: Record<string, unknown>,
    fields?: string[],
    priority: OperationPriority = 'normal',
    dryRun = false,
    reconciliation?: ReconciliationEvidence,
  ): SyncOperation {
    const id = this.generateOperationId();
    const operation: SyncOperation = {
      id,
      type: 'update',
      service,
      vaultTask,
      externalId,
      payload,
      fields,
      status: 'queued',
      queuedAt: Date.now(),
      dryRun,
      idempotencyKey: `${service}:${id}`,
      attempts: 0,
      ...(reconciliation ? { reconciliation } : {}),
    };

    this.queue.push({
      operation,
      priority,
      retries: 0,
      maxRetries: reconciliation ? 0 : 3,
    });

    this.state.operations.push(operation);
    return operation;
  }

  /** Retain a read-first conflict without creating an executable remote payload. */
  enqueueReconciliationConflict(
    vaultTask: MarkdownTask,
    service: string,
    externalId: string,
    conflicts: FieldConflict[],
    reconciliation: ReconciliationEvidence,
  ): SyncOperation {
    const id = this.generateOperationId();
    const operation: SyncOperation = {
      id,
      type: 'update',
      service,
      vaultTask,
      externalId,
      payload: {},
      fields: [],
      status: 'conflict',
      conflicts: conflicts.map((conflict) => ({ ...conflict })),
      error: 'Reconciliation conflict requires a fresh read and review; no stale payload is executable.',
      queuedAt: Date.now(),
      idempotencyKey: `${service}:${id}`,
      attempts: 0,
      reconciliation,
    };
    this.queue.push({ operation, priority: 'normal', retries: 0, maxRetries: 0 });
    this.state.operations.push(operation);
    return operation;
  }

  /**
   * Enqueue a delete operation
   */
  enqueueDelete(
    vaultTask: MarkdownTask,
    service: string,
    externalId: string,
    priority: OperationPriority = 'normal',
    dryRun = false,
  ): SyncOperation {
    const id = this.generateOperationId();
    const operation: SyncOperation = {
      id,
      type: 'delete',
      service,
      vaultTask,
      externalId,
      payload: {},
      status: 'queued',
      queuedAt: Date.now(),
      dryRun,
      idempotencyKey: `${service}:${id}`,
      attempts: 0,
    };

    this.queue.push({
      operation,
      priority,
      retries: 0,
      maxRetries: 3,
    });

    this.state.operations.push(operation);
    return operation;
  }

  /**
   * Enqueue a reopen operation
   */
  enqueueReopen(
    vaultTask: MarkdownTask,
    service: string,
    externalId: string,
    priority: OperationPriority = 'normal',
    dryRun = false,
  ): SyncOperation {
    const id = this.generateOperationId();
    const operation: SyncOperation = {
      id,
      type: 'reopen',
      service,
      vaultTask,
      externalId,
      payload: {},
      status: 'queued',
      queuedAt: Date.now(),
      dryRun,
      idempotencyKey: `${service}:${id}`,
      attempts: 0,
    };

    this.queue.push({
      operation,
      priority,
      retries: 0,
      maxRetries: 3,
    });

    this.state.operations.push(operation);
    return operation;
  }

  /**
   * Sort queue by priority (high first)
   */
  private sortQueue(): void {
    const priorityMap = { high: 0, normal: 1, low: 2 };

    this.queue.sort(
      (a, b) =>
        priorityMap[a.priority] - priorityMap[b.priority] ||
        a.operation.queuedAt - b.operation.queuedAt,
    );
  }

  /**
   * Generate dry-run output preview
   */
  generateDryRunOutput(): Promise<DryRunOutput> {
    this.sortQueue();

    const byType: Record<'create' | 'update' | 'delete' | 'reopen', number> = {
      create: 0,
      update: 0,
      delete: 0,
      reopen: 0,
    };
    const byService: Record<string, number> = {};
    const potentialConflicts: FieldConflict[] = [];
    const fieldWarnings: Array<{
      field: string;
      service: string;
      level: 'warning' | 'error';
      message: string;
    }> = [];
    const operationsDetail: Array<{
      id: string;
      type: string;
      service: string;
      vaultTaskKey: string;
      externalId?: string;
      preview: string;
    }> = [];

    for (const entry of this.queue) {
      const op = entry.operation;

      if (op.status !== 'queued') continue;

      byType[op.type]++;
      byService[op.service] = (byService[op.service] ?? 0) + 1;

      const adapter = this.adapters.get(op.service);
      if (adapter) {
        const caps = adapter.getCapabilities();

        // Check field compatibility
        if (op.fields) {
          for (const field of op.fields) {
            const fieldCap = caps.fields[field] ?? 'unsupported';
            if (fieldCap === 'experimental') {
              fieldWarnings.push({
                field,
                service: op.service,
                level: 'warning',
                message: `Field "${field}" is experimental on ${op.service}`,
              });
            } else if (fieldCap === 'unsupported') {
              fieldWarnings.push({
                field,
                service: op.service,
                level: 'error',
                message: `Field "${field}" is not supported on ${op.service}`,
              });
            }
          }
        }

        // Check operation support
        if (!caps.supports[op.type]) {
          fieldWarnings.push({
            field: op.type,
            service: op.service,
            level: 'error',
            message: `Operation "${op.type}" not supported on ${op.service}`,
          });
        }
      }

      operationsDetail.push({
        id: op.id,
        type: op.type,
        service: op.service,
        vaultTaskKey: op.vaultTask.key,
        externalId: op.externalId,
        preview: this.operationPreview(op),
      });
    }

    return Promise.resolve({
      totalOperations: this.queue.filter((e) => e.operation.status === 'queued').length,
      byType,
      byService,
      potentialConflicts,
      fieldWarnings,
      operations: operationsDetail,
      estimatedDurationMs: operationsDetail.length * 100, // Rough estimate
    });
  }

  /**
   * Generate human-readable preview of operation
   */
  private operationPreview(op: SyncOperation): string {
    const task = op.vaultTask.body;
    const opType = op.type.toUpperCase();

    switch (op.type) {
      case 'create':
        return `${opType} "${task}" on ${op.service}`;
      case 'update':
        return `${opType} task [${op.externalId}] "${task}" on ${op.service}${op.fields ? ` (fields: ${op.fields.join(', ')})` : ''}`;
      case 'delete':
        return `${opType} task [${op.externalId}] from ${op.service}`;
      case 'reopen':
        return `${opType} task [${op.externalId}] on ${op.service}`;
      default:
        return 'Unknown operation';
    }
  }

  /**
   * Execute all queued operations
   */
  async executeAll(maxConcurrent = 3, service?: string, hooks: {
    assertCurrent?: () => void;
    beforeOperation?: (operation: SyncOperation) => Promise<void>;
  } = {}): Promise<{
    successful: SyncOperation[];
    failed: SyncOperation[];
    conflicts: SyncOperation[];
  }> {
    // Serialize concurrent executeAll() calls to prevent the same operation
    // from being executed multiple times if sync is triggered in parallel.
    const previousExecution = this.executionLock;
    let resolveExecution!: () => void;
    this.executionLock = new Promise<void>((resolve) => { resolveExecution = resolve; });

    await previousExecution;

    try {
      hooks.assertCurrent?.();
      return await this.executeAllInternal(maxConcurrent, service, hooks);
    } finally {
      resolveExecution();
    }
  }

  /**
   * Internal implementation of executeAll (guarded by executionLock)
   */
  private async executeAllInternal(maxConcurrent: number, service: string | undefined, hooks: {
    assertCurrent?: () => void;
    beforeOperation?: (operation: SyncOperation) => Promise<void>;
  }): Promise<{
    successful: SyncOperation[];
    failed: SyncOperation[];
    conflicts: SyncOperation[];
  }> {
    this.sortQueue();

    const concurrency = Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : 1;
    const successful: SyncOperation[] = [];
    const failed: SyncOperation[] = [];
    const conflicts: SyncOperation[] = [];

    // Execute in batches with concurrency limit. Provider runs may scope execution
    // so retained operations for another service cannot be consumed or reclassified.
    while (this.queue.some((e) => e.operation.status === 'queued' && (!service || e.operation.service === service))) {
      const queued = this.queue.filter((e) => e.operation.status === 'queued' && (!service || e.operation.service === service));
      const now = Date.now();
      const ready = queued.filter((entry) => (entry.operation.nextAttemptAt ?? 0) <= now);
      if (ready.length === 0) {
        const nextAttempt = Math.min(...queued.map((entry) => entry.operation.nextAttemptAt ?? now));
        await waitForRetry(Math.min(MAX_RETRY_AFTER_MS, Math.max(0, nextAttempt - now)), hooks.assertCurrent);
        continue;
      }
      const batch = ready.slice(0, concurrency);

      hooks.assertCurrent?.();
      const results = await Promise.allSettled(batch.map((entry) => this.executeOperation(entry, hooks)));

      for (let i = 0; i < results.length; i++) {
        const entry = batch[i];
        const result = results[i];

        if (result.status === 'fulfilled') {
          const outcome = result.value;
          if (outcome === 'success') {
            successful.push(entry.operation);
          } else if (outcome === 'conflict') {
            conflicts.push(entry.operation);
          } else if (entry.operation.status === 'failed') {
            failed.push(entry.operation);
          }
        } else {
          if (isProviderRunCancellation(result.reason)) throw result.reason;
          entry.operation.status = 'failed';
          entry.operation.error = result.reason instanceof Error ? result.reason.message : String(result.reason);
          failed.push(entry.operation);
        }
      }
    }

    return { successful, failed, conflicts };
  }

  /**
   * Execute single operation
   */
  private async executeOperation(entry: QueueEntry, hooks: {
    assertCurrent?: () => void;
    beforeOperation?: (operation: SyncOperation) => Promise<void>;
  }): Promise<'success' | 'failed' | 'conflict'> {
    const { operation } = entry;
    const adapter = this.adapters.get(operation.service);

    if (!adapter) {
      operation.status = 'failed';
      operation.error = `No adapter for service: ${operation.service}`;
      return 'failed';
    }

    if (operation.dryRun) {
      // Don't actually execute, just mark success
      operation.status = 'success';
      return 'success';
    }

    try {
      hooks.assertCurrent?.();
      operation.status = 'executing';
      operation.attempts = (operation.attempts ?? 0) + 1;
      delete operation.nextAttemptAt;
      await hooks.beforeOperation?.(operation);
      hooks.assertCurrent?.();

      switch (operation.type) {
        case 'create': {
          const result = await adapter.create(operation.payload, operation.dryRun);
          operation.result = result;
          operation.status = 'success';
          return 'success';
        }

        case 'update': {
          if (!operation.externalId) {
            throw new Error('Update operation missing externalId');
          }
          const result = await adapter.update(operation.externalId, operation.payload, operation.dryRun, operation.reconciliation?.remoteVersion);
          operation.result = { externalId: operation.externalId, hash: result.hash };
          if (result.conflicts && result.conflicts.length > 0) {
            operation.conflicts = result.conflicts;
            operation.status = 'conflict';
            return 'conflict';
          }
          operation.status = 'success';
          return 'success';
        }

        case 'delete': {
          if (!operation.externalId) {
            throw new Error('Delete operation missing externalId');
          }
          await adapter.delete(operation.externalId, operation.dryRun, operation.reconciliation?.remoteVersion);
          operation.status = 'success';
          return 'success';
        }

        case 'reopen': {
          if (!operation.externalId) {
            throw new Error('Reopen operation missing externalId');
          }
          await adapter.reopen(operation.externalId, operation.dryRun, operation.reconciliation?.remoteVersion);
          operation.status = 'success';
          return 'success';
        }

        default:
          throw new Error(`Unknown operation type: ${String(operation.type)}`);
      }
    } catch (error) {
      if (isProviderRunCancellation(error)) throw error;
      operation.status = 'failed';
      operation.error = error instanceof Error ? error.message : String(error);

      // Creates are not replayed automatically: a timed-out POST may already
      // have committed. Other operations retry only transient failures.
      if (operation.type !== 'create' && isRetryableSyncError(error) && entry.retries < entry.maxRetries) {
        entry.retries++;
        operation.attempts = entry.retries;
        const backoff = DEFAULT_RETRY_DELAY_MS * (2 ** Math.max(0, entry.retries - 1));
        operation.nextAttemptAt = Date.now() + (retryAfterMs(error) ?? backoff);
        operation.status = 'queued';
        return 'failed';
      }

      delete operation.nextAttemptAt;
      return 'failed';
    }
  }

  /**
   * Get all pending operations
   */
  getPending(): SyncOperation[] {
    return this.queue.map((e) => e.operation).filter((op) => op.status === 'queued');
  }

  /**
   * Get operation by ID
   */
  getOperation(id: string): SyncOperation | undefined {
    return this.queue.find((e) => e.operation.id === id)?.operation || this.completed.find((op) => op.id === id);
  }

  /**
   * Requeue transport failures only. Conflicts are evidence, not executable work.
   * Read-first reconciliation updates are also excluded because their payload is stale
   * after any interruption; the provider workflow must fetch and reconcile again.
   */
  requeueFailed(service?: string): number {
    let count = 0;
    for (const entry of this.queue) {
      if (service && entry.operation.service !== service) continue;
      if (READ_FIRST_RECONCILIATION_SERVICES.has(entry.operation.service)) continue;
      if (entry.operation.status === 'failed' && !entry.operation.reconciliation) {
        entry.operation.status = 'queued';
        entry.retries = 0;
        entry.operation.attempts = 0;
        delete entry.operation.nextAttemptAt;
        delete entry.operation.error;
        count++;
      }
    }
    return count;
  }

  /** Quarantine legacy/persisted provider writes that lack fresh read-first evidence. */
  quarantineUnsafeProviderOperations(service: string): number {
    let count = 0;
    for (const entry of this.queue) {
      const operation = entry.operation;
      if (operation.service !== service || operation.reconciliation || operation.status === 'success') continue;
      operation.status = 'conflict';
      operation.payload = {};
      operation.fields = [];
      operation.error = 'Legacy provider operation lacked fresh reconciliation evidence and was quarantined without execution.';
      operation.conflicts = [{ field: 'legacy-operation', vaultValue: null, serviceValue: null, service, detectedAt: operation.queuedAt }];
      operation.reconciliation = {
        schemaVersion: 1,
        baseline: null,
        local: {},
        remote: null,
        mode: 'conflict',
        capturedAt: operation.queuedAt,
      };
      delete operation.nextAttemptAt;
      entry.retries = 0;
      entry.maxRetries = 0;
      count += 1;
    }
    return count;
  }

  /** Drop stale reconciliation candidates only after the provider workflow completed a fresh read. */
  removeReconciliationOperations(vaultTaskKey: string, service: string, externalId?: string): number {
    const removed: Array<SyncOperation & { completedAt: number }> = [];
    this.queue = this.queue.filter((entry) => {
      const op = entry.operation;
      const matches = Boolean(op.reconciliation
        && (op.status === 'failed' || op.status === 'conflict')
        && op.vaultTask.key === vaultTaskKey
        && op.service === service
        && (!externalId || op.externalId === externalId));
      if (matches) removed.push({ ...op, error: `Superseded by fresh ${service} reconciliation. ${op.error ?? ''}`.trim(), completedAt: Date.now() });
      return !matches;
    });
    this.completed.push(...removed);
    this.pruneCompletedOperations();
    this.state.operations = this.queue.map((entry) => entry.operation);
    this.state.completed = this.completed;
    return removed.length;
  }

  /** Backward-compatible narrow alias. */
  removeFailedReconciliationOperations(vaultTaskKey: string, service: string, externalId?: string): number {
    return this.removeReconciliationOperations(vaultTaskKey, service, externalId);
  }

  /**
   * Return whether an operation for the same task/service is already retained in the queue.
   */
  hasOperationFor(vaultTaskKey: string, service: string, types?: ReadonlyArray<SyncOperation['type']>, externalId?: string): boolean {
    return this.queue.some((entry) => {
      const op = entry.operation;
      if (op.vaultTask.key !== vaultTaskKey || op.service !== service) return false;
      if (types && !types.includes(op.type)) return false;
      if (externalId && op.externalId !== externalId) return false;
      return op.status === 'queued' || op.status === 'failed' || op.status === 'conflict' || op.status === 'executing';
    });
  }

  /**
   * Remove operations by id after successful execution, preserving failed/conflicted entries for retry/review.
   */
  removeOperations(ids: ReadonlyArray<string>): void {
    const idSet = new Set(ids);
    const removed: Array<SyncOperation & { completedAt: number }> = [];
    this.queue = this.queue.filter((entry) => {
      if (!idSet.has(entry.operation.id)) return true;
      removed.push({ ...entry.operation, completedAt: Date.now() });
      return false;
    });
    this.completed.push(...removed);
    this.pruneCompletedOperations();
    this.state.operations = this.queue.map((entry) => entry.operation);
    this.state.completed = this.completed;
  }

  private pruneCompletedOperations(): void {
    if (this.completed.length > MAX_COMPLETED_OPERATIONS) {
      this.completed.splice(0, this.completed.length - MAX_COMPLETED_OPERATIONS);
    }
  }

  /**
   * Clear queue (careful!)
   */
  clear(): void {
    this.queue = [];
    this.completed = [];
    this.state.operations = [];
    this.state.completed = [];
  }

  /**
   * Get current state for persistence
   */
  getState(): OperationQueueState {
    return {
      operations: this.queue.map((e) => e.operation),
      completed: this.completed,
      version: 2,
    };
  }

  /**
   * Get statistics
   */
  getStats(): {
    queued: number;
    executing: number;
    completed: number;
    failed: number;
    conflicts: number;
  } {
    const stats = {
      queued: 0,
      executing: 0,
      completed: 0,
      failed: 0,
      conflicts: 0,
    };

    for (const entry of this.queue) {
      const status = entry.operation.status;
      if (status === 'queued') stats.queued++;
      else if (status === 'executing') stats.executing++;
      else if (status === 'success') stats.completed++;
      else if (status === 'failed') stats.failed++;
      else if (status === 'conflict') stats.conflicts++;
    }

    return stats;
  }
}
