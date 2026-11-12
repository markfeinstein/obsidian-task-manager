/**
 * Sync conflict review helpers and modal.
 *
 * The pure helpers in this module intentionally operate on the shared
 * OperationQueueState / SyncConflictReport data model so conflict review can be
 * tested without opening Obsidian UI. The modal is a thin review/action shell.
 */

import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { FieldConflict, OperationQueueState, SyncConflictReport, SyncOperation } from './sync-contract';

export const REVIEWABLE_SYNC_SERVICES = ['todoist', 'google-tasks', 'ms-todo', 'microsoft-todo'] as const;

export type FieldResolutionChoice = 'vault' | 'service' | 'custom' | 'skip';

export interface SyncFieldResolution {
  field: string;
  choice: FieldResolutionChoice;
  customValue?: unknown;
}

export interface SyncConflictResolutionSet {
  operationId: string;
  resolutions: SyncFieldResolution[];
}

export interface ReviewableConflictReport extends SyncConflictReport {
  operationId?: string;
  operationType?: SyncOperation['type'];
  externalId?: string;
  error?: string;
}

export interface SyncConflictReviewModel {
  generatedAt: number;
  totalReports: number;
  totalFailedOperations: number;
  totalConflictedOperations: number;
  reports: ReviewableConflictReport[];
  failedOperations: SyncOperation[];
  conflictedOperations: SyncOperation[];
  retryableOperations: SyncOperation[];
  byService: Record<string, { reports: number; failed: number; conflicted: number; retryable: number }>;
}

export interface SyncQueueReviewAction {
  retryOperationIds?: string[];
  discardOperationIds?: string[];
  conflictResolutions?: SyncConflictResolutionSet[];
  service?: string;
  now?: number;
}

export interface SyncQueueReviewActionResult {
  state: OperationQueueState;
  retried: number;
  discarded: number;
  resolved: number;
  remainingConflicts: number;
  untouched: number;
}

export function emptyOperationQueueState(): OperationQueueState {
  return { operations: [], completed: [], version: 2 };
}

export function isReviewableService(service: string, allowedServices?: readonly string[]): boolean {
  if (allowedServices && allowedServices.length > 0) {
    return allowedServices.map(s => s.toLowerCase()).includes(service.toLowerCase());
  }
  return true;
}

function cloneOperation(op: SyncOperation): SyncOperation {
  return {
    ...op,
    fields: op.fields ? [...op.fields] : undefined,
    payload: { ...op.payload },
    result: op.result ? { ...op.result } : undefined,
    conflicts: op.conflicts?.map((conflict) => ({ ...conflict })),
    reconciliation: op.reconciliation ? {
      ...op.reconciliation,
      baseline: op.reconciliation.baseline ? { ...op.reconciliation.baseline } : null,
      local: { ...op.reconciliation.local },
      remote: op.reconciliation.remote ? { ...op.reconciliation.remote } : null,
    } : undefined,
  };
}

function cloneState(state: OperationQueueState): OperationQueueState {
  return {
    version: state.version || 1,
    operations: (state.operations ?? []).map(cloneOperation),
    completed: (state.completed ?? []).map((op) => ({ ...cloneOperation(op), completedAt: op.completedAt })),
  };
}

function incrementServiceBucket(model: SyncConflictReviewModel, service: string, key: 'reports' | 'failed' | 'conflicted' | 'retryable'): void {
  model.byService[service] ??= { reports: 0, failed: 0, conflicted: 0, retryable: 0 };
  model.byService[service][key] += 1;
}

export function buildSyncConflictReportsFromQueue(
  state: OperationQueueState | undefined,
  options: { strategy?: SyncConflictReport['strategy']; now?: number; services?: readonly string[] } = {},
): ReviewableConflictReport[] {
  const timestamp = options.now ?? Date.now();
  const strategy = options.strategy ?? 'manual';
  return (state?.operations ?? [])
    .filter((op) => op.status === 'conflict' && isReviewableService(op.service, options.services) && (op.conflicts?.length ?? 0) > 0)
    .map((op) => ({
      taskKey: op.vaultTask.key,
      service: op.service,
      conflicts: op.conflicts?.map((conflict) => ({ ...conflict })) ?? [],
      strategy,
      timestamp,
      operationId: op.id,
      operationType: op.type,
      externalId: op.externalId,
      error: op.error,
    }));
}

