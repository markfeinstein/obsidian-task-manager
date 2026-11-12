/**
 * File-Backed Task Note Extensions for TaskScanner
 * Exports functions to detect and parse files as task-notes based on frontmatter.
 */

import { parseYaml, type App, type TFile } from 'obsidian';
import { DEFAULT_TASK_STATES, type TaskStateDefinition } from './types';
import { mergeCustomFields, parseCustomFieldsFromFrontmatter, type CustomFieldDefinition } from './custom-fields-sync';
import { isValidIsoDate } from './date-utils';
import { normalizeVaultRelativePath } from './vault-utils';
import {
  type MarkdownTask,
  type TaskDateField,
  type TaskPriority,
  type TaskMetadata,
  type TaskDateMetadata,
  normalizeRecurrenceRule,
  normalizeTaskText,
  statusFromCheckbox,
  extractTags,
  extractContexts,
  taskKeyForBody,
} from './task-model';

export type ParsedTask = MarkdownTask;

type TaskNoteScanSettings = {
  taskNoteFolders: string;
  taskNoteMarker: string;
  supportedStates?: readonly TaskStateDefinition[];
  customFieldDefinitions?: readonly CustomFieldDefinition[];
};

type InlineTaskScanner = {
  scanFile(file: TFile): Promise<ParsedTask[]>;
};

/**
 * Checks if a file should be treated as a task-note based on:
 * 1. Folder path matching taskNoteFolders
 * 2. Frontmatter marker presence/value
 */
