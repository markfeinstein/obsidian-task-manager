import { DEFAULT_TASK_STATES, resolvedTaskStateIcon, type TaskStateDefinition, type TaskStatus } from './types';
import { parseCustomFieldsFromMarkdown, parseDataviewInlineFields, stripDataviewInlineFields, type CustomFieldDefinition, type CustomFieldsMap } from './custom-fields-sync';
import { WORD_NUMBERS } from './date-utils';
import { explicitTaskKey } from './task-identity';
import { isValidIsoDate } from './iso-date';

export type TaskPriority = 'highest' | 'high' | 'medium' | 'normal' | 'low' | 'lowest';

export interface TaskDateMetadata {
  due?: string;
  scheduled?: string;
  start?: string;
  done?: string;
  created?: string;
  cancelled?: string;
  /** HH:MM time component paired with the `due` date (from `📅 YYYY-MM-DD HH:MM` syntax). */
  dueTime?: string;
  /** HH:MM time component paired with the `scheduled` date (from `⏳ YYYY-MM-DD HH:MM` syntax). */
  scheduledTime?: string;
  /** HH:MM time component paired with the `start` date (from `🛫 YYYY-MM-DD HH:MM` syntax). */
  startTime?: string;
}

export type TaskDateField = keyof TaskDateMetadata;

export interface TaskMetadata {
  dates: TaskDateMetadata;
  /** Optional fixed due-date timezone, persisted as [dueTimezone:: Area/City]. */
  dueTimezone?: string;
  invalidDates: Partial<Record<TaskDateField, string>>;
  priority: TaskPriority;
  recurrence?: string;
  /**
   * The original recurrence rule text as written by the user, before normalisation strips
   * `until YYYY-MM-DD` and `for N times` suffixes.  Displayed in the edit modal and query
   * result recurrence chips so users can see (and round-trip) the full rule.
   */
  recurrenceRaw?: string;
  invalidRecurrence?: boolean;
  id?: string;
  dependsOn: string[];
  onCompletion?: string;
  reminder?: string;
  /** Raw time metadata as written in ⌚/⏰/[time::] syntax. */
  time?: string;
  /** Structured timeline start time in HH:MM. */
  timeStart?: string;
  /** Structured timeline end time in HH:MM, when provided. */
  timeEnd?: string;
  blockLink?: string;
  /** Estimated effort, e.g. "2h 30m" (from ⏱️ emoji). */
  effort?: string;
  /** Actual time logged, e.g. "1h 45m" (from 🕐 emoji). */
  actual?: string;
  /** Follow-up / watch date — surface this task in queries on or after this date (from 👀 emoji). */
  followUp?: string;
  /** Pinned / focus marker (from 📌 or [pinned:: true]). */
  pinned?: boolean;
  /** Manual sort position from [order:: N] inline field, used by hand-arranged (drag-reordered) views. */
  manualOrder?: number;
  /** Optional fixed/estimated cost (from 💵 or [cost::]). */
  cost?: number;
  /** Optional dependency type per dependency id, e.g. FS/SS/FF/SF. */
  dependencyTypes?: Record<string, 'FS' | 'SS' | 'FF' | 'SF'>;
  /** Number of times this recurring task has been completed (for `for N times` limit). */
  recurrenceCount?: number;
  /** Maximum number of recurrences allowed (parsed from `for N times` in the recurrence rule). */
  recurrenceLimit?: number;
  /** End date for recurrence (parsed from `until YYYY-MM-DD` in the recurrence rule). No new occurrence is generated after this date. */
  recurrenceUntil?: string;
  /** Parent task id for task-note / subtask interop. */
  parentId?: string;
  /** 8-character series ID for recurring task (auto-generated on first recurrence). Propagated via metadata. */
  recurrenceSeriesId?: string;
  /** Assignee from 👤 @username marker. */
  assignee?: string;
  /** Reviewer from 👁️ @username marker. */
  reviewer?: string;
  /** Project name from 📋 marker. */
  project?: string;
  /** Team name from 👥 marker. */
  team?: string;
  /** Task comments stored as 💬 prefix indented bullets. */
  comments?: string[];
  /** User-defined custom fields parsed from Dataview inline fields/frontmatter. */
  customFields?: CustomFieldsMap;
  /** Exclude this task from outbound service sync adapters. */
  excludeFromSync?: boolean;
}

export interface MarkdownTask {
  key: string;
  /** ID-anchored key when task metadata contains an explicit task id. */
  stableKey?: string;
  filePath: string;
  lineNumber: number;
  rawLine: string;
  linePrefix: string;
  indentation: string;
  listMarker: string;
  checkbox: string;
  body: string;
  normalizedText: string;
  status: TaskStatus;
  tags: string[];
  contexts: string[];
  metadata: TaskMetadata;
  heading?: string;
  isProjected?: boolean;
}

export interface TaskStatusUpdateResult {
  content: string;
  updatedTask: MarkdownTask;
  /** Task as it existed in the file immediately before the checkbox rewrite. */
  previousTask: MarkdownTask;
}

export interface UpdateMarkdownTaskCheckboxOptions {
  /**
   * Allow the persisted line to already have a different status than the rendered
   * task, as long as the task identity still matches. This keeps rapid status
   * changes from failing when the UI has not re-rendered yet.
   */
  allowStaleStatus?: boolean;
  /**
   * Also tolerate done/cancelled lifecycle dates that were automatically added or
   * removed by a previous status change from the same rendered task.
   */
  allowLifecycleDateMismatch?: boolean;
}