export function buildSyncConflictReviewModel(
  state: OperationQueueState | undefined,
  options: { strategy?: SyncConflictReport['strategy']; now?: number; services?: readonly string[] } = {},
): SyncConflictReviewModel {
  const operations = state?.operations ?? [];
  const reports = buildSyncConflictReportsFromQueue(state, options);
  const failedOperations = operations.filter((op) => op.status === 'failed' && isReviewableService(op.service, options.services)).map(cloneOperation);
  const conflictedOperations = operations.filter((op) => op.status === 'conflict' && isReviewableService(op.service, options.services)).map(cloneOperation);
  // Conflicts must return through a fresh provider read; their retained evidence is never replayable.
  const retryableOperations = operations.filter((op) => op.status === 'failed' && !op.reconciliation && isReviewableService(op.service, options.services)).map(cloneOperation);

  const model: SyncConflictReviewModel = {
    generatedAt: options.now ?? Date.now(),
    totalReports: reports.length,
    totalFailedOperations: failedOperations.length,
    totalConflictedOperations: conflictedOperations.length,
    reports,
    failedOperations,
    conflictedOperations,
    retryableOperations,
    byService: {},
  };

  for (const report of reports) incrementServiceBucket(model, report.service, 'reports');
  for (const op of failedOperations) incrementServiceBucket(model, op.service, 'failed');
  for (const op of conflictedOperations) incrementServiceBucket(model, op.service, 'conflicted');
  for (const op of retryableOperations) incrementServiceBucket(model, op.service, 'retryable');
  return model;
}

export function defaultFieldResolutions(conflicts: readonly FieldConflict[], choice: FieldResolutionChoice): SyncFieldResolution[] {
  return conflicts.map((conflict) => ({ field: conflict.field, choice }));
}

export function applyFieldResolutionsToPayload(
  payload: Record<string, unknown>,
  conflicts: readonly FieldConflict[],
  resolutions: readonly SyncFieldResolution[],
): { payload: Record<string, unknown>; unresolvedConflicts: FieldConflict[]; resolvedFields: string[]; skippedFields: string[] } {
  const nextPayload = { ...payload };
  const resolvedFields: string[] = [];
  const skippedFields: string[] = [];
  const unresolvedConflicts: FieldConflict[] = [];
  const resolutionByField = new Map(resolutions.map((resolution) => [resolution.field, resolution]));

  for (const conflict of conflicts) {
    const resolution = resolutionByField.get(conflict.field);
    if (!resolution || resolution.choice === 'skip') {
      unresolvedConflicts.push({ ...conflict });
      skippedFields.push(conflict.field);
      continue;
    }

    if (resolution.choice === 'vault') {
      nextPayload[conflict.field] = conflict.vaultValue;
      resolvedFields.push(conflict.field);
      continue;
    }

    if (resolution.choice === 'service') {
      delete nextPayload[conflict.field];
      resolvedFields.push(conflict.field);
      continue;
    }

    nextPayload[conflict.field] = resolution.customValue;
    resolvedFields.push(conflict.field);
  }

  return { payload: nextPayload, unresolvedConflicts, resolvedFields, skippedFields };
}

export function applySyncQueueReviewActions(state: OperationQueueState, action: SyncQueueReviewAction): SyncQueueReviewActionResult {
  const nextState = cloneState(state);
  const retryIds = new Set(action.retryOperationIds ?? []);
  const discardIds = new Set(action.discardOperationIds ?? []);
  const resolutionByOperation = new Map((action.conflictResolutions ?? []).map((resolution) => [resolution.operationId, resolution.resolutions]));
  const now = action.now ?? Date.now();
  let retried = 0;
  let discarded = 0;
  let resolved = 0;
  let untouched = 0;

  const retained: SyncOperation[] = [];
  for (const op of nextState.operations) {
    if (action.service && op.service !== action.service) {
      retained.push(op);
      untouched += 1;
      continue;
    }

    if (discardIds.has(op.id)) {
      nextState.completed.push({ ...op, completedAt: now });
      discarded += 1;
      continue;
    }

    const resolutions = resolutionByOperation.get(op.id);
    if (resolutions && op.conflicts?.length) {
      if (op.reconciliation) {
        // Resolution UI is intentionally read-only until a provider-specific fresh-read
        // revalidation path can safely apply choices. Preserve all evidence and conflicts.
        retained.push(op);
        untouched += 1;
        continue;
      }
      const applied = applyFieldResolutionsToPayload(op.payload, op.conflicts, resolutions);
      op.payload = applied.payload;
      op.fields = op.fields?.filter((field) => field in op.payload);
      if (applied.unresolvedConflicts.length === 0) {
        op.status = 'queued';
        delete op.error;
        delete op.conflicts;
        resolved += 1;
        retried += 1;
      } else {
        op.status = 'conflict';
        op.conflicts = applied.unresolvedConflicts;
        resolved += applied.resolvedFields.length > 0 ? 1 : 0;
      }
      retained.push(op);
      continue;
    }

    if (retryIds.has(op.id) && op.status === 'failed' && !op.reconciliation) {
      op.status = 'queued';
      delete op.error;
      retried += 1;
      retained.push(op);
      continue;
    }

    retained.push(op);
    untouched += 1;
  }

  nextState.operations = retained;
  const remainingConflicts = retained.filter((op) => op.status === 'conflict').length;
  return { state: nextState, retried, discarded, resolved, remainingConflicts, untouched };
}

