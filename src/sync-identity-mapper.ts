/**
 * Stable Identity Mapping for Sync Operations
 *
 * Maintains persistent, stable mappings between vault task keys and external service IDs.
 * Handles edge cases like:
 * - Task moved between files
 * - Task deleted and recreated with same content
 * - Syncing same task to multiple services
 */

import type { StableTaskIdentity, IdentityMapperState, SyncBaselineEvidence, SyncSupportedProjection } from './sync-contract';
import { canonicalProjection, createBaselineEvidence, validBaselineEvidence } from './sync-reconciliation';

/**
 * Hash content for conflict detection
 */
function hashContent(content: string): string {
  // Simple hash using character sum (in production use crypto.subtle.digest)
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(16);
}

function hashFieldValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return hashContent(String(value));
  }
  return hashContent(JSON.stringify(value) ?? '');
}

/**
 * Manages stable identity mappings for tasks across services
 */
export class IdentityMapper {
  private identities: Map<string, StableTaskIdentity> = new Map();
  private externalIdIndex: Map<string, string> = new Map(); // service:externalId -> vaultKey
  private serviceIndex: Map<string, Set<string>> = new Map(); // service -> Set<vaultKey>
  private state: IdentityMapperState;

  constructor(initialState?: IdentityMapperState) {
    this.state = this.migrateState(initialState);
    this.loadState();
  }

  /** v1 hashes are retained for compatibility, but never promoted to trusted baseline evidence. */
  private migrateState(initialState?: IdentityMapperState): IdentityMapperState {
    const identities = Array.isArray(initialState?.identities) ? initialState.identities : [];
    return {
      version: 2,
      identities: identities.map((identity) => {
        const baselineEntries = identity.baselines && typeof identity.baselines === 'object' ? Object.entries(identity.baselines) : [];
        const baselines = Object.fromEntries(baselineEntries.filter((entry): entry is [string, SyncBaselineEvidence] => validBaselineEvidence(entry[1])));
        const invalidBaselines = [...new Set([
          ...(Array.isArray(identity.invalidBaselines) ? identity.invalidBaselines.filter((service): service is string => typeof service === 'string') : []),
          ...baselineEntries.filter(([, evidence]) => !validBaselineEvidence(evidence)).map(([service]) => service),
        ])].sort();
        return {
          ...identity,
          ...(Object.keys(baselines).length > 0 ? { baselines } : { baselines: undefined }),
          ...(invalidBaselines.length > 0 ? { invalidBaselines } : { invalidBaselines: undefined }),
        };
      }),
    };
  }

  /**
   * Load identities from state
   */
  private loadState(): void {
    this.identities.clear();
    this.externalIdIndex.clear();
    this.serviceIndex.clear();

    for (const identity of this.state.identities) {
      this.identities.set(identity.vaultKey, identity);

      // Build reverse index for external IDs
      for (const [service, externalId] of Object.entries(identity.externalIds)) {
        this.externalIdIndex.set(`${service}:${externalId}`, identity.vaultKey);
        let serviceSet = this.serviceIndex.get(service);
        if (!serviceSet) {
          serviceSet = new Set();
          this.serviceIndex.set(service, serviceSet);
        }
        serviceSet.add(identity.vaultKey);
      }
    }
  }