// A real task always has whitespace, end-of-line, or non-`(` text after the checkbox `]`.
// The leading `(?!\[)` guard rejects wikilink list items like `- [[Note#L5]] text` (where the `[`
// after the bullet opens a `[[wikilink]]`, not a checkbox) — these are bullets, not tasks, and the
// Task Health Report writes many of them. The trailing `(?!\()` guard rejects markdown-link list
// items like `- [Label](https://…)` (where `]` is immediately followed by `(`). Both still allow
// multi-character status markers like `[TODO]` or `[a,b]`.
const TASK_LINE_PATTERN = /^((?:\s*>\s*)*)(\s*)((?:[-*+])|(?:\d+[.)]))\s+\[(?!\[)([^\]]+)\](?!\()\s*(.*)$/u;
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/u;
const DATAVIEW_DATE_PATTERN = /^\[\[(\d{4}-\d{2}-\d{2})(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]$|^(\d{4}-\d{2}-\d{2})(?:[ T]\d{1,2}:\d{2})?$/u;
// Org-mode keyword tasks: `- TODO: text`, `- DONE: text`, bare `TODO: text`, etc.
const ORG_KEYWORD_TASK_PATTERN = /^((?:\s*>\s*)*)(\s*)(?:((?:[-*+])|(?:\d+[.)]))\s+)?(TODO|DOING|DONE|NOW|LATER|WAIT|WAITING|CANCEL|CANCELED|CANCELLED|CLOSED):\s+(.*)$/iu;
const ORG_STATUS_MAP: Readonly<Record<string, string>> = {
  todo: ' ', doing: '/', now: '/', later: '>', wait: '?', waiting: '?',
  done: 'x', closed: 'x', cancel: '-', canceled: '-', cancelled: '-',
};
// Effort / actual-time patterns: ⏱️ 2h 30m  or  🕐 45m
const DURATION_METADATA_VALUE = String.raw`(?:\d+(?:\.\d+)?d(?:\s*\d+(?:\.\d+)?h)?(?:\s*\d+m)?|\d+(?:\.\d+)?h\s*\d+m|\d+(?:\.\d+)?h|\d+m)`;
const EFFORT_PATTERN = new RegExp(String.raw`(?:^|\s)⏱️?\s*(${DURATION_METADATA_VALUE})(?=\s|$)`, 'u');
const ACTUAL_PATTERN = new RegExp(String.raw`(?:^|\s)🕐️?\s*(${DURATION_METADATA_VALUE})(?=\s|$)`, 'u');
const COST_PATTERN = /(?:^|\s)[💵💰]\uFE0F?\s*([+-]?\d+(?:\.\d+)?)(?=\s|$)/u;
// Variant Selector 16 (U+FE0F) is optional after emojis on many platforms; allow it everywhere upstream does.
const VS = String.raw`\uFE0F?`;
// Wikilink-aware reminder pattern; supports both [[YYYY-MM-DD]] and [[YYYY-MM-DD HH:MM]] forms.
const REMINDER_PATTERN = new RegExp(
  String.raw`(?:^|\s)⏰${VS}\s*(?:\[\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?(?:\|[^\]]*)?\]\]|(\d{4}-\d{2}-\d{2})(?=[ T]\d{1,2}:\d{2}(?:\s|$)|\s|$))(?:[ T](\d{1,2}:\d{2})(?=\s|$))?`,
  'u',
);
// Follow-up / watch date: 👀 YYYY-MM-DD, 👀 YYYY-MM-DD HH:MM, or wikilink-wrapped equivalents.
const FOLLOWUP_PATTERN = new RegExp(
  String.raw`(?:^|\s)👀${VS}\s*(?:\[\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?(?:\|[^\]]*)?\]\]|(\d{4}-\d{2}-\d{2})(?=[ T]\d{1,2}:\d{2}(?:\s|$)|\s|$)(?:[ T](\d{1,2}:\d{2})(?=\s|$))?)`,
  'u',
);
const TIME_PATTERN = new RegExp(String.raw`(?:^|\s)⌚${VS}\s*(\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?)`, 'u');
const TIMELINE_TIME_PATTERN = new RegExp(String.raw`(?:^|\s)⏰${VS}\s*(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?`, 'u');
// Task-id and comma-separated sequence shapes mirror upstream taskIdRegex/taskIdSequenceRegex.
const TASK_ID_PART = String.raw`[A-Za-z0-9_-]+`;
const TASK_ID_VALUE = String.raw`${TASK_ID_PART}(?::${TASK_ID_PART})?`;
const TASK_DEP_PART = String.raw`${TASK_ID_PART}(?::(?:FS|SS|FF|SF)(?:[+-]?\d+[dwmy])?)?`;
const TASK_ID_SEQUENCE = String.raw`${TASK_DEP_PART}(?:\s*,\s*${TASK_DEP_PART})*`;
const BLOCK_LINK_PATTERN = /\s\^([A-Za-z0-9-]+)$/u;
// Permissive tag pattern: matches Obsidian-Tasks's recognised tag syntax which is
// intentionally broader than Obsidian core. Allows numbers-only tags (#123),
// nested/hierarchical tags (#project/v2), underscores and hyphens. The character
// class excludes whitespace plus common punctuation that would terminate a tag.
const TAG_PATTERN = /(^|\s)#([^ !@#$%^&*(),.?":{}|<>]+)/gu;
const CONTEXT_PATTERN = /(^|\s)@([\p{L}\p{N}_/-]+)/gu;
// Collaboration field patterns
const ASSIGNEE_PATTERN = new RegExp(String.raw`(?:^|\s)\ud83d\udc64${VS}\s*@([\p{L}\p{N}_/-]+)`, 'u');
const REVIEWER_PATTERN = new RegExp(String.raw`(?:^|\s)\ud83d\udc41${VS}\s*@([\p{L}\p{N}_/-]+)`, 'u');
const PROJECT_PATTERN = new RegExp(String.raw`(?:^|\s)\ud83d\udccb${VS}\s+([^\s\ud83d\udc00-\ud83d\udc1f]+)`, 'u');
const TEAM_PATTERN = new RegExp(String.raw`(?:^|\s)\ud83d\udc65${VS}\s+([^\s\ud83d\udc00-\ud83d\udc1f]+)`, 'u');
const DUE_SYMBOLS = ['📅', '📆', '🗓'] as const;
const SCHEDULED_SYMBOLS = ['⏳', '⌛'] as const;
const CANCELLED_SYMBOLS = ['❌'] as const;
const LEGACY_CANCELLED_SYMBOLS = ['⛔'] as const;
const DATE_METADATA_SYMBOL_CLASS = '📅📆🗓⏳⌛🛫✅➕❌';
const PRIORITY_BY_SYMBOL: Readonly<Record<string, TaskPriority>> = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest',
};
const PRIORITY_SYMBOL_PATTERN = /[🔺⏫🔼🔽⏬]\uFE0F?/gu;
const PRIORITY_LABEL_PATTERN = new RegExp(String.raw`(?:^|\s)🎯${VS}\s+(highest|high|medium|normal|low|lowest)(?=\s|$)`, 'giu');
const METADATA_DATE_VALUE = String.raw`(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)`;
const METADATA_BOUNDARY = String.raw`(?=\s+(?:[📅📆🗓⏳⌛🛫✅➕❌]${VS}\s*${METADATA_DATE_VALUE}|⛔${VS}\s*${METADATA_DATE_VALUE}|⏰${VS}\s*${METADATA_DATE_VALUE}|🔁${VS}|🏁${VS}|🆔${VS}|⛔${VS}\s+\S|📌${VS}|⌚${VS}|⏰${VS}|👀${VS}|👤${VS}|👁${VS}|📋${VS}|👥${VS}|⏱${VS}|🕐${VS}|[💵💰]${VS}|[🔺⏫🔼🔽⏬]${VS}|🎯${VS}\s+(?:highest|high|medium|normal|low|lowest)(?=\s|$)|[\[(][A-Za-z_][A-Za-z0-9 _-]*::)|$)`;
const ON_COMPLETION_ACTION_PATTERN = String.raw`(?:move[-\s]+to[-\s]+end|delete|archive|collect|keep)`;

export function parseMarkdownTaskLine(
  rawLine: string,
  filePath: string,
  lineNumber: number,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
  heading?: string,
  orgModeEnabled?: boolean,
  customFieldDefinitions: readonly CustomFieldDefinition[] = [],
): MarkdownTask | null {
  // Org-mode keyword tasks (optional feature): `- TODO: text` or bare `TODO: text`
  if (orgModeEnabled) {
    const orgMatch = rawLine.match(ORG_KEYWORD_TASK_PATTERN);
    if (orgMatch) {
      const linePrefix = orgMatch[1] ?? '';
      const indentation = orgMatch[2] ?? '';
      const listMarker = orgMatch[3] ?? '-';
      const keyword = (orgMatch[4] ?? 'TODO').toLowerCase();
      const body = orgMatch[5] ?? '';
      const checkbox = ORG_STATUS_MAP[keyword] ?? ' ';
      const status = statusFromCheckbox(checkbox, states);
      const metadata = parseTaskMetadata(body, customFieldDefinitions);
      const normalizedText = normalizeTaskText(stripTaskMetadata(body));
      const key = taskKeyForBody(filePath, body, metadata);
      const stableKey = metadata.id ? key : undefined;
      const tags = extractTags(body);
      const contexts = extractContexts(body);
      return { key, stableKey, filePath, lineNumber, rawLine, linePrefix, indentation, listMarker, checkbox, body, normalizedText, status, tags, contexts, metadata, heading };
    }
  }

  const match = rawLine.match(TASK_LINE_PATTERN);
  if (!match) {
    return null;
  }

  const [, linePrefix, indentation, listMarker, checkbox, body] = match;
  const metadata = parseTaskMetadata(body, customFieldDefinitions);
  const normalizedText = normalizeTaskText(stripTaskMetadata(body));
  const key = taskKeyForBody(filePath, body, metadata);
  const stableKey = metadata.id ? key : undefined;
  const tags = extractTags(body);
  const contexts = extractContexts(body);

  return {
    key,
    stableKey,
    filePath,
    lineNumber,
    rawLine,
    linePrefix,
    indentation,
    listMarker,
    checkbox,
    body,
    normalizedText,
    status: statusFromCheckbox(checkbox, states),
    tags,
    contexts,
    metadata,
    heading,
  };
}

export function statusFromCheckbox(
  marker: string,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
): TaskStatus {
  return states.find((state) => state.rawText === marker)?.type ?? legacyStatusFromCheckbox(marker);
}

function legacyStatusFromCheckbox(marker: string): TaskStatus {
  switch (marker) {
    case 'X':
      return 'done';
    case 'w':
    case 'W':
      return 'blocked';
    default:
      // Match upstream Tasks semantics: an unknown checkbox marker is still an actionable TODO.
      // Users can opt out by explicitly configuring a marker as the `untracked` status type.
      return 'todo';
  }
}

export function checkboxForStatus(
  status: TaskStatus,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
): string {
  return states.find((state) => state.type === status)?.rawText ?? ' ';
}

export function nextTaskCheckbox(
  currentMarker: string,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
): string {
  if (states.length === 0) {
    return checkboxForStatus('done');
  }

  const currentIndex = states.findIndex((state) => state.rawText === currentMarker);
  if (currentIndex === -1) {
    return checkboxForStatus('done', states);
  }

  const configuredNext = states[currentIndex].nextStatusSymbol;
  if (configuredNext !== undefined && states.some((state) => state.rawText === configuredNext)) {
    return configuredNext;
  }

  return cycleTaskCheckbox(currentMarker, states);
}

export function cycleTaskCheckbox(
  currentMarker: string,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
): string {
  if (states.length === 0) {
    return checkboxForStatus('done');
  }

  const currentIndex = states.findIndex((state) => state.rawText === currentMarker);
  if (currentIndex === -1) {
    return checkboxForStatus('done', states);
  }

  const currentType = states[currentIndex].type;
  for (let offset = 1; offset <= states.length; offset += 1) {
    const nextState = states[(currentIndex + offset) % states.length];
    if (nextState.type !== currentType && nextState.type !== 'untracked') {
      return nextState.rawText;
    }
  }

  return states[currentIndex].rawText;
}

export function taskStateLabel(
  marker: string,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
): string {
  return states.find((state) => state.rawText === marker)?.name ?? 'Unknown';
}

export function taskStateIcon(
  marker: string,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
): string {
  const state = states.find((candidate) => candidate.rawText === marker);
  return state ? resolvedTaskStateIcon(state) : `[${marker}]`;
}

export function toggledTaskStatus(status: TaskStatus): TaskStatus {
  return status === 'done' ? 'todo' : 'done';
}

export function updateMarkdownTaskLineStatus(
  rawLine: string,
  status: TaskStatus,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
): string | null {
  return updateMarkdownTaskLineCheckbox(rawLine, checkboxForStatus(status, states), states);
}

export function updateMarkdownTaskLineCheckbox(
  rawLine: string,
  checkbox: string,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
): string | null {
  const match = rawLine.match(TASK_LINE_PATTERN);
  if (match) {
    const [, linePrefix, indentation, listMarker, , body] = match;
    return `${linePrefix}${indentation}${listMarker} [${checkbox}] ${body}`;
  }

  const orgMatch = rawLine.match(ORG_KEYWORD_TASK_PATTERN);
  if (!orgMatch) {
    return null;
  }

  const linePrefix = orgMatch[1] ?? '';
  const indentation = orgMatch[2] ?? '';
  const listMarker = orgMatch[3];
  const body = orgMatch[5] ?? '';
  const keyword = orgKeywordForCheckbox(checkbox, states);
  return `${linePrefix}${indentation}${listMarker ? `${listMarker} ` : ''}${keyword}: ${body}`;
}

function orgKeywordForCheckbox(checkbox: string, states: readonly TaskStateDefinition[]): string {
  switch (checkbox) {
    case 'x':
    case 'X':
      return 'DONE';
    case '-':
      return 'CANCELLED';
    case '/':
      return 'DOING';
    case '>':
      return 'LATER';
    case '!':
    case '?':
    case 'w':
    case 'W':
      return 'WAIT';
    default:
      break;
  }

  const status = statusFromCheckbox(checkbox, states);
  switch (status) {
    case 'done':
      return 'DONE';
    case 'cancelled':
      return 'CANCELLED';
    case 'in_progress':
      return 'DOING';
    case 'deferred':
      return 'LATER';
    case 'blocked':
    case 'on_hold':
      return 'WAIT';
    default:
      return 'TODO';
  }
}

export function updateMarkdownTaskStatusInContent(
  content: string,
  task: MarkdownTask,
  status: TaskStatus,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
): TaskStatusUpdateResult {
  return updateMarkdownTaskCheckboxInContent(content, task, checkboxForStatus(status, states), states);
}

export function updateMarkdownTaskCheckboxInContent(
  content: string,
  task: MarkdownTask,
  checkbox: string,
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
  options: UpdateMarkdownTaskCheckboxOptions = {},
): TaskStatusUpdateResult {
  if (!Number.isInteger(task.lineNumber) || task.lineNumber < 1) {
    throw new Error(`Cannot update task: invalid line number ${task.lineNumber}`);
  }

  const lines = splitContentLines(content);
  let lineIndex = task.lineNumber - 1;
  let line = lines[lineIndex];
  if (!line) {
    const resolved = options.allowStaleStatus ? findMatchingTaskLine(lines, task, states) : null;
    if (!resolved) throw new Error(`Cannot update task: line ${task.lineNumber} no longer exists`);
    lineIndex = resolved.lineIndex;
    line = resolved.line;
  }

  let orgModeEnabled = isOrgKeywordTaskLine(task.rawLine) || isOrgKeywordTaskLine(line.text);
  let currentTask = parseMarkdownTaskLine(line.text, task.filePath, lineIndex + 1, states, task.heading, orgModeEnabled);
  if (!currentTask) {
    const resolved = options.allowStaleStatus ? findMatchingTaskLine(lines, task, states) : null;
    if (!resolved) throw new Error(`Cannot update task: line ${task.lineNumber} is no longer a task`);
    lineIndex = resolved.lineIndex;
    line = resolved.line;
    currentTask = resolved.currentTask;
    orgModeEnabled = resolved.orgModeEnabled;
  }

  if (currentTask.status !== task.status && !options.allowStaleStatus) {
    throw new Error(`Cannot update task: line ${task.lineNumber} status changed since it was rendered`);
  }

  if (!taskLineMatchesRenderedTask(line.text, task, options)) {
    const resolved = options.allowStaleStatus ? findMatchingTaskLine(lines, task, states) : null;
    if (!resolved) {
      throw new Error(`Cannot update task: line ${task.lineNumber} no longer matches the rendered task`);
    }
    lineIndex = resolved.lineIndex;
    line = resolved.line;
    currentTask = resolved.currentTask;
    orgModeEnabled = resolved.orgModeEnabled;
  }

  const updatedLine = updateMarkdownTaskLineCheckbox(line.text, checkbox, states);
  if (!updatedLine) {
    throw new Error(`Cannot update task: line ${task.lineNumber} could not be rewritten`);
  }

  const updatedTask = parseMarkdownTaskLine(updatedLine, task.filePath, lineIndex + 1, states, task.heading, orgModeEnabled);
  if (!updatedTask) {
    throw new Error(`Cannot update task: rewritten line ${task.lineNumber} is invalid`);
  }

  line.text = updatedLine;
  return {
    content: lines.map((part) => `${part.text}${part.lineEnding}`).join(''),
    updatedTask: { ...updatedTask, key: task.key },
    previousTask: currentTask,
  };
}

export function extractTags(text: string): string[] {
  return Array.from(text.matchAll(TAG_PATTERN))
    .map((tag) => tag[2])
    .filter(Boolean);
}

/**
 * Remove inline `#tags` from a task's display text (keeping the surrounding words and
 * collapsing the resulting whitespace). Used to keep tags off the subject line in widgets;
 * the parsed `tags` array is unaffected and still drives filtering.
 */
export function stripInlineTags(text: string): string {
  return normalizeTaskText(text.replace(TAG_PATTERN, '$1'));
}

export function extractContexts(text: string): string[] {
  // Match @context annotations that are preceded by whitespace or start-of-string.
  // Requiring \s or ^ prevents false positives from email addresses (user@example.com)
  // and embedded URLs where @ lacks a preceding space.
  return Array.from(text.matchAll(CONTEXT_PATTERN)).map((m) => m[2]).filter(Boolean);
}

export function normalizeTaskText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function taskKeyForBody(filePath: string, body: string, metadata: Pick<TaskMetadata, 'id'> | undefined): string {
  const id = metadata?.id?.trim();
  return id ? explicitTaskKey(id) : legacyTaskKeyForBody(filePath, body);
}

export function legacyTaskKeyForBody(filePath: string, body: string): string {
  return `${filePath}:${normalizeTaskTextForKey(body)}`;
}

export function normalizeTaskTextForKey(taskBodyOrRawLine: string): string {
  const body = taskBodyOrRawLine.replace(/^(?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\s+/u, '');
  return stripKeyHashTags(stripTaskMetadata(normalizeTaskText(body)))
    .replace(CONTEXT_PATTERN, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function stripKeyHashTags(text: string): string {
  return text.replace(TAG_PATTERN, '$1');
}

export function stripTaskMetadata(text: string): string {
  return stripDataviewInlineFields(text)
    .replace(BLOCK_LINK_PATTERN, ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)[${DATE_METADATA_SYMBOL_CLASS}]${VS}\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?=\s|$)`, 'gu'), ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)⏰${VS}\s*(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?=[ T]\d{1,2}:\d{2}(?:\s|$)|\s|$))(?:[ T]\d{1,2}:\d{2}(?=\s|$))?`, 'gu'), ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)⛔${VS}\s*(?:\[\[\d{4}-\d{2}-\d{2}(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?=\s|$))`, 'gu'), ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)🔁${VS}\s+.+?${METADATA_BOUNDARY}`, 'gu'), ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)🏁${VS}\s+.+?${METADATA_BOUNDARY}`, 'gu'), ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)🆔${VS}\s+\S+`, 'gu'), ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)⛔${VS}\s+(?:${TASK_ID_SEQUENCE})`, 'gu'), ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)[🔺⏫🔼🔽⏬]${VS}`, 'gu'), ' ')
    .replace(PRIORITY_LABEL_PATTERN, ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)⌚${VS}\s*\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?`, 'gu'), ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)⏰${VS}\s*\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?`, 'gu'), ' ')
    // Wikilink date variants: [[YYYY-MM-DD]], [[YYYY-MM-DD HH:MM]], or aliases.
    .replace(new RegExp(String.raw`(?:^|\s+)[${DATE_METADATA_SYMBOL_CLASS}]${VS}\s*\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\](?:[ T]\d{1,2}:\d{2}(?=\s|$))?`, 'gu'), ' ')
    // Follow-up watch date
    .replace(new RegExp(String.raw`(?:^|\s+)👀${VS}\s*(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?=[ T]\d{1,2}:\d{2}(?:\s|$)|\s|$)(?:[ T]\d{1,2}:\d{2}(?=\s|$))?)`, 'gu'), ' ')
    // Effort, actual-time, pinned and cost emojis
    .replace(EFFORT_PATTERN, ' ')
    .replace(ACTUAL_PATTERN, ' ')
    .replace(new RegExp(String.raw`(?:^|\s+)📌${VS}`, 'gu'), ' ')
    .replace(COST_PATTERN, ' ');
}