export interface SyncConflictReportModalOptions {
  getQueueState: () => OperationQueueState | undefined;
  onApplyQueueAction: (action: SyncQueueReviewAction) => Promise<SyncQueueReviewActionResult>;
  strategy?: SyncConflictReport['strategy'];
}

export class SyncConflictReportModal extends Modal {
  private retryPending = false;
  private retryError = '';
  private retryStatus = '';

  constructor(app: App, private readonly options: SyncConflictReportModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const model = buildSyncConflictReviewModel(this.options.getQueueState(), { strategy: this.options.strategy ?? 'manual' });

    contentEl.createEl('h2', { text: 'Sync conflict report' });
    contentEl.createEl('p', {
      text: `${model.totalConflictedOperations} conflicted operation(s), ${model.totalFailedOperations} failed operation(s), ${model.retryableOperations.length} retryable transport failure(s). Conflicts require a fresh sync read.`,
    });
    const retryStatus = contentEl.createDiv({ cls: 'task-manager-sync-retry-status' });
    retryStatus.setAttr('role', this.retryError ? 'alert' : 'status');
    retryStatus.setAttr('aria-live', this.retryError ? 'assertive' : 'polite');
    retryStatus.setText(this.retryError || this.retryStatus);

    if (model.retryableOperations.length > 0) {
      new Setting(contentEl)
        .setName('Retry failed operations')
        .setDesc('Requeues non-reconciliation transport failures only. Conflicts and stale reconciliation payloads are never replayed.')
        .addButton((button) => button
          .setButtonText(this.retryPending ? 'Requeuing…' : 'Retry all')
          .setDisabled(this.retryPending)
          .setCta()
          .onClick(async () => {
            if (this.retryPending) return;
            this.retryPending = true;
            this.retryError = '';
            this.retryStatus = `Requeuing ${model.retryableOperations.length} operation(s)…`;
            this.render();
            try {
              const result = await this.options.onApplyQueueAction({ retryOperationIds: model.retryableOperations.map((op) => op.id) });
              this.retryStatus = `Requeued ${result.retried} operation(s); ${result.remainingConflicts} conflict(s) remain.`;
              new Notice(`Task Manager: requeued ${result.retried} sync operation(s).`);
            } catch (error) {
              this.retryError = error instanceof Error ? error.message : String(error);
            } finally {
              this.retryPending = false;
              this.render();
              this.contentEl.querySelector<HTMLButtonElement>('button.mod-cta')?.focus();
            }
          }));
    }

    if (model.reports.length > 0) {
      new Setting(contentEl)
        .setName('Conflict choices are read-only')
        .setDesc('Baseline, local, remote, and version evidence is retained. Run sync again for a fresh remote read; no conflict choice replays an old payload.');
    }

    if (model.retryableOperations.length === 0) {
      contentEl.createEl('p', { text: 'No failed or conflicted sync operations are currently retained in the retry queue.' });
    }

    for (const [service, bucket] of Object.entries(model.byService)) {
      contentEl.createEl('h3', { text: service });
      contentEl.createEl('p', { text: `${bucket.conflicted} conflicted, ${bucket.failed} failed, ${bucket.retryable} retryable.` });
    }

    for (const report of model.reports) {
      const section = contentEl.createDiv({ cls: 'task-manager-sync-conflict-report' });
      section.createEl('h4', { text: `${report.service}: ${report.taskKey}` });
      if (report.operationId) section.createEl('p', { text: `Operation: ${report.operationType ?? 'unknown'} ${report.operationId}` });
      for (const conflict of report.conflicts) {
        section.createEl('p', { text: `${conflict.field}: vault=${String(conflict.vaultValue)} service=${String(conflict.serviceValue)}` });
      }
    }

    for (const op of model.failedOperations) {
      const section = contentEl.createDiv({ cls: 'task-manager-sync-failed-operation' });
      section.createEl('h4', { text: `${op.service}: failed ${op.type}` });
      section.createEl('p', { text: `${op.vaultTask.key}${op.externalId ? ` (${op.externalId})` : ''}` });
      if (op.error) section.createEl('p', { text: op.error });
    }
  }
}
