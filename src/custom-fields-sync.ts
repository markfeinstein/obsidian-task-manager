/**
 * Custom Field Support with Frontmatter Sync
 *
 * Enables users to define custom task metadata fields (e.g., [client:: Acme Corp])
 * with optional bidirectional sync to file frontmatter properties.
 *
 * Sync modes:
 * - 'none': only parse from markdown, don't sync to frontmatter
 * - 'read': parse from markdown and frontmatter (frontmatter overrides markdown)
 * - 'write': parse from markdown, sync updates back to frontmatter on task change
 * - 'bidirectional': sync both directions
 */


export interface CustomFieldDefinition {
  /** Field key identifier, e.g., 'client', 'department', 'budget' */
  key: string;
  /** Display name, e.g., "Client", "Department", "Budget" */
  name: string;
  /** Field type: 'text', 'number', 'select', 'date', 'tags' */
  type: 'text' | 'number' | 'select' | 'date' | 'tags';
  /** For 'select' type: list of allowed values */
  options?: string[];
  /** Optional frontmatter property name (if different from key) */
  frontmatterKey?: string;
  /** Sync mode for this field */
  syncMode?: 'none' | 'read' | 'write' | 'bidirectional';
  /** Whether field is searchable in queries */
  searchable?: boolean;
}

export interface CustomFieldValue {
  key: string;
  value: string | number | boolean | string[] | undefined;
  source: 'markdown' | 'frontmatter';
}

export interface CustomFieldsMap {
  [key: string]: CustomFieldValue | undefined;
}

export interface DataviewInlineField {
  key: string;
  value: string;
}

// Match Dataview inline fields in bracket or parenthesis form. Bracket fields need
// to treat Obsidian wikilinks as part of the value so `[due:: [[2026-06-15]]]`
// does not stop at the first `]` inside the link. The wikilink pattern uses a
// non-greedy match to handle nested brackets in display text like `[[page|text [x] here]]`.
const DATAVIEW_INLINE_FIELD_PATTERN = /(?:\[([A-Za-z_][A-Za-z0-9 _-]*)::\s*((?:\[\[[\s\S]*?\]\]|[^\]\r\n])*)\])|(?:\(([A-Za-z_][A-Za-z0-9 _-]*)::\s*([^)\r\n]*)\))/gu;

export function parseDataviewInlineFields(text: string): DataviewInlineField[] {
  return Array.from(text.matchAll(DATAVIEW_INLINE_FIELD_PATTERN), (match) => ({
    key: (match[1] ?? match[3] ?? '').trim(),
    value: (match[2] ?? match[4] ?? '').trim(),
  })).filter((field) => field.key.length > 0);
}

export function stripDataviewInlineFields(text: string): string {
  return text.replace(DATAVIEW_INLINE_FIELD_PATTERN, ' ');
}

/**
 * Parse custom fields from markdown task line using Dataview inline field syntax
 * Formats supported:
 *   [key:: value]
 *   (key:: value)
 *   key:: value (in parentheses or brackets)
 */
export function parseCustomFieldsFromMarkdown(
  taskLine: string,
  fieldDefs: CustomFieldDefinition[],
): CustomFieldsMap {
  const fields: CustomFieldsMap = {};
  const keys = new Set(fieldDefs.map((f) => f.key.toLowerCase()));

  for (const field of parseDataviewInlineFields(taskLine)) {
    const fieldKey = field.key.toLowerCase();
    if (keys.has(fieldKey)) {
      fields[fieldKey] = {
        key: fieldKey,
        value: parseFieldValue(field.value, fieldDefs.find((f) => f.key.toLowerCase() === fieldKey)),
        source: 'markdown',
      };
    }
  }

  return fields;
}

/**
 * Parse custom fields from file frontmatter
 */
export function parseCustomFieldsFromFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
  fieldDefs: CustomFieldDefinition[],
): CustomFieldsMap {
  const fields: CustomFieldsMap = {};
  if (!frontmatter) return fields;

  for (const fieldDef of fieldDefs) {
    const frontmatterKey = fieldDef.frontmatterKey || fieldDef.key;
    if (frontmatterKey in frontmatter) {
      const value = frontmatter[frontmatterKey];
      fields[fieldDef.key.toLowerCase()] = {
        key: fieldDef.key.toLowerCase(),
        value: normalizeFieldValue(value, fieldDef),
        source: 'frontmatter',
      };
    }
  }

  return fields;
}

/**
 * Merge fields from markdown and frontmatter based on sync mode
 */
export function mergeCustomFields(
  markdownFields: CustomFieldsMap,
  frontmatterFields: CustomFieldsMap,
  fieldDefs: CustomFieldDefinition[],
): CustomFieldsMap {
  const merged: CustomFieldsMap = { ...markdownFields };

  for (const fieldDef of fieldDefs) {
    const key = fieldDef.key.toLowerCase();
    const syncMode = fieldDef.syncMode ?? 'read';

    if (syncMode === 'none' || syncMode === 'write') {
      // Use markdown only
      continue;
    }

    if ((syncMode === 'read' || syncMode === 'bidirectional') && frontmatterFields[key]?.value !== undefined) {
      // Frontmatter overrides markdown for read/bidirectional.
      // Guard against null-valued frontmatter entries (value === undefined after normalizeFieldValue)
      // to avoid clobbering a valid markdown value with an undefined-valued frontmatter entry.
      merged[key] = frontmatterFields[key];
    }
  }

  return merged;
}