export function parseTaskMetadata(text: string, customFieldDefinitions: readonly CustomFieldDefinition[] = []): TaskMetadata {
  const dates: TaskDateMetadata = {};
  const invalidDates: Partial<Record<TaskDateField, string>> = {};
  const dependsOn: string[] = [];
  const dependencyTypes: Record<string, 'FS' | 'SS' | 'FF' | 'SF'> = {};
  const assignDate = (field: TaskDateField, date: string): void => {
    dates[field] = date;
    if (!isValidIsoDate(date)) invalidDates[field] = date;
  };

  collectDateMetadataForSymbols(text, DUE_SYMBOLS, (date, time) => { assignDate('due', date); if (time) dates.dueTime = time; });
  collectDateMetadataForSymbols(text, SCHEDULED_SYMBOLS, (date, time) => { assignDate('scheduled', date); if (time) dates.scheduledTime = time; });
  collectDateMetadata(text, '\uD83D\uDEEB', (date, time) => { assignDate('start', date); if (time) dates.startTime = time; });
  collectDateMetadata(text, '\u2705', (date) => { assignDate('done', date); });
  collectDateMetadata(text, '\u2795', (date) => { assignDate('created', date); });
  collectDateMetadataForSymbols(text, CANCELLED_SYMBOLS, (date) => { assignDate('cancelled', date); });
  collectDateMetadataForSymbols(text, LEGACY_CANCELLED_SYMBOLS, (date) => { assignDate('cancelled', date); });

  const dataview = collectDataviewFields(text);
  assignDataviewDate(dataview, 'due', (date) => { assignDate('due', date); });
  assignDataviewDate(dataview, 'scheduled', (date) => { assignDate('scheduled', date); });
  assignDataviewDate(dataview, 'start', (date) => { assignDate('start', date); });
  assignDataviewDate(dataview, 'created', (date) => { assignDate('created', date); });
  assignDataviewDate(dataview, 'completion', (date) => { assignDate('done', date); });
  assignDataviewDate(dataview, 'done', (date) => { assignDate('done', date); });
  assignDataviewDate(dataview, 'cancelled', (date) => { assignDate('cancelled', date); });
  assignDataviewDate(dataview, 'canceled', (date) => { assignDate('cancelled', date); });
  for (const [field, timeField] of [['due', 'dueTime'], ['scheduled', 'scheduledTime'], ['start', 'startTime']] as const) {
    const value = dataviewDateTimeValue(dataview.get(field));
    if (value?.includes(' ')) dates[timeField] = value.slice(11);
  }

  let priority: TaskPriority = parseDataviewPriority(dataview.get('priority')) ?? 'normal';
  for (const priorityMatch of text.matchAll(PRIORITY_SYMBOL_PATTERN)) {
    // Strip a trailing Variant Selector 16 (\uFE0F) so the lookup matches the bare emoji.
    const symbol = priorityMatch[0].replace(/\uFE0F$/u, '');
    priority = PRIORITY_BY_SYMBOL[symbol] ?? priority;
  }
  for (const priorityMatch of text.matchAll(PRIORITY_LABEL_PATTERN)) {
    priority = priorityMatch[1].toLowerCase() as TaskPriority;
  }

  const recurrenceMatch = text.match(new RegExp(String.raw`(?:^|\s)\uD83D\uDD01${VS}\s+(.+?)${METADATA_BOUNDARY}`, 'u'));
  const recurrenceRawText = recurrenceMatch ? normalizeTaskText(recurrenceMatch[1]) : dataview.get('repeat');
  const recurrence = normalizeRecurrenceRule(recurrenceRawText ?? undefined);
  // recurrenceRaw preserves the full original rule text (including `until`, `for N times`) so the UI
  // can display and round-trip it without the normalization stripping the end conditions.
  const recurrenceRaw = recurrenceRawText?.trim() || undefined;
  const onCompletionActionMatch = text.match(new RegExp(String.raw`(?:^|\s)🏁${VS}\s+(${ON_COMPLETION_ACTION_PATTERN})(?=\s|$)`, 'iu'));
  const onCompletionFallbackMatch = onCompletionActionMatch ? null : text.match(new RegExp(String.raw`(?:^|\s)🏁${VS}\s+(.+?)${METADATA_BOUNDARY}`, 'u'));
  const onCompletion = normalizeOnCompletion(onCompletionActionMatch?.[1] ?? onCompletionFallbackMatch?.[1] ?? dataview.get('oncompletion') ?? dataview.get('on completion') ?? dataview.get('on-completion'));
  const reminderMatch = text.match(REMINDER_PATTERN);
  // Groups: 1 = wikilink date, 2 = optional time inside wikilink, 3 = plain date, 4 = optional time after date
  const reminderDate = reminderMatch?.[1] ?? reminderMatch?.[3];
  const reminderTime = validMetadataClockTime(reminderMatch?.[2] ?? reminderMatch?.[4]);
  const reminder = reminderDate ? `${reminderDate}${reminderTime ? ` ${reminderTime}` : ''}` : dataview.get('reminder')?.replace(/([ T])(\d):(\d{2})$/u, '$10$2:$3');
  const timeMatch = text.match(TIME_PATTERN);
  const timelineTimeMatch = text.match(TIMELINE_TIME_PATTERN);
  const dataviewTime = dataview.get('time') ?? undefined;
  const time = timeMatch?.[1] ?? (timelineTimeMatch ? `${timelineTimeMatch[1]}${timelineTimeMatch[2] ? `-${timelineTimeMatch[2]}` : ''}` : undefined) ?? dataviewTime;
  const { start: timeStart, end: timeEnd } = parseTimelineTimeRange(time);
  const blockLinkMatch = text.match(BLOCK_LINK_PATTERN);

  // ID format: allowed characters are letters, digits, hyphen and underscore
  // (mirrors upstream obsidian-tasks). The terminating lookahead ensures we
  // reject IDs that contain stray punctuation such as "bad.id" instead of
  // silently truncating to "bad".
  const idMatch = text.match(new RegExp(String.raw`(?:^|\s)🆔${VS}\s+(${TASK_ID_VALUE})(?=\s|$)`, 'u'));
  const dataviewId = dataview.get('id');
  const idValuePattern = new RegExp(String.raw`^${TASK_ID_VALUE}$`, 'u');
  const id = idMatch?.[1] ?? (dataviewId && idValuePattern.test(dataviewId) ? dataviewId : undefined);

  // Match ⛔ followed by a comma-separated taskId sequence (mirrors upstream taskIdSequenceRegex).
  // The leading boundary excludes legacy cancelled-date encoding (⛔ YYYY-MM-DD) and full-date tokens.
  for (const dependencyMatch of text.matchAll(new RegExp(String.raw`(?:^|\s)⛔${VS}\s+(${TASK_ID_SEQUENCE})(?=\s|$)`, 'gu'))) {
    const value = dependencyMatch[1];
    // Skip the legacy cancelled-date encoding where the first token looks like YYYY-MM-DD.
    const firstToken = value.split(/\s*,\s*/u)[0];
    if (/^\d{4}-\d{2}-\d{2}$/u.test(firstToken)) continue;
    for (const dep of splitDependencyValues(value)) {
      const parsed = parseTypedDependency(dep);
      dependsOn.push(parsed.id);
      if (parsed.type) dependencyTypes[parsed.id] = parsed.type;
    }
  }
  const dataviewDependsOn = dataview.get('dependson') ?? dataview.get('depends on');
  if (dataviewDependsOn) {
    for (const dep of splitDependencyValues(dataviewDependsOn)) {
      const parsed = parseTypedDependency(dep);
      dependsOn.push(parsed.id);
      if (parsed.type) dependencyTypes[parsed.id] = parsed.type;
    }
  }

  const effortMatch = text.match(EFFORT_PATTERN);
  const effort = effortMatch?.[1] ?? dataview.get('effort') ?? dataview.get('estimate') ?? dataview.get('est');
  const actualMatch = text.match(ACTUAL_PATTERN);
  const actual = actualMatch?.[1] ?? dataview.get('actual') ?? dataview.get('logged');

  const followUpMatch = text.match(FOLLOWUP_PATTERN);
  const followUpDate = followUpMatch?.[1] ?? followUpMatch?.[3];
  const followUpTime = validMetadataClockTime(followUpMatch?.[2] ?? followUpMatch?.[4]);

  const followUp: string | undefined = followUpDate ? `${followUpDate}${followUpTime ? ` ${followUpTime}` : ''}`
    : ((): string | undefined => {
      const dv = dataview.get('follow-up') ?? dataview.get('followup');
      return dataviewDateTimeValue(dv);
    })();

  const pinned = /(?:^|\s)📌\uFE0F?(?=\s|$)/u.test(text) || parseBooleanDataview(dataview.get('pinned') ?? dataview.get('pin'));
  const excludeFromSync = parseSyncExclusion(dataview);
  const costMatch = text.match(COST_PATTERN);
  const costRaw = costMatch?.[1] ?? dataview.get('cost') ?? dataview.get('budget');
  const cost = costRaw !== undefined && /^[-+]?\d+(?:\.\d+)?$/u.test(costRaw.trim()) ? Number.parseFloat(costRaw.trim()) : undefined;

  // Recurrence count limit: parse `for N times` suffix from recurrence rule.
  // Use recurrenceRawText (before normalisation) so weekday rules like
  // "every monday for 3 times" don't lose the limit — normalizeRecurrenceRule
  // rewrites "every monday…" to "every week on monday" and drops the suffix.
  let recurrenceLimit: number | undefined;
  let recurrenceUntil: string | undefined;
  const ruleTextForLimitParsing = recurrenceRawText ?? recurrence;
  if (ruleTextForLimitParsing) {
    const countMatch = ruleTextForLimitParsing.match(/\bfor\s+(\d+|[a-z]+)\s+times?\b/iu);
    if (countMatch) {
      const parsedCount = Number.parseInt(countMatch[1], 10);
      recurrenceLimit = Number.isNaN(parsedCount) ? WORD_NUMBERS[countMatch[1].toLowerCase()] : parsedCount;
    }
    const untilMatch = ruleTextForLimitParsing.match(/\buntil\s+(\d{4}-\d{2}-\d{2})\b/iu);
    if (untilMatch && isValidIsoDate(untilMatch[1])) recurrenceUntil = untilMatch[1];
  }

  // Parse collaboration fields
  const assigneeMatch = text.match(ASSIGNEE_PATTERN);
  const assignee = assigneeMatch?.[1] ?? dataview.get('assignee');
  const reviewerMatch = text.match(REVIEWER_PATTERN);
  const reviewer = reviewerMatch?.[1] ?? dataview.get('reviewer');
  const projectMatch = text.match(PROJECT_PATTERN);
  const project = projectMatch?.[1]?.trim() ?? dataview.get('project');
  const teamMatch = text.match(TEAM_PATTERN);
  const team = teamMatch?.[1]?.trim() ?? dataview.get('team');

  // collectDataviewFields lowercases keys, so camelCase inline fields such as
  // [recurrenceSeriesId::] and [recurrenceCount::] are stored without capitals.
  const recurrenceSeriesId = dataview.get('recurrenceseriesid') ?? dataview.get('series') ?? dataview.get('seriesid');

  // Parse recurrence count from dataview field [recurrenceCount::]
  const recurrenceCountRaw = dataview.get('recurrencecount');
  const recurrenceCount = recurrenceCountRaw !== undefined && /^\d+$/u.test(recurrenceCountRaw) ? Number.parseInt(recurrenceCountRaw, 10) : undefined;

  // Manual drag-reorder position written as [order:: N]; may be fractional to allow inserting between rows.
  const manualOrderRaw = dataview.get('order');
  const manualOrder = manualOrderRaw !== undefined && /^-?\d+(?:\.\d+)?$/u.test(manualOrderRaw.trim()) ? Number.parseFloat(manualOrderRaw.trim()) : undefined;

  const customFields = customFieldDefinitions.length > 0
    ? parseCustomFieldsFromMarkdown(text, [...customFieldDefinitions])
    : undefined;

  return {
    dates,
    invalidDates,
    priority,
    recurrence,
    recurrenceRaw,
    ...(/^[A-Za-z0-9_+./-]{1,100}$/u.test(dataview.get('duetimezone') ?? '') ? { dueTimezone: dataview.get('duetimezone') } : {}),
    id,
    dependsOn: Array.from(new Set(dependsOn)),
    dependencyTypes: Object.keys(dependencyTypes).length > 0 ? dependencyTypes : undefined,
    onCompletion,
    reminder,
    time,
    timeStart,
    timeEnd,
    blockLink: blockLinkMatch?.[0]?.trim(),
    effort,
    actual,
    followUp,
    pinned,
    manualOrder,
    cost,
    recurrenceCount,
    recurrenceLimit,
    recurrenceUntil,
    recurrenceSeriesId,
    assignee,
    reviewer,
    project,
    team,
    comments: undefined,
    customFields,
    excludeFromSync,
  };
}