  /**
   * Get or create identity for a vault task
   */
  getOrCreateIdentity(vaultKey: string): StableTaskIdentity {
    let identity = this.identities.get(vaultKey);

    if (!identity) {
      identity = {
        vaultKey,
        externalIds: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.identities.set(vaultKey, identity);
    }

    return identity;
  }

  /**
   * Map external ID to vault task
   */
  mapExternalId(vaultKey: string, service: string, externalId: string): void {
    const identity = this.getOrCreateIdentity(vaultKey);

    const previousVaultKey = this.externalIdIndex.get(`${service}:${externalId}`);
    if (previousVaultKey && previousVaultKey !== vaultKey) {
      const previousIdentity = this.identities.get(previousVaultKey);
      if (previousIdentity?.externalIds[service] === externalId) {
        delete previousIdentity.externalIds[service];
        this.serviceIndex.get(service)?.delete(previousVaultKey);
        previousIdentity.updatedAt = Date.now();
      }
    }

    // Clean up old reverse mapping if changing
    const oldExternalId = identity.externalIds[service];
    if (oldExternalId) {
      this.externalIdIndex.delete(`${service}:${oldExternalId}`);
    }

    // Add new mapping
    identity.externalIds[service] = externalId;
    this.externalIdIndex.set(`${service}:${externalId}`, vaultKey);
    let serviceSet = this.serviceIndex.get(service);
    if (!serviceSet) {
      serviceSet = new Set();
      this.serviceIndex.set(service, serviceSet);
    }
    serviceSet.add(vaultKey);
    identity.updatedAt = Date.now();
  }

  /**
   * Look up vault key by external ID
   */
  lookupByExternalId(service: string, externalId: string): string | undefined {
    return this.externalIdIndex.get(`${service}:${externalId}`);
  }

  /**
   * Get external ID for task on specific service
   */
  getExternalId(vaultKey: string, service: string): string | undefined {
    const identity = this.identities.get(vaultKey);
    return identity?.externalIds[service];
  }

  /**
   * Record content hash for conflict detection
   */
  recordContentHash(vaultKey: string, content: string): void {
    const identity = this.getOrCreateIdentity(vaultKey);
    identity.lastSyncedHash = hashContent(content);
    identity.updatedAt = Date.now();
  }

  /**
   * Record per-field hash for granular conflict detection
   */
  recordFieldHash(vaultKey: string, field: string, value: unknown): void {
    const identity = this.getOrCreateIdentity(vaultKey);

    if (!identity.fieldHashes) {
      identity.fieldHashes = {};
    }

    identity.fieldHashes[field] = hashFieldValue(value);
    identity.updatedAt = Date.now();
  }

  /** Get verified provider-scoped baseline evidence. Malformed evidence is treated as absent. */
  getBaseline(vaultKey: string, service: string): SyncBaselineEvidence | { malformed: true } | undefined {
    const identity = this.identities.get(vaultKey);
    if (identity?.invalidBaselines?.includes(service)) return { malformed: true };
    const baseline = identity?.baselines?.[service];
    if (!validBaselineEvidence(baseline)) return undefined;
    const projection = canonicalProjection(baseline.projection);
    return projection ? { ...baseline, projection } : undefined;
  }

  /** Record a baseline only after both sides are known to share the canonical projection. */
  recordBaseline(vaultKey: string, service: string, projection: SyncSupportedProjection, remoteVersion?: string, recordedAt = Date.now()): void {
    const identity = this.getOrCreateIdentity(vaultKey);
    identity.baselines ??= {};
    identity.baselines[service] = createBaselineEvidence(projection, remoteVersion, recordedAt);
    if (identity.invalidBaselines) {
      identity.invalidBaselines = identity.invalidBaselines.filter((candidate) => candidate !== service);
      if (identity.invalidBaselines.length === 0) delete identity.invalidBaselines;
    }
    identity.updatedAt = recordedAt;
  }

  clearBaseline(vaultKey: string, service: string): void {
    const identity = this.identities.get(vaultKey);
    if (!identity) return;
    if (identity.invalidBaselines) {
      identity.invalidBaselines = identity.invalidBaselines.filter((candidate) => candidate !== service);
      if (identity.invalidBaselines.length === 0) delete identity.invalidBaselines;
    }
    if (!identity.baselines?.[service]) return;
    delete identity.baselines[service];
    if (Object.keys(identity.baselines).length === 0) delete identity.baselines;
    identity.updatedAt = Date.now();
  }

  /**
   * Check whether a legacy baseline content hash has been recorded for this task.
   */
  hasContentHash(vaultKey: string): boolean {
    return Boolean(this.identities.get(vaultKey)?.lastSyncedHash);
  }

  /**
   * Check if content changed since last sync (conflict detection)
   */
  hasContentChanged(vaultKey: string, newContent: string): boolean {
    const identity = this.identities.get(vaultKey);
    if (!identity?.lastSyncedHash) {
      return false; // First sync
    }

    const newHash = hashContent(newContent);
    return newHash !== identity.lastSyncedHash;
  }

  /**
   * Check if field changed since last sync
   */
  hasFieldChanged(vaultKey: string, field: string, value: unknown): boolean {
    const identity = this.identities.get(vaultKey);
    if (!identity?.fieldHashes?.[field]) {
      return false; // First sync of this field
    }

    const newHash = hashFieldValue(value);
    return newHash !== identity.fieldHashes[field];
  }

  /**
   * Remove identity (task was deleted)
   */
  removeIdentity(vaultKey: string): void {
    const identity = this.identities.get(vaultKey);

    if (identity) {
      // Clean up reverse index
      for (const [service, externalId] of Object.entries(identity.externalIds)) {
        this.externalIdIndex.delete(`${service}:${externalId}`);
        const serviceSet = this.serviceIndex.get(service);
        if (serviceSet) {
          serviceSet.delete(vaultKey);
          if (serviceSet.size === 0) {
            this.serviceIndex.delete(service);
          }
        }
      }

      this.identities.delete(vaultKey);
    }
  }

  /**
   * Remove external ID (task was deleted from service)
   */
  removeExternalId(service: string, externalId: string): void {
    const vaultKey = this.lookupByExternalId(service, externalId);

    if (vaultKey) {
      const identity = this.identities.get(vaultKey);
      if (identity) {
        delete identity.externalIds[service];
        identity.updatedAt = Date.now();
        this.externalIdIndex.delete(`${service}:${externalId}`);
        const serviceSet = this.serviceIndex.get(service);
        if (serviceSet) {
          serviceSet.delete(vaultKey);
          if (serviceSet.size === 0) {
            this.serviceIndex.delete(service);
          }
        }
      }
    }
  }

  /**
   * Migrate identity (e.g., vault task moved to new file)
   */
  migrateIdentity(oldVaultKey: string, newVaultKey: string): void {
    const identity = this.identities.get(oldVaultKey);

    if (identity) {
      identity.vaultKey = newVaultKey;
      identity.updatedAt = Date.now();
      this.identities.delete(oldVaultKey);
      this.identities.set(newVaultKey, identity);

      // Keep reverse lookups coherent after file renames or ID-based key migrations.
      for (const [service, externalId] of Object.entries(identity.externalIds)) {
        this.externalIdIndex.set(`${service}:${externalId}`, newVaultKey);
        const serviceSet = this.serviceIndex.get(service);
        if (serviceSet) {
          serviceSet.delete(oldVaultKey);
          serviceSet.add(newVaultKey);
        }
      }
    }
  }

  /**
   * Get all identities with external IDs on specific service
   */
  getIdentitiesByService(service: string): StableTaskIdentity[] {
    const vaultKeys = this.serviceIndex.get(service);
    if (!vaultKeys) {
      return [];
    }
    return Array.from(vaultKeys)
      .map((vaultKey) => this.identities.get(vaultKey))
      .filter((id): id is StableTaskIdentity => id !== undefined);
  }

  /**
   * Get current state for persistence
   */
  getState(): IdentityMapperState {
    return {
      identities: Array.from(this.identities.values()),
      version: 2,
    };
  }

  /**
   * Load state from persistence
   */
  loadStateFromPersistence(state: IdentityMapperState): void {
    this.state = this.migrateState(state);
    this.loadState();
  }

  /**
   * Clear all mappings (use with caution!)
   */
  clear(): void {
    this.identities.clear();
    this.externalIdIndex.clear();
    this.serviceIndex.clear();
    this.state.identities = [];
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalIdentities: number;
    servicesCovered: Set<string>;
    identitiesPerService: Record<string, number>;
  } {
    const servicesCovered = new Set<string>();
    const identitiesPerService: Record<string, number> = {};

    for (const identity of this.identities.values()) {
      for (const service of Object.keys(identity.externalIds)) {
        servicesCovered.add(service);
        identitiesPerService[service] = (identitiesPerService[service] ?? 0) + 1;
      }
    }

    return {
      totalIdentities: this.identities.size,
      servicesCovered,
      identitiesPerService,
    };
  }
}
