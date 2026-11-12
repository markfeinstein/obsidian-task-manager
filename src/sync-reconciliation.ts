import type { FieldConflict, ReconciliationEvidence, SyncBaselineEvidence } from './sync-contract';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SupportedFieldProjection = Record<string, JsonValue>;

export type FieldReconciliationDecision =
  | 'unchanged'
  | 'establish-baseline'
  | 'outbound'
  | 'inbound'
  | 'advance-baseline'
  | 'conflict';

export interface ReconciledField {
  field: string;
  decision: FieldReconciliationDecision;
  baselineValue?: JsonValue;
  localValue: JsonValue;
  remoteValue?: JsonValue;
  reason?: 'missing-baseline' | 'malformed-baseline' | 'remote-absent' | 'divergent-dual-change';
}

export interface ProjectionReconciliation {
  mode: 'unchanged' | 'establish-baseline' | 'outbound' | 'inbound' | 'bidirectional' | 'advance-baseline' | 'conflict';
  fields: ReconciledField[];
  outbound: SupportedFieldProjection;
  inbound: SupportedFieldProjection;
  conflicts: FieldConflict[];
  /** The common projection after all candidates are successfully applied. Never persist this before that point. */
  nextBaseline?: SupportedFieldProjection;
  evidence: ReconciliationEvidence;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

/** Validate and key-sort a JSON-safe supported-field projection. */
export function canonicalProjection(value: unknown): SupportedFieldProjection | undefined {
  if (!isPlainObject(value) || !Object.values(value).every(isJsonValue)) return undefined;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key] as JsonValue)]));
}

export function canonicalProjectionOrThrow(value: unknown): SupportedFieldProjection {
  const projection = canonicalProjection(value);
  if (!projection) throw new Error('Projection is not JSON-safe');
  return projection;
}

export function deterministicProjectionJson(value: SupportedFieldProjection): string {
  const canonical = canonicalProjection(value);
  if (!canonical) throw new Error('Projection is not JSON-safe');
  return JSON.stringify(canonical);
}

export function projectionsEqual(left: SupportedFieldProjection, right: SupportedFieldProjection): boolean {
  return deterministicProjectionJson(left) === deterministicProjectionJson(right);
}

export function validBaselineEvidence(value: unknown): value is SyncBaselineEvidence {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || typeof value.recordedAt !== 'number' || !Number.isFinite(value.recordedAt)) return false;
  if (value.remoteVersion !== undefined && typeof value.remoteVersion !== 'string') return false;
  return canonicalProjection(value.projection) !== undefined;
}

export function validReconciliationEvidence(value: unknown): value is ReconciliationEvidence {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || typeof value.capturedAt !== 'number' || !Number.isFinite(value.capturedAt)) return false;
  if (!['unchanged', 'establish-baseline', 'outbound', 'inbound', 'bidirectional', 'advance-baseline', 'conflict'].includes(String(value.mode))) return false;
  if (value.baselineVersion !== undefined && typeof value.baselineVersion !== 'string') return false;
  if (value.remoteVersion !== undefined && typeof value.remoteVersion !== 'string') return false;
  if (value.baseline !== null && canonicalProjection(value.baseline) === undefined) return false;
  if (value.remote !== null && canonicalProjection(value.remote) === undefined) return false;
  return canonicalProjection(value.local) !== undefined;
}

export function createBaselineEvidence(
  projection: SupportedFieldProjection,
  remoteVersion?: string,
  recordedAt = Date.now(),
): SyncBaselineEvidence {
  const canonical = canonicalProjection(projection);
  if (!canonical) throw new Error('Cannot record a non-JSON-safe sync baseline');
  return {
    schemaVersion: 1,
    projection: canonical,
    ...(remoteVersion ? { remoteVersion } : {}),
    recordedAt,
  };
}

function projectionFields(local: SupportedFieldProjection, remote?: SupportedFieldProjection, baseline?: SupportedFieldProjection): string[] {
  return [...new Set([...Object.keys(local), ...Object.keys(remote ?? {}), ...Object.keys(baseline ?? {})])].sort();
}

function valueEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function conflictFor(field: ReconciledField, service: string, detectedAt: number): FieldConflict {
  return {
    field: field.field,
    vaultValue: field.localValue,
    serviceValue: field.remoteValue,
    service,
    detectedAt,
  };
}

/**
 * Pure, fail-closed three-way reconciliation.
 *
 * A missing/malformed baseline, absent remote, or divergent dual edit never produces a
 * write candidate. If any field conflicts the entire task is held and candidate maps are
 * empty. Equal first-run values are the only way to establish a baseline without review.
 */