function parseSyncExclusion(dataview: ReadonlyMap<string, string>): boolean {
  const explicitExclude = dataview.get('exclude_from_sync')
    ?? dataview.get('exclude from sync')
    ?? dataview.get('sync-exclude')
    ?? dataview.get('nosync')
    ?? dataview.get('no-sync');
  if (parseBooleanDataview(explicitExclude)) return true;

  const syncValue = dataview.get('sync');
  if (!syncValue) return false;
  return /^(false|no|n|0|off|disabled)$/iu.test(syncValue.trim());
}

function parseTimelineTimeRange(value: string | undefined): { start?: string; end?: string } {
  if (!value) return {};
  const match = value.match(/^\s*(\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?\s*$/u);
  if (!match) return {};
  const startHour = Number.parseInt(match[1], 10);
  const startMin = Number.parseInt(match[2], 10);
  const endHour = match[3] !== undefined ? Number.parseInt(match[3], 10) : undefined;
  const endMin = match[4] !== undefined ? Number.parseInt(match[4], 10) : undefined;
  if (!isValidClockTime(startHour, startMin)) return {};
  const start = `${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`;
  if (endHour === undefined || endMin === undefined || !isValidClockTime(endHour, endMin)) return { start };
  return { start, end: `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}` };
}

function isValidClockTime(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour < 24 && minute >= 0 && minute < 60;
}

function validMetadataClockTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{1,2}):(\d{2})$/u);
  if (!match) return undefined;
  return isValidClockTime(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)) ? `${match[1].padStart(2, '0')}:${match[2]}` : undefined;
}