export function parseTaskNoteFrontmatter(content: string): Record<string, unknown> | null {
  const yaml = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u)?.[1];
  if (yaml === undefined) return null;
  try {
    const parsed = parseYaml(yaml) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function isTaskNoteFile(
  file: TFile,
  app: App | undefined,
  taskNoteFolders: string,
  taskNoteMarker: string,
  content?: string,
): boolean {
  // Check folder paths (comma-separated list)
  if (taskNoteFolders.trim()) {
    const folders = taskNoteFolders
      .split(',')
      .map((folder) => {
        try { return normalizeVaultRelativePath(folder, 'Task-note folder').toLowerCase(); }
        catch { return ''; }
      })
      .filter(Boolean);

    const fileFolderPath = (file.parent?.path || '').replace(/\\/gu, '/').toLowerCase();
    for (const folder of folders) {
      if (fileFolderPath === folder || fileFolderPath.startsWith(folder + '/')) {
        return true;
      }
    }
  }

  // Check frontmatter marker. Some unit tests construct a plugin instance
  // without a full Obsidian App; in that case folder matching still works,
  // but frontmatter-based detection must safely fall back to false.
  if (app && taskNoteMarker.trim()) {
    const mc = app.metadataCache as (typeof app.metadataCache & {
      getFileCache?: (f: TFile) => { frontmatter?: Record<string, unknown> } | undefined
    }) | undefined;
    const frontmatter = content === undefined
      ? mc?.getFileCache?.(file)?.frontmatter
      : parseTaskNoteFrontmatter(content);

    if (frontmatter) {
      // Parse "key: value" format (e.g., "task: true" or just "task")
      const [rawKey, ...rest] = taskNoteMarker.split(':');
      const key = rawKey.trim();
      const expectedValue = rest.join(':').trim();

      if (key && key in frontmatter) {
        const actualValue: unknown = frontmatter[key] as unknown;
        if (!expectedValue) {
          // Just check if key exists and is truthy
          return Boolean(actualValue);
        }
        // Check if value matches (case-insensitive comparison)
        return String(actualValue).toLowerCase() === expectedValue.toLowerCase();
      }
    }
  }

  return false;
}

/**
 * Scans a file as a single task-note.
 * Reads frontmatter fields and constructs a ParsedTask with:
 * - filePath pointing to the file
 * - lineNumber set to 0
 * - metadata extracted from frontmatter
 * - body/description from frontmatter.description or first line of file
 * 
 * Supported frontmatter fields:
 *   status, priority, due, scheduled, start, done, created, cancelled,
 *   effort, actual, cost, assignee, reviewer, recurrence, reminder, time,
 *   pinned, id, project, team, description
 */
export async function scanFileWithTaskNotes(
  file: TFile,
  app: App,
  scanner: InlineTaskScanner,
  settings: TaskNoteScanSettings,
): Promise<ParsedTask[]> {
  if (isTaskNoteFile(file, app, settings.taskNoteFolders, settings.taskNoteMarker)) {
    const task = scanFileAsTask(file, app, settings.supportedStates, settings.customFieldDefinitions);
    return task ? [task] : [];
  }
  return scanner.scanFile(file);
}

export function scanFileAsTask(
  file: TFile,
  app: App,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
  customFieldDefinitions: readonly CustomFieldDefinition[] = [],
  content?: string,
): ParsedTask | null {
  const mc = app.metadataCache as (typeof app.metadataCache & {
    getFileCache?: (f: TFile) => { frontmatter?: Record<string, unknown> } | undefined
  }) | undefined;
  const frontmatter = content === undefined
    ? mc?.getFileCache?.(file)?.frontmatter
    : parseTaskNoteFrontmatter(content);

  if (!frontmatter) {
    return null;
  }

  // Get description/body from frontmatter
  const body = String(frontmatter.description || frontmatter.body || '').trim();

  // Parse status from frontmatter (map string to checkbox marker)
  let checkbox = checkboxForFrontmatterStatus('todo', states); // default to todo
  if (frontmatter.status) {
    checkbox = checkboxForFrontmatterStatus(frontmatter.status, states);
  }
  const status = statusFromCheckbox(checkbox, states);

  // Parse priority
  let priority: TaskPriority = 'normal';
  if (frontmatter.priority) {
    const priorityStr = String(frontmatter.priority).toLowerCase().trim();
    if (['highest', 'high', 'medium', 'normal', 'low', 'lowest'].includes(priorityStr)) {
      priority = priorityStr as TaskPriority;
    }
  }

  // Parse date fields
  const dates: TaskDateMetadata = {};
  const dateFields: Array<[string, TaskDateField]> = [
    ['due', 'due'],
    ['scheduled', 'scheduled'],
    ['start', 'start'],
    ['done', 'done'],
    ['created', 'created'],
    ['cancelled', 'cancelled'],
  ];

  for (const [key, field] of dateFields) {
    if (frontmatter[key]) {
      const dateStr = String(frontmatter[key]).trim();
      // Extract YYYY-MM-DD format
      const match = dateStr.match(/\d{4}-\d{2}-\d{2}/u);
      if (match && isValidIsoDate(match[0])) {
        dates[field] = match[0];
      }
    }
  }

  // Parse recurrence
  let recurrence: string | undefined;
  let recurrenceRaw: string | undefined;
  if (frontmatter.recurrence) {
    recurrenceRaw = String(frontmatter.recurrence).trim();
    recurrence = normalizeRecurrenceRule(recurrenceRaw);
  }
  const frontmatterRecord = frontmatter as Record<string, unknown>;
  const onCompletionRaw: unknown = frontmatterRecord.onCompletion ?? frontmatterRecord.on_completion ?? frontmatterRecord['on-completion'];
  const onCompletionText = typeof onCompletionRaw === 'string' || typeof onCompletionRaw === 'number' || typeof onCompletionRaw === 'boolean'
    ? String(onCompletionRaw)
    : '';
  const onCompletion = onCompletionText.trim().toLowerCase().replace(/[\s_]+/gu, '-') || undefined;

  // Parse other metadata fields
  let reminder: string | undefined;
  if (frontmatter.reminder) {
    reminder = String(frontmatter.reminder).trim();
  }

  let time: string | undefined;
  let timeStart: string | undefined;
  let timeEnd: string | undefined;
  if (frontmatter.time) {
    time = String(frontmatter.time).trim();
    const timeMatch = time.match(/^\s*(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?\s*$/u);
    if (timeMatch) {
      timeStart = normalizeClockTime(timeMatch[1]);
      timeEnd = timeMatch[2] ? normalizeClockTime(timeMatch[2]) : undefined;
    }
  }

  let id: string | undefined;
  if (frontmatter.id) {
    id = String(frontmatter.id).trim();
  }

  const pinned = parseFrontmatterBoolean(frontmatter.pinned);

  let effort: string | undefined;
  if (frontmatter.effort) {
    effort = String(frontmatter.effort).trim();
  }

  let actual: string | undefined;
  if (frontmatter.actual) {
    actual = String(frontmatter.actual).trim();
  }

  let cost: number | undefined;
  if (frontmatter.cost !== undefined && frontmatter.cost !== null) {
    const costRaw = String(frontmatter.cost).trim();
    if (/^[-+]?\d+(?:\.\d+)?$/u.test(costRaw)) {
      cost = Number.parseFloat(costRaw);
    }
  }

  let assignee: string | undefined;
  if (frontmatter.assignee) {
    assignee = String(frontmatter.assignee).trim();
  }

  let reviewer: string | undefined;
  if (frontmatter.reviewer) {
    reviewer = String(frontmatter.reviewer).trim();
  }

  let project: string | undefined;
  if (frontmatter.project) {
    project = String(frontmatter.project).trim();
  }

  let team: string | undefined;
  if (frontmatter.team) {
    team = String(frontmatter.team).trim();
  }

  let parentId: string | undefined;
  if (frontmatter.parent_id) {
    parentId = String(frontmatter.parent_id).trim();
  } else if (frontmatter.parentId) {
    parentId = String(frontmatter.parentId).trim();
  }

  const customFields = customFieldDefinitions.length > 0
    ? mergeCustomFields({}, parseCustomFieldsFromFrontmatter(frontmatter, [...customFieldDefinitions]), [...customFieldDefinitions])
    : undefined;

  // Build metadata
  const metadata: TaskMetadata = {
    dates,
    invalidDates: {},
    priority,
    recurrence,
    recurrenceRaw,
    id,
    dependsOn: [],
    onCompletion: onCompletion || undefined,
    reminder,
    time,
    timeStart,
    timeEnd,
    effort,
    actual,
    pinned,
    cost,
    assignee,
    reviewer,
    project,
    team,
    parentId,
    customFields,
  };

  // Extract tags and contexts from body
  const tags = extractTags(body);
  const contexts = extractContexts(body);

  // Create the ParsedTask
  const key = metadata.id ? taskKeyForBody(file.path, body || file.basename, metadata) : `${file.path}:${file.basename}`;
  const rawLine = `- [${checkbox}] ${body}`;

  const parsedTask: ParsedTask = {
    key,
    stableKey: metadata.id ? key : undefined,
    filePath: file.path,
    lineNumber: 0, // File-backed tasks have lineNumber 0
    rawLine,
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox,
    body,
    normalizedText: normalizeTaskText(body),
    status,
    tags,
    contexts,
    metadata,
    heading: undefined,
  };

  return parsedTask;
}

export function taskNoteMarkerToFrontmatter(taskNoteMarker: string): Record<string, unknown> {
  const marker = taskNoteMarker.trim() || 'task: true';
  const [rawKey, ...rest] = marker.split(':');
  const key = rawKey.trim() || 'task';
  const rawValue = rest.join(':').trim();
  if (!rawValue) return { [key]: true };
  if (/^(true|false)$/iu.test(rawValue)) return { [key]: rawValue.toLowerCase() === 'true' };
  if (/^-?\d+(?:\.\d+)?$/u.test(rawValue)) return { [key]: Number(rawValue) };
  return { [key]: rawValue };
}

export function buildTaskNoteFrontmatter(
  task: ParsedTask,
  taskNoteMarker: string,
  sourcePath?: string,
  sourceHeading?: string,
  customFieldDefinitions: readonly CustomFieldDefinition[] = [],
): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    ...taskNoteMarkerToFrontmatter(taskNoteMarker),
    status: task.status,
    priority: task.metadata.priority,
    description: task.normalizedText || task.body,
  };
  const dates = task.metadata.dates;
  for (const key of ['due', 'scheduled', 'start', 'created', 'done', 'cancelled'] as const) {
    if (dates[key]) fm[key] = dates[key];
  }
  if (task.metadata.id) fm.id = task.metadata.id;
  if (task.metadata.effort) fm.effort = task.metadata.effort;
  if (task.metadata.actual) fm.actual = task.metadata.actual;
  if (task.metadata.cost !== undefined) fm.cost = task.metadata.cost;
  if (task.metadata.recurrenceRaw || task.metadata.recurrence) fm.recurrence = task.metadata.recurrenceRaw ?? task.metadata.recurrence;
  if (task.metadata.reminder) fm.reminder = task.metadata.reminder;
  if (task.metadata.time) fm.time = task.metadata.time;
  if (task.metadata.pinned) fm.pinned = true;
  if (task.metadata.assignee) fm.assignee = task.metadata.assignee;
  if (task.metadata.reviewer) fm.reviewer = task.metadata.reviewer;
  if (task.metadata.project) fm.project = task.metadata.project;
  if (task.metadata.team) fm.team = task.metadata.team;
  if (task.metadata.parentId) fm.parent_id = task.metadata.parentId;

  for (const fieldDef of customFieldDefinitions) {
    const syncMode = fieldDef.syncMode ?? 'read';
    if (syncMode !== 'write' && syncMode !== 'bidirectional') continue;
    const fieldValue = task.metadata.customFields?.[fieldDef.key.toLowerCase()]?.value;
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') continue;
    if (Array.isArray(fieldValue) && fieldValue.length === 0) continue;

    const frontmatterKey = fieldDef.frontmatterKey || fieldDef.key;
    if (frontmatterKey in fm) continue;
    fm[frontmatterKey] = Array.isArray(fieldValue) ? [...fieldValue] : fieldValue;
  }

  if (sourcePath) fm.sourceFile = sourcePath;
  if (sourceHeading) fm.sourceHeading = sourceHeading;
  return fm;
}