export function reconcileSupportedProjections(options: {
  service: string;
  local: SupportedFieldProjection;
  remote?: SupportedFieldProjection;
  baseline?: unknown;
  remoteVersion?: string;
  detectedAt?: number;
}): ProjectionReconciliation {
  const detectedAt = options.detectedAt ?? Date.now();
  const local = canonicalProjection(options.local);
  const remote = options.remote === undefined ? undefined : canonicalProjection(options.remote);
  if (!local) throw new Error('Local supported-field projection is malformed');
  if (options.remote !== undefined && !remote) throw new Error('Remote supported-field projection is malformed');

  const baselineProvided = options.baseline !== undefined;
  const baselineEvidence = validBaselineEvidence(options.baseline) ? options.baseline : undefined;
  const baseline = baselineEvidence ? canonicalProjection(baselineEvidence.projection) : undefined;
  const fields = projectionFields(local, remote, baseline);
  const decisions: ReconciledField[] = [];

  if (!remote) {
    for (const field of fields) decisions.push({ field, decision: 'conflict', baselineValue: baseline?.[field], localValue: local[field] ?? null, reason: 'remote-absent' });
  } else if (!baseline) {
    const malformed = baselineProvided;
    for (const field of fields) {
      const localValue = local[field] ?? null;
      const remoteValue = remote[field] ?? null;
      if (!malformed && valueEqual(localValue, remoteValue)) {
        decisions.push({ field, decision: 'establish-baseline', localValue, remoteValue });
      } else {
        decisions.push({ field, decision: 'conflict', localValue, remoteValue, reason: malformed ? 'malformed-baseline' : 'missing-baseline' });
      }
    }
  } else {
    for (const field of fields) {
      const baselineValue = baseline[field] ?? null;
      const localValue = local[field] ?? null;
      const remoteValue = remote[field] ?? null;
      const localChanged = !valueEqual(localValue, baselineValue);
      const remoteChanged = !valueEqual(remoteValue, baselineValue);
      if (!localChanged && !remoteChanged) decisions.push({ field, decision: 'unchanged', baselineValue, localValue, remoteValue });
      else if (localChanged && !remoteChanged) decisions.push({ field, decision: 'outbound', baselineValue, localValue, remoteValue });
      else if (!localChanged && remoteChanged) decisions.push({ field, decision: 'inbound', baselineValue, localValue, remoteValue });
      else if (valueEqual(localValue, remoteValue)) decisions.push({ field, decision: 'advance-baseline', baselineValue, localValue, remoteValue });
      else decisions.push({ field, decision: 'conflict', baselineValue, localValue, remoteValue, reason: 'divergent-dual-change' });
    }
  }

  const conflicts = decisions.filter((field) => field.decision === 'conflict').map((field) => conflictFor(field, options.service, detectedAt));
  let outbound: SupportedFieldProjection = {};
  let inbound: SupportedFieldProjection = {};
  let nextBaseline: SupportedFieldProjection | undefined;
  let mode: ProjectionReconciliation['mode'];

  if (conflicts.length > 0) {
    mode = 'conflict';
  } else {
    outbound = Object.fromEntries(decisions.filter((field) => field.decision === 'outbound').map((field) => [field.field, field.localValue]));
    inbound = Object.fromEntries(decisions.filter((field) => field.decision === 'inbound').map((field) => [field.field, field.remoteValue ?? null]));
    nextBaseline = Object.fromEntries(decisions.map((field) => [field.field,
      field.decision === 'inbound' ? field.remoteValue ?? null : field.localValue,
    ]));
    const hasOutbound = Object.keys(outbound).length > 0;
    const hasInbound = Object.keys(inbound).length > 0;
    if (decisions.some((field) => field.decision === 'establish-baseline')) mode = 'establish-baseline';
    else if (hasOutbound && hasInbound) mode = 'bidirectional';
    else if (hasOutbound) mode = 'outbound';
    else if (hasInbound) mode = 'inbound';
    else if (decisions.some((field) => field.decision === 'advance-baseline')) mode = 'advance-baseline';
    else mode = 'unchanged';
  }

  return {
    mode,
    fields: decisions,
    outbound,
    inbound,
    conflicts,
    nextBaseline,
    evidence: {
      schemaVersion: 1,
      baseline: baseline ?? null,
      local,
      remote: remote ?? null,
      ...(baselineEvidence?.remoteVersion ? { baselineVersion: baselineEvidence.remoteVersion } : {}),
      ...(options.remoteVersion ? { remoteVersion: options.remoteVersion } : {}),
      mode,
      capturedAt: detectedAt,
    },
  };
}