function collectDateMetadataForSymbols(text: string, symbols: readonly string[], assign: (date: string, time?: string) => void): void {
  for (const symbol of symbols) {
    collectDateMetadata(text, symbol, assign);
  }
}

function collectDateMetadata(text: string, symbol: string, assign: (date: string, time?: string) => void): void {
  const escaped = escapeRegExp(symbol);
  // Match plain date (with optional HH:MM time suffix) OR [[YYYY-MM-DD]] wikilink after the emoji symbol.
  // Some existing vaults include the time inside the date wikilink: [[YYYY-MM-DD HH:MM]].
  const pattern = new RegExp(
    String.raw`(?:^|\s)${escaped}\uFE0F?\s*(?:\[\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?(?:\|[^\]]*)?\]\]|(${DATE_PATTERN.source})(?=[ T]\d{1,2}:\d{2}(?:\s|$)|\s|$))(?:[ T](\d{1,2}:\d{2})(?=\s|$))?`,
    'gu',
  );
  for (const match of text.matchAll(pattern)) {
    const date = match[1] ?? match[3];
    const time = validMetadataClockTime(match[2] ?? match[4]);
    if (date) assign(date, time);
  }
}

function collectDataviewFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const field of parseDataviewInlineFields(text)) {
    fields.set(field.key.toLowerCase().replace(/\s+/gu, ' '), normalizeTaskText(field.value));
  }
  return fields;
}

