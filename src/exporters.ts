/**
 * Query Result Export Formatters
 *
 * Export task query results in multiple formats:
 * - JSON: array of task objects with all metadata
 * - YAML: YAML-formatted task list
 */

import { encodeCsvCell } from './csv-utils';
import { normalizeVaultRelativePath } from './vault-utils';
import type { ParsedTask } from './task-scanner';
import type { TaskMetadata } from './task-model';

export function ensureExportPathExtension(rawPath: string | undefined, fallbackPath: string, extension: string): string {
  const requiredExtension = extension.startsWith('.') ? extension : `.${extension}`;
  const trimmed = rawPath?.trim() || fallbackPath;
  const candidate = trimmed.endsWith('/') ? `${trimmed}${fallbackPath.split('/').pop() ?? fallbackPath}` : trimmed;
  const withExtension = candidate.toLowerCase().endsWith(requiredExtension.toLowerCase()) ? candidate : `${candidate}${requiredExtension}`;
  return normalizeVaultRelativePath(withExtension, 'Export path');
}

export interface ExportedTask {
  /** Task checkbox state (space, x, /, !, ?, >, -) */
  status: string;
  /** Task description */
  description: string;
  /** Source file path */
  filePath: string;
  /** Line number in source file */
  lineNumber: number;
  /** Tags */
  tags?: string[];
  /** Parent heading */
  heading?: string;
  /** Complete canonical metadata for lossless interchange. */
  metadata: TaskMetadata;
  /** Original raw markdown line */
  rawLine: string;
}

/**
 * Convert ParsedTask to ExportedTask format
 */
function parseTaskToExported(task: ParsedTask): ExportedTask {
  return {
    status: task.checkbox,
    description: task.body,
    filePath: task.filePath,
    lineNumber: task.lineNumber,
    tags: task.tags.length > 0 ? task.tags : undefined,
    heading: task.heading,
    metadata: task.metadata,
    rawLine: task.rawLine,
  };
}

/**
 * Export tasks as JSON array
 * @param tasks Array of ParsedTask objects to export
 * @returns JSON string (pretty-printed)
 */
export function exportTasksAsJSON(tasks: ParsedTask[]): string {
  const exported = tasks.map(parseTaskToExported);
  return JSON.stringify(exported, null, 2);
}

/**
 * Export tasks as YAML list
 * @param tasks Array of ParsedTask objects to export
 * @returns YAML-formatted string
 */
export function exportTasksAsYAML(tasks: ParsedTask[]): string {
  return tasks.flatMap((task) => renderYamlObject({ ...parseTaskToExported(task) }, 0, true).concat('')).join('\n');
}

function renderYamlObject(value: Record<string, unknown>, indent: number, listItem = false): string[] {
  const lines: string[] = [];
  let first = true;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const prefix = first && listItem ? `${' '.repeat(indent)}- ` : ' '.repeat(indent + (listItem ? 2 : 0));
    first = false;
    if (Array.isArray(item)) {
      lines.push(`${prefix}${key}: [${item.map((entry) => `"${escapeYAML(String(entry))}"`).join(', ')}]`);
    } else if (item !== null && typeof item === 'object') {
      lines.push(`${prefix}${key}:`);
      lines.push(...renderYamlObject(item as Record<string, unknown>, indent + (listItem ? 4 : 2)));
    } else if (typeof item === 'number' || typeof item === 'boolean') {
      lines.push(`${prefix}${key}: ${String(item)}`);
    } else if (typeof item === 'string') {
      lines.push(`${prefix}${key}: "${escapeYAML(item)}"`);
    }
  }
  return lines;
}

/**
 * Escape special characters in YAML string values
 */
function escapeYAML(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Generate RFC 4180 compliant CSV export
 * @param tasks Array of ParsedTask objects to export
 * @returns CSV-formatted string
 */
export function exportTasksAsCSV(tasks: ParsedTask[]): string {
  const headers = [
    'status',
    'description',
    'priority',
    'due',
    'scheduled',
    'start',
    'done',
    'created',
    'cancelled',
    'tags',
    'id',
    'effort',
    'actual',
    'cost',
    'file',
    'line',
  ];

  const lines: string[] = [headers.map(encodeCsvCell).join(',')];

  for (const task of tasks) {
    const priorityStr = typeof task.metadata.priority === 'string' ? task.metadata.priority : 'normal';
    const row = [
      encodeCsvCell(task.checkbox),
      encodeCsvCell(task.body),
      encodeCsvCell(priorityStr),
      encodeCsvCell(task.metadata.dates.due ?? ''),
      encodeCsvCell(task.metadata.dates.scheduled ?? ''),
      encodeCsvCell(task.metadata.dates.start ?? ''),
      encodeCsvCell(task.metadata.dates.done ?? ''),
      encodeCsvCell(task.metadata.dates.created ?? ''),
      encodeCsvCell(task.metadata.dates.cancelled ?? ''),
      encodeCsvCell(task.tags.join(';')),
      encodeCsvCell(task.metadata.id ?? ''),
      encodeCsvCell(task.metadata.effort ?? ''),
      encodeCsvCell(task.metadata.actual ?? ''),
      encodeCsvCell(task.metadata.cost ?? ''),
      encodeCsvCell(task.filePath),
      encodeCsvCell(String(task.lineNumber)),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\r\n'); // RFC 4180 uses CRLF
}

/**
 * Download tasks as file (browser/Electron environment)
 * @param tasks Array of tasks to export
 * @param format Export format: 'json' | 'yaml' | 'csv'
 * @param filename Output filename
 */
export function downloadTasksAsFile(
  tasks: ParsedTask[],
  format: 'json' | 'yaml' | 'csv',
  filename: string,
): void {
  let content: string;
  let mimeType: string;

  switch (format) {
    case 'json': {
      content = exportTasksAsJSON(tasks);
      mimeType = 'application/json';
      break;
    }
    case 'yaml': {
      content = exportTasksAsYAML(tasks);
      mimeType = 'application/x-yaml';
      break;
    }
    case 'csv': {
      content = exportTasksAsCSV(tasks);
      mimeType = 'text/csv';
      break;
    }
    default: {
      throw new Error(`Unknown export format: ${String(format)}`);
    }
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export tasks as an ICS (iCalendar) feed.
 *
 * Each task with a due, scheduled, or start date is emitted as a VTODO component.
 * Tasks without any date field are included as undated VTODOs so they still
 * appear in consumers that support undated VTODO items (e.g. DAVx⁵, Fantastical).
 *
 * Reuses `generateVTODO` and `formatCalendarICS` from `caldav-sync.ts` to ensure
 * the ICS output format is identical to what the CalDAV sync uses.
 *
 * @param tasks - Array of ParsedTask objects to export
 * @returns RFC 5545 / iCalendar string
 */
export async function exportToICS(tasks: ParsedTask[]): Promise<string> {
  const { generateVTODO, formatCalendarICS } = await import('./caldav-sync');
  const vtodos = tasks.map((task) => generateVTODO(task)).filter((vtodo): vtodo is string => Boolean(vtodo));
  return formatCalendarICS(vtodos, { method: 'PUBLISH' });
}
