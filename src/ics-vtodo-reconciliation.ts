/** Field ownership and a portable, per-object three-way baseline for managed VTODOs. */
const BASELINE = 'X-OBSIDIAN-TASK-MANAGER-BASELINE';
const MANAGED = 'X-OBSIDIAN-TASK-MANAGER-MANAGED';
const FIELDS = new Set(['SUMMARY', 'X-OBSIDIAN-TASK-MANAGER-EMPTY-SUMMARY', 'DUE', 'DTSTART', 'PRIORITY', 'STATUS', 'PERCENT-COMPLETE', 'COMPLETED', 'CATEGORIES', 'RRULE']);

export class VTODOConflictError extends Error {}

interface Property { raw: string; value: string; name: string; depth: number }

function properties(component: string): Property[] {
  const ending = component.includes('\r\n') ? '\r\n' : '\n';
  const groups: string[] = [];
  for (const line of component.split(/\r?\n/u)) {
    if (/^[ \t]/u.test(line) && groups.length) groups[groups.length - 1] += `${ending}${line}`;
    else groups.push(line);
  }
  const stack: string[] = [];
  const result = groups.map((raw) => {
    const value = raw.replace(/\r?\n[ \t]/gu, '');
    const name = value.match(/^([A-Z0-9-]+)[;:]/iu)?.[1]?.toUpperCase() ?? '';
    if (name === 'BEGIN') stack.push(value.slice(6).toUpperCase());
    const property = { raw, value, name, depth: stack.length };
    if (name === 'END' && stack.pop() !== value.slice(4).toUpperCase()) throw new VTODOConflictError('Mismatched VTODO component boundaries');
    return property;
  });
  if (stack.length) throw new VTODOConflictError('Unclosed VTODO component');
  return result;
}

function projection(component: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const property of properties(component)) {
    if (property.depth !== 1 || !FIELDS.has(property.name)) continue;
    if (seen.has(property.name)) throw new VTODOConflictError(`Duplicate managed VTODO property ${property.name}`);
    seen.add(property.name);
    result.push(property.value);
  }
  return result.sort();
}

/** A remote client may change unmanaged data without invalidating the managed-field baseline. */
export function withVTODOBaseline(component: string): string {
  const baseline = `${BASELINE}:${encodeURIComponent(JSON.stringify(projection(component)))}`;
  return component.replace(/^END:VTODO[ \t]*$/imu, `${baseline}\r\nEND:VTODO`);
}

/** Preserve unknown properties, parameters, nested alarms, and their physical line folding. */
export function reconcileVTODO(remote: string, local: string): string {
  const remoteProperties = properties(remote);
  const current = JSON.stringify(projection(remote));
  const desired = JSON.stringify(projection(local));
  const baselines = remoteProperties.filter((property) => property.depth === 1 && property.name === BASELINE);
  if (baselines.length > 1) throw new VTODOConflictError('Duplicate VTODO baseline');
  let baseline: string | undefined;
  if (baselines.length) {
    try {
      const encoded = baselines[0].value.slice(BASELINE.length + 1);
      if (encoded.length > 512_000) throw new Error('Oversized baseline');
      const decoded: unknown = JSON.parse(decodeURIComponent(encoded));
      if (!Array.isArray(decoded) || !decoded.every((value: unknown) => typeof value === 'string')) throw new Error('Invalid baseline');
      baseline = JSON.stringify(decoded);
    } catch { throw new VTODOConflictError('Malformed VTODO baseline; review before adopting this resource'); }
  }
  if (current !== desired && (baseline === undefined || baseline !== current)) {
    throw new VTODOConflictError('CalDAV managed fields changed remotely or have no verified baseline; neither direction may overwrite them');
  }
  if (current === desired && baseline === current) return remote;
  const replacements = new Map(properties(local)
    .filter((property) => property.depth === 1 && (FIELDS.has(property.name) || [BASELINE, MANAGED, 'DTSTAMP'].includes(property.name)))
    .map((property) => [property.name, property.raw]));
  const result: string[] = [];
  for (const property of remoteProperties) {
    if (property.depth === 1 && property.name === 'END') {
      result.push(...replacements.values());
      replacements.clear();
    }
    if (property.depth === 1 && (FIELDS.has(property.name) || [BASELINE, MANAGED, 'DTSTAMP'].includes(property.name))) {
      const replacement = replacements.get(property.name);
      if (replacement !== undefined) result.push(replacement);
      replacements.delete(property.name);
    } else result.push(property.raw);
  }
  return result.join(remote.includes('\r\n') ? '\r\n' : '\n');
}