export function serializeTaskNoteFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}: ${formatYamlScalar(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

export function rewriteTaskNoteFrontmatter(content: string, updates: Record<string, unknown>): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  let frontmatterStart = 0;
  let frontmatterEnd = -1;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const trimmed = lines[i]?.trim();
      if (trimmed === '---' || trimmed === '...') {
        frontmatterEnd = i;
        break;
      }
    }
  }

  let frontmatterLines: string[];
  let bodyLines: string[];
  if (frontmatterEnd >= 0) {
    frontmatterLines = lines.slice(frontmatterStart + 1, frontmatterEnd);
    bodyLines = lines.slice(frontmatterEnd + 1);
  } else {
    frontmatterStart = -1;
    frontmatterLines = [];
    bodyLines = lines;
  }

  const updateEntries = Object.entries(updates);
  const seen = new Set<string>();
  for (let i = 0; i < frontmatterLines.length; i++) {
    const match = frontmatterLines[i].match(/^([A-Za-z0-9_-]+)\s*:/u);
    if (!match) continue;
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    seen.add(key);
    const value = updates[key];
    if (value === undefined || value === null || value === '') {
      frontmatterLines.splice(i, 1);
      i--;
    } else {
      frontmatterLines[i] = `${key}: ${formatYamlScalar(value)}`;
    }
  }

  for (const [key, value] of updateEntries) {
    if (seen.has(key) || value === undefined || value === null || value === '') continue;
    frontmatterLines.push(`${key}: ${formatYamlScalar(value)}`);
  }

  const updated = ['---', ...frontmatterLines, '---', ...bodyLines].join('\n');
  return eol === '\r\n' ? updated.replace(/\n/gu, '\r\n') : updated;
}

function parseFrontmatterBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  return /^(true|yes|y|1|on|pinned)$/iu.test(value.trim());
}

function checkboxForFrontmatterStatus(value: unknown, states: readonly TaskStateDefinition[]): string {
  const normalized = String(value).toLowerCase().trim().replace(/[_-]+/gu, ' ');
  const byName = states.find((state) => state.name.toLowerCase().trim().replace(/[_-]+/gu, ' ') === normalized);
  if (byName) return byName.rawText;

  const byMarker = states.find((state) => state.rawText.toLowerCase() === String(value).toLowerCase().trim());
  if (byMarker) return byMarker.rawText;

  const typeAliases: Record<string, TaskStateDefinition['type']> = {
    todo: 'todo',
    unchecked: 'todo',
    incomplete: 'todo',
    'in progress': 'in_progress',
    doing: 'in_progress',
    done: 'done',
    complete: 'done',
    completed: 'done',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    blocked: 'blocked',
    waiting: 'blocked',
    deferred: 'deferred',
    'on hold': 'on_hold',
  };
  const type = typeAliases[normalized] ?? 'todo';
  return states.find((state) => state.type === type)?.rawText
    ?? (type === 'on_hold' ? states.find((state) => state.type === 'deferred')?.rawText : undefined)
    ?? ' ';
}

function normalizeClockTime(value: string): string | undefined {
  const match = value.match(/^(\d{1,2}):(\d{2})$/u);
  if (!match) return undefined;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour >= 24 || minute < 0 || minute >= 60) return undefined;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatYamlScalar(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatYamlScalar(item)).join(', ')}]`;
  }
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (isPlainYamlScalarSafe(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function isPlainYamlScalarSafe(text: string): boolean {
  if (!text || /^\s|\s$/u.test(text)) return false;
  if (/^(true|false|null|~)$/iu.test(text)) return false;
  if (/[\n\r#\[\]{}"']/u.test(text)) return false;
  if (/:\s/u.test(text)) return false;
  if (/^[-?:,![\]{}#&*|>'"%@`]/u.test(text)) return false;
  return /^[A-Za-z0-9_/@.,: -]+$/u.test(text);
}