function assignDataviewDate(fields: ReadonlyMap<string, string>, key: string, assign: (date: string) => void): void {
  const date = dataviewDateValue(fields.get(key));
  if (date) assign(date);
}

function dataviewDateValue(value: string | undefined): string | undefined {
  const match = value?.trim().match(DATAVIEW_DATE_PATTERN);
  return match?.[1] ?? match?.[2];
}

function dataviewDateTimeValue(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^\[\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?(?:\|[^\]]*)?\]\]$|^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?$/u);
  const date = match?.[1] ?? match?.[3];
  const time = validMetadataClockTime(match?.[2] ?? match?.[4]);
  return date ? `${date}${time ? ` ${time}` : ''}` : undefined;
}

function parseDataviewPriority(value: string | undefined): TaskPriority | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase().trim();
  return normalized === 'highest' || normalized === 'high' || normalized === 'medium' || normalized === 'normal' || normalized === 'none' || normalized === 'low' || normalized === 'lowest'
    ? (normalized === 'none' ? 'normal' : normalized)
    : undefined;
}

function splitDependencyValues(value: string): string[] {
  return value.split(/\s*,\s*/u).map((entry) => entry.trim()).filter(Boolean);
}

function parseTypedDependency(value: string): { id: string; type?: 'FS' | 'SS' | 'FF' | 'SF' } {
  const match = value.trim().match(/^([A-Za-z0-9_-]+)(?::(FS|SS|FF|SF)(?:[+-]?\d+[dwmy])?)?$/iu);
  if (!match) return { id: value.trim() };
  return { id: match[1], type: match[2]?.toUpperCase() as 'FS' | 'SS' | 'FF' | 'SF' | undefined };
}