/**
 * Serialize custom fields to markdown inline field syntax
 */
export function serializeCustomFieldsToMarkdown(fields: CustomFieldsMap): string {
  const parts: string[] = [];
  for (const field of Object.values(fields)) {
    if (field && field.value !== undefined) {
      parts.push(` [${field.key}:: ${formatFieldValue(field.value)}]`);
    }
  }
  return parts.join('');
}

/**
 * Validate field value against field definition
 */
export function validateCustomField(value: unknown, fieldDef: CustomFieldDefinition): boolean {
  if (value === undefined || value === null || value === '') return true;

  if (fieldDef.type === 'text') return typeof value === 'string';
  if (fieldDef.type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const sv = String(value).trim();
    return parseStrictNumber(sv) !== undefined;
  }
  if (fieldDef.type === 'date') {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const sv = typeof value === 'string' ? value : String(value);
    return isStrictIsoDate(sv);
  }
  if (fieldDef.type === 'select') {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const sv = typeof value === 'string' ? value : String(value);
    return !fieldDef.options?.length || fieldDef.options.includes(sv);
  }
  if (fieldDef.type === 'tags') return Array.isArray(value) || typeof value === 'string';

  return false;
}

/**
 * Parse raw field value based on field type
 */
function parseFieldValue(value: string, fieldDef: CustomFieldDefinition | undefined): string | number | boolean | string[] | undefined {
  if (!fieldDef || !value) return value;

  switch (fieldDef.type) {
    case 'number': {
      return parseStrictNumber(value.trim());
    }
    case 'tags': {
      // Support comma-separated or tag-style values
      return value.split(/,|\s+/).filter(Boolean);
    }
    case 'date': {
      // Validate exact ISO date format YYYY-MM-DD and reject impossible calendar dates.
      return isStrictIsoDate(value) ? value : undefined;
    }
    case 'select': {
      const trimmed = value.trim();
      return !fieldDef.options?.length || fieldDef.options.includes(trimmed) ? trimmed : undefined;
    }
    default:
      return value;
  }
}

/**
 * Normalize frontmatter value to field type
 */
function normalizeFieldValue(value: unknown, fieldDef: CustomFieldDefinition): string | number | boolean | string[] | undefined {
  if (value === undefined || value === null) return undefined;

  if (fieldDef.type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return parseStrictNumber(String(value).trim());
  }

  if (fieldDef.type === 'date') {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const dateValue = typeof value === 'string' ? value : String(value);
    return isStrictIsoDate(dateValue) ? dateValue : undefined;
  }

  if (fieldDef.type === 'tags' && Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }

  if (fieldDef.type === 'tags' && typeof value === 'string') {
    return value.split(/,|\s+/).filter(Boolean);
  }

  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const stringValue = typeof value === 'string' ? value : String(value);
  if (fieldDef.type === 'select' && fieldDef.options?.length) {
    return fieldDef.options.includes(stringValue) ? stringValue : undefined;
  }

  return stringValue;
}

/**
 * Format field value for markdown serialization
 */
function formatFieldValue(value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}

function parseStrictNumber(value: string): number | undefined {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isStrictIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/**
 * Build a query predicate for filtering by custom field
 * Example: task.customFields.client === "Acme Corp"
 */
export function buildCustomFieldFilter(
  fieldKey: string,
  operator: '===' | '<' | '>' | '<=' | '>=' | 'includes' | 'startsWith',
  value: string | number,
): (fields: CustomFieldsMap) => boolean {
  const key = fieldKey.toLowerCase();
  return (fields: CustomFieldsMap) => {
    const field = fields[key];
    if (!field || field.value === undefined) return false;

    const fieldValue = field.value;
    switch (operator) {
      case '===':
        // For tags (string[]), check array membership; otherwise strict equality.
        if (Array.isArray(fieldValue)) return fieldValue.map(String).includes(String(value));
        return fieldValue === value;
      case '<': {
        if (typeof fieldValue !== 'number' || typeof value !== 'number') return false;
        return fieldValue < value;
      }
      case '>': {
        if (typeof fieldValue !== 'number' || typeof value !== 'number') return false;
        return fieldValue > value;
      }
      case '<=': {
        if (typeof fieldValue !== 'number' || typeof value !== 'number') return false;
        return fieldValue <= value;
      }
      case '>=': {
        if (typeof fieldValue !== 'number' || typeof value !== 'number') return false;
        return fieldValue >= value;
      }
      case 'includes':
        // For tags (string[]), check array membership; for strings, substring check.
        if (Array.isArray(fieldValue)) return fieldValue.map(String).includes(String(value));
        return typeof fieldValue === 'string' && fieldValue.includes(String(value));
      case 'startsWith':
        // For tags (string[]), check if any element starts with value; for strings, prefix check.
        if (Array.isArray(fieldValue)) return fieldValue.some((v) => String(v).startsWith(String(value)));
        return typeof fieldValue === 'string' && fieldValue.startsWith(String(value));
      default:
        return false;
    }
  };
}

/**
 * Check if a task has any populated custom fields
 */
export function hasCustomFields(fields: CustomFieldsMap): boolean {
  return Object.values(fields).some((f) => f && f.value !== undefined);
}

/**
 * Get all custom field keys with non-empty values
 */
export function getPopulatedFieldKeys(fields: CustomFieldsMap): string[] {
  return Object.entries(fields)
    .filter(([, field]) => field && field.value !== undefined)
    .map(([key]) => key);
}

