/**
 * Shared Sync Contract & Operation Queue for External Services
 *
 * Provides:
 * - Unified adapter interface
 * - Stable identity mapping
 * - CRUD operation queue (create/update/delete/reopen)
 * - Dry-run support
 * - Per-field conflict tracking
 * - Adapter capability reporting
 *
 * Active external sync adapters (Todoist, Google Tasks, Microsoft To Do, Apple Reminders, and CalDAV)
 * should implement this contract for consistent behavior and conflict resolution.
 */

import type { MarkdownTask } from './task-model';

/**
 * Adapter capability matrix — what fields each service supports
 */
export interface AdapterCapability {
  /** Service identifier */
  service: string;
  /** Is this service stable or experimental */
  status: 'stable' | 'experimental';
  /** Supported CRUD operations */
  supports: {
    create: boolean;
    update: boolean;
    delete: boolean;
    reopen: boolean;
  };
  /** Field support matrix (field name -> capability level) */
  fields: Record<string, 'native' | 'mapped' | 'unsupported' | 'experimental'>;
  /** Custom notes (for example, a provider-specific reopening limitation). */
  notes?: string;
}

/**
 * Stable identity mapping for a task across services
 * Maps between vault task key and external service IDs
 */
export type JsonSafeValue = string | number | boolean | null | JsonSafeValue[] | { [key: string]: JsonSafeValue };
export type SyncSupportedProjection = Record<string, JsonSafeValue>;

/** Provider-scoped, inspectable evidence for the last verified common state. */
export interface SyncBaselineEvidence {
  schemaVersion: 1;
  projection: SyncSupportedProjection;
  remoteVersion?: string;
  recordedAt: number;
}

/** Durable evidence retained with a failed/conflicted reconciliation. */
export interface ReconciliationEvidence {
  schemaVersion: 1;
  baseline: SyncSupportedProjection | null;
  local: SyncSupportedProjection;
  remote: SyncSupportedProjection | null;
  baselineVersion?: string;
  remoteVersion?: string;
  mode: 'unchanged' | 'establish-baseline' | 'outbound' | 'inbound' | 'bidirectional' | 'advance-baseline' | 'conflict';
  capturedAt: number;
}

export interface StableTaskIdentity {
  /** Vault task key (unique within Obsidian) */
  vaultKey: string;
  /** External service ID mappings { service -> externalId } */
  externalIds: Record<string, string>;
  /** Provider-scoped verified projections. Legacy hashes never populate this field. */
  baselines?: Record<string, SyncBaselineEvidence>;
  /** Provider names whose persisted baseline evidence was malformed; forces fail-closed reconciliation. */
  invalidBaselines?: string[];
  /** Legacy hash retained for compatibility only; it is not trusted as reconciliation evidence. */
  lastSyncedHash?: string;
  /** Legacy per-field hashes retained for compatibility only. */
  fieldHashes?: Record<string, string>;
  /** When this mapping was created */
  createdAt: number;
  /** When this mapping was last updated */
  updatedAt: number;
}

/**
 * Per-field conflict record
 */
export interface FieldConflict {
  /** Field name (e.g., "title", "due", "status", "priority") */
  field: string;
  /** Value in vault */
  vaultValue: unknown;
  /** Value in service */
  serviceValue: unknown;
  /** Service name that provided the conflict */
  service: string;
  /** When conflict was detected */
  detectedAt: number;
  /** Previous conflict (for history) */
  previousConflict?: FieldConflict;
}

/**
 * Sync operation to queue and execute
 */
export interface SyncOperation {
  /** Unique operation ID */
  id: string;
  /** Operation type */
  type: 'create' | 'update' | 'delete' | 'reopen';
  /** Target service */
  service: string;
  /** Vault task being synced */
  vaultTask: MarkdownTask;
  /** External ID (if updating/deleting existing task) */
  externalId?: string;
  /** Fields being synced (for partial updates) */
  fields?: string[];
  /** Payload for the operation */
  payload: Record<string, unknown>;
  /** When operation was queued */
  queuedAt: number;
  /** Execution status */
  status: 'queued' | 'executing' | 'success' | 'conflict' | 'failed';
  /** Result from service (if executed) */
  result?: {
    externalId: string;
    hash: string;
  };
  /** Error message (if failed or conflicted) */
  error?: string;
  /** Detected conflicts during operation */
  conflicts?: FieldConflict[];
  /** Dry-run: don't actually execute */
  dryRun?: boolean;
  /** Stable client operation key retained across explicit retries. */
  idempotencyKey?: string;
  /** Read-first evidence used to produce this operation. Required for safe reconciliation review. */
  reconciliation?: ReconciliationEvidence;
  /** Number of execution attempts already made. */
  attempts?: number;
  /** Earliest timestamp at which an automatic retry may run. */
  nextAttemptAt?: number;
}