function parseBooleanDataview(value: string | undefined): boolean {
  if (!value) return false;
  return /^(true|yes|y|1|on|pinned)$/iu.test(value.trim());
}

export function normalizeRecurrenceRule(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeTaskText(value).toLowerCase();
  const weekday = normalized.match(/^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(\s+when\s+done)?$/u);
  if (weekday) {
    return `every week on ${weekdayName(weekday[1])}${weekday[2] ? ' when done' : ''}`;
  }
  return normalizeTaskText(value);
}

function weekdayName(value: string): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const index = names.findIndex((day) => day.toLowerCase().startsWith(value.toLowerCase()));
  return names[index] ?? value;
}

export function sourceLineIdentity(rawLine: string): string {
  return updateMarkdownTaskLineStatus(rawLine, 'todo') ?? rawLine;
}

function taskLineMatchesRenderedTask(rawLine: string, task: MarkdownTask, options: UpdateMarkdownTaskCheckboxOptions): boolean {
  if (sourceLineIdentity(rawLine) === sourceLineIdentity(task.rawLine)) return true;
  return Boolean(options.allowLifecycleDateMismatch)
    && sourceLineIdentityForStatusUpdate(rawLine) === sourceLineIdentityForStatusUpdate(task.rawLine);
}

function findMatchingTaskLine(
  lines: ReadonlyArray<{ text: string; lineEnding: string }>,
  task: MarkdownTask,
  states: readonly TaskStateDefinition[],
): { lineIndex: number; line: { text: string; lineEnding: string }; currentTask: MarkdownTask; orgModeEnabled: boolean } | null {
  let match: { lineIndex: number; line: { text: string; lineEnding: string }; currentTask: MarkdownTask; orgModeEnabled: boolean } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const candidateLine = lines[index];
    const orgModeEnabled = isOrgKeywordTaskLine(task.rawLine) || isOrgKeywordTaskLine(candidateLine.text);
    const currentTask = parseMarkdownTaskLine(candidateLine.text, task.filePath, index + 1, states, task.heading, orgModeEnabled);
    if (!currentTask) continue;
    if (taskLineMatchesRenderedTask(candidateLine.text, task, { allowLifecycleDateMismatch: true })) {
      if (match) {
        throw new Error(`Cannot update task: rendered task matches multiple lines in ${task.filePath}; rescan before updating`);
      }
      match = { lineIndex: index, line: candidateLine, currentTask, orgModeEnabled };
    }
  }
  return match;
}

function sourceLineIdentityForStatusUpdate(rawLine: string): string {
  return stripStatusLifecycleDates(sourceLineIdentity(rawLine)).replace(/\s+$/u, '');
}

function stripStatusLifecycleDates(rawLine: string): string {
  const isoDateTime = String.raw`\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?`;
  const wikilinkDate = String.raw`\[\[${isoDateTime}(?:\|[^\]]*)?\]\]`;
  const lifecycleDateValue = String.raw`(?:${wikilinkDate}|${isoDateTime})(?:[ T]\d{1,2}:\d{2})?`;
  return rawLine
    .replace(new RegExp(String.raw`\s+✅${VS}\s*${lifecycleDateValue}`, 'gu'), '')
    .replace(new RegExp(String.raw`\s+(?:❌|⛔)${VS}\s*${lifecycleDateValue}`, 'gu'), '')
    .replace(new RegExp(String.raw`\s*[\[(](?:done|completion|completed|cancelled|canceled)::\s*${lifecycleDateValue}\s*[\])]`, 'giu'), '');
}

function isOrgKeywordTaskLine(rawLine: string): boolean {
  return ORG_KEYWORD_TASK_PATTERN.test(rawLine);
}

export function splitContentLines(content: string): Array<{ text: string; lineEnding: string }> {
  const lines: Array<{ text: string; lineEnding: string }> = [];
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu;

  for (const match of content.matchAll(linePattern)) {
    if (match[0] === '') {
      break;
    }
    lines.push({ text: match[1], lineEnding: match[2] });
  }

  return lines;
}

/**
 * Format a plain ISO date string according to the user's chosen date format.
 *
 * @param date   - ISO date string, e.g. `'2024-01-15'`
 * @param format - `'plain'` returns the date as-is; `'wikilink'` wraps it in `[[...]]`.
 * @returns The formatted date string ready to be embedded in a task line.
 *
 * @example
 * formatDateField('2024-01-15', 'plain')    // → '2024-01-15'
 * formatDateField('2024-01-15', 'wikilink') // → '[[2024-01-15]]'
 */
export function formatDateField(date: string, format: 'plain' | 'wikilink'): string {
  return format === 'wikilink' ? `[[${date}]]` : date;
}

function normalizeOnCompletion(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/gu, '-');
  return normalized === '' ? undefined : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