/**
 * Dry-run output preview
 */
export interface DryRunOutput {
  /** Total operations to execute */
  totalOperations: number;
  /** Operations by type */
  byType: Record<'create' | 'update' | 'delete' | 'reopen', number>;
  /** Operations by service */
  byService: Record<string, number>;
  /** Potential conflicts (field-level) */
  potentialConflicts: FieldConflict[];
  /** Warnings about field compatibility */
  fieldWarnings: Array<{
    field: string;
    service: string;
    level: 'warning' | 'error';
    message: string;
  }>;
  /** Operations detail (for preview) */
  operations: Array<{
    id: string;
    type: string;
    service: string;
    vaultTaskKey: string;
    externalId?: string;
    preview: string;
  }>;
  /** Estimated duration in ms */
  estimatedDurationMs?: number;
}

/**
 * Base interface all sync adapters must implement
 */
export interface SyncAdapter {
  /**
   * Get adapter capabilities
   */
  getCapabilities(): AdapterCapability;

  /**
   * Check if adapter is properly configured
   */
  isConfigured(): Promise<boolean>;

  /**
   * Convert vault task to service-specific payload
   */
  toServicePayload(task: MarkdownTask, fields?: string[]): Record<string, unknown>;

  /**
   * Convert service task to vault markdown
   */
  fromServicePayload(payload: Record<string, unknown>, vaultPath: string): MarkdownTask;

  /**
   * Create task in service
   */
  create(payload: Record<string, unknown>, dryRun?: boolean): Promise<{
    externalId: string;
    hash: string;
  }>;

  /**
   * Update task in service
   */
  update(externalId: string, payload: Record<string, unknown>, dryRun?: boolean, expectedVersion?: string): Promise<{
    hash: string;
    conflicts?: FieldConflict[];
    /** Canonical full projection returned by the provider, when available for post-verification. */
    projection?: SyncSupportedProjection;
    remoteVersion?: string;
  }>;

  /**
   * Delete task from service
   */
  delete(externalId: string, dryRun?: boolean, expectedVersion?: string): Promise<void>;

  /**
   * Reopen (uncomplete) task in service
   */
  reopen(externalId: string, dryRun?: boolean, expectedVersion?: string): Promise<void>;

  /**
   * Fetch all tasks from service (for reconciliation)
   */
  fetchAll(): Promise<Array<{
    externalId: string;
    payload: Record<string, unknown>;
    hash: string;
  }>>;

  /**
   * Test connection to service
   */
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Sync conflict strategy
 */
export type SyncConflictStrategy = 'vault-first' | 'service-first' | 'manual';

/**
 * Identity mapper state for persistence
 */
export interface IdentityMapperState {
  /** Task identity mappings */
  identities: StableTaskIdentity[];
  /** Version for backward compatibility */
  version: number;
}

/**
 * Operation queue state for persistence
 */
export interface OperationQueueState {
  /** Pending operations */
  operations: SyncOperation[];
  /** Completed operations (for history) */
  completed: Array<SyncOperation & { completedAt: number }>;
  /** Version for backward compatibility */
  version: number;
}

/**
 * Sync conflict report for logging
 */
export interface SyncConflictReport {
  /** Task key */
  taskKey: string;
  /** Service involved */
  service: string;
  /** Per-field conflicts */
  conflicts: FieldConflict[];
  /** Resolution strategy used */
  strategy: SyncConflictStrategy;
  /** When report was generated */
  timestamp: number;
}

/**
 * Sync execution result
 */
export interface SyncExecutionResult {
  /** Total operations executed */
  total: number;
  /** Operations by type */
  created: number;
  updated: number;
  deleted: number;
  reopened: number;
  /** Failed operations */
  failed: number;
  /** Conflicts detected */
  conflicts: SyncConflictReport[];
  /** Field-level incompatibilities encountered */
  fieldIncompatibilities: Array<{
    field: string;
    service: string;
    reason: string;
  }>;
  /** Execution start time */
  startedAt: number;
  /** Execution end time */
  completedAt: number;
  /** Duration in ms */
  durationMs: number;
}
