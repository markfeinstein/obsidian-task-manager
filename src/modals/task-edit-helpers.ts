/**
 * task-edit-helpers.ts
 *
 * Shared helper functions and types for the task-edit modals and auto-suggest.
 * Extracted from main.ts so that modal files can import from here without
 * creating circular dependencies (no import of main.ts).
 */

import { todayString, resolveFlexibleDate } from '../date-utils';
import { parseNaturalDateInstruction, type DateTab } from '../task-line-toolbar';
import { applyTaskCompletionLifecycleToLine, durableCompletionDestinationAction } from '../task-scanner';
import type { TaskManagerSettings } from '../types';
import { parseNLPInput, formatParsedNLPAsTaskLine, type NLPLocale } from '../nlp-parser';
import { encodeCsvCell } from '../csv-utils';
import { parseTaskMetadata } from '../task-model';

// ── EditableTaskLine ─────────────────────────────────────────────────────────

export interface EditableTaskLine {
  linePrefix: string;
  indentation: string;
  listMarker: string;
  checkbox: string;
  description: string;
  priority: string;
  due: string;
  dueTimezone?: string;
  dueTime?: string;
  scheduledTime?: string;
  startTime?: string;
  scheduled: string;
  start: string;
  created: string;
  done: string;
  cancelled: string;
  reminder: string;
  time: string;
  recurrence: string;
  onCompletion: string;
  id: string;
  dependsOn: string;
  blockLink: string;
  usesDataview: boolean;
  effort: string;
  actual: string;
  followUp: string;
  cost: string;
  pinned: string;
  tags: string[];
  assignee: string;
  reviewer: string;
  project: string;
  team: string;
  recurrenceSeriesId: string;
  recurrenceCount: string;
}

// ── Utility helpers ──────────────────────────────────────────────────────────

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function randomTaskId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function csvEscape(value: string): string {
  return encodeCsvCell(value);
}

export function currentTimeString(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

const EDIT_METADATA_BOUNDARY = String.raw`(?=\s+(?:[📅📆🗓⏳⌛🛫✅➕⛔❌⏰⌚📌💵💰👀👤👁📋👥⏱🕐]|🔁|🏁|🆔|[🔺⏫🔼🔽⏬]|[\[(][A-Za-z_][A-Za-z0-9 _-]*::)|$)`;
const EDIT_ON_COMPLETION_ACTION_PATTERN = String.raw`(?:move[-\s]+to[-\s]+end|delete|archive|collect|keep)`;
const EDIT_ON_COMPLETION_ACTION_REGEX = new RegExp(String.raw`(?:^|\s)🏁\uFE0F?\s+(${EDIT_ON_COMPLETION_ACTION_PATTERN})(?=\s|$)`, 'iu');
const EDIT_ON_COMPLETION_PATTERN = new RegExp(String.raw`(?:^|\s)🏁\uFE0F?\s+(.+?)${EDIT_METADATA_BOUNDARY}`, 'u');

function normalizeEditableOnCompletion(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/gu, '-') ?? '';
}

// ── DOM helpers for editor integration ───────────────────────────────────────

export function syntheticContextMenuEvent(position: { x: number; y: number }): MouseEvent {
  if (typeof MouseEvent === 'function') {
    return new MouseEvent('contextmenu', { clientX: position.x, clientY: position.y });
  }
  return { clientX: position.x, clientY: position.y } as MouseEvent;
}

export function editorCommandMenuPosition(
  editor: unknown,
  cursor: { line: number; ch: number },
): { x: number; y: number } {
  const maybeEditor = editor as { cursorCoords?: (pos: { line: number; ch: number }, mode?: string) => { left?: number; right?: number; top?: number; bottom?: number } };
  const cursorCoords = maybeEditor.cursorCoords?.(cursor, 'window');
  if (cursorCoords && Number.isFinite(cursorCoords.left) && Number.isFinite(cursorCoords.bottom)) {
    return { x: cursorCoords.left ?? 16, y: cursorCoords.bottom ?? 16 };
  }
  const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
  const activeRect = activeElement && typeof (activeElement as HTMLElement).getBoundingClientRect === 'function'
    ? (activeElement as HTMLElement).getBoundingClientRect()
    : null;
  if (activeRect && Number.isFinite(activeRect.left) && Number.isFinite(activeRect.top)) {
    const xOffset = Math.max(16, Math.min(activeRect.width || 16, cursor.ch * 7));
    return { x: activeRect.left + xOffset, y: activeRect.top + Math.min(activeRect.height || 24, 24) };
  }
  const viewport = typeof window !== 'undefined' ? window : null;
  return viewport
    ? { x: Math.max(16, Math.round(viewport.innerWidth / 2)), y: Math.max(16, Math.round(viewport.innerHeight / 2)) }
    : { x: 16, y: 16 };
}

// ── EditableTaskLine construction & serialisation ────────────────────────────

export function emptyEditableTaskLine(): EditableTaskLine {
  return {
    linePrefix: '', indentation: '', listMarker: '-', checkbox: ' ',
    description: '', priority: 'normal', due: '', scheduled: '', start: '',
    created: '', done: '', cancelled: '', reminder: '', time: '', recurrence: '',
    onCompletion: '', id: '', dependsOn: '', blockLink: '', usesDataview: false,
    effort: '', actual: '', followUp: '', cost: '', pinned: '', tags: [],
    assignee: '', reviewer: '', project: '', team: '', recurrenceSeriesId: '', recurrenceCount: '',
  };
}

export function parseEditableTaskLine(line: string): EditableTaskLine {
  const match = line.match(/^((?:\s*>\s*)*)(\s*)((?:[-*+])|(?:\d+[.)]))\s+\[([^\]]+)\]\s+(.*)$/u);
  const body = match?.[5] ?? '';
  const metadata = parseTaskMetadata(body);
  const blockLink = body.match(/\s\^([A-Za-z0-9-]+)$/u)?.[0]?.trim() ?? '';
  const assignee = body.match(/(?:^|\s)👤\uFE0F?\s*@([\p{L}\p{N}_\/-]+)/u)?.[1] ?? matchDataviewField(body, 'assignee') ?? '';
  const reviewer = body.match(/(?:^|\s)👁\uFE0F?\s*@([\p{L}\p{N}_\/-]+)/u)?.[1] ?? matchDataviewField(body, 'reviewer') ?? '';
  const project = body.match(/(?:^|\s)📋\uFE0F?\s+([\p{L}\p{N}_\-. ]+?)(?=\s+[👤👁📋👥]|\s*$)/u)?.[1]?.trim() ?? matchDataviewField(body, 'project') ?? '';
  const team = body.match(/(?:^|\s)👥\uFE0F?\s+([\p{L}\p{N}_\-. ]+?)(?=\s+[👤👁📋👥]|\s*$)/u)?.[1]?.trim() ?? matchDataviewField(body, 'team') ?? '';
  return {
    ...emptyEditableTaskLine(),
    linePrefix: match?.[1] ?? '',
    indentation: match?.[2] ?? '',
    listMarker: match?.[3] ?? '-',
    checkbox: match?.[4] ?? ' ',
    usesDataview: /[\[(][A-Za-z][A-Za-z _-]*::/u.test(body),
    description: body
      .replace(/\s+[📅📆🗓⏳⌛🛫✅➕⛔❌]\uFE0F?\s*(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)/gu, '')
      .replace(/\s+⏰\uFE0F?\s*(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)/gu, '')
      .replace(/\s+⌚\uFE0F?\s*\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?/gu, '')
      .replace(/\s+⏱\uFE0F?\s*(?:[\d]+h\s*[\d]+m|[\d]+h|[\d]+m)/gu, '')
      .replace(/\s+🕐\uFE0F?\s*(?:[\d]+h\s*[\d]+m|[\d]+h|[\d]+m)/gu, '')
      .replace(/\s*[\[(][A-Za-z][A-Za-z _-]*::\s*(?:\[\[[^\]]+\]\]|[^\])]+)[\])]/gu, '')
      .replace(/\s+🔁\s+.+?(?=\s+(?:[📅📆🗓⏳⌛🛫✅➕⛔❌⏰📌💵💰]|🏁|🆔|[🔺⏫🔼🔽⏬])|$)/u, '')
      .replace(new RegExp(String.raw`(?:^|\s)🏁\uFE0F?\s+${EDIT_ON_COMPLETION_ACTION_PATTERN}(?=\s|$)`, 'giu'), '')
      .replace(new RegExp(String.raw`(?:^|\s)🏁\uFE0F?\s+.+?${EDIT_METADATA_BOUNDARY}`, 'gu'), '')
      .replace(/\s+🆔\s+\S+/u, '')
      .replace(/\s+⛔\uFE0F?\s+[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*(?=\s|$)/u, '')
      .replace(/\s+[🔺⏫🔼🔽⏬]/gu, '')
      .replace(/\s\^[A-Za-z0-9-]+$/u, '')
      .replace(/(?:^|\s)👤\uFE0F?\s*@[\p{L}\p{N}_\/-]+/gu, '')
      .replace(/(?:^|\s)👁\uFE0F?\s*@[\p{L}\p{N}_\/-]+/gu, '')
      .replace(/(?:^|\s)📋\uFE0F?\s+[\p{L}\p{N}_\-. ]+?(?=\s+[👤👁📋👥]|\s*$)/gu, '')
      .replace(/(?:^|\s)👥\uFE0F?\s+[\p{L}\p{N}_\-. ]+?(?=\s+[👤👁📋👥]|\s*$)/gu, '')
      .replace(/(?:^|\s)\uD83D\uDC64\uFE0F?\s*@[\p{L}\p{N}_\/-]+/gu, '')
      .replace(/(?:^|\s)\uD83D\uDC41\uFE0F?\s*@[\p{L}\p{N}_\/-]+/gu, '')
      .replace(/(?:^|\s)\uD83D\uDCCB\uFE0F?\s+[\p{L}\p{N}_\-. ]+?(?=\s+[👤👁📋👥]|\s*$)/gu, '')
      .replace(/(?:^|\s)\uD83D\uDC65\uFE0F?\s+[\p{L}\p{N}_\-. ]+?(?=\s+[👤👁📋👥]|\s*$)/gu, '')
      .replace(/(?:^|\s)👀\uFE0F?\s*(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)/gu, '')
      .replace(/(?:^|\s)📌\uFE0F?(?=\s|$)/gu, '')
      .replace(/(?:^|\s)[💵💰]\uFE0F?\s*[+-]?\d+(?:\.\d+)?(?=\s|$)/gu, '')
      .trim(),
    priority: parsePriorityFromLine(body),
    due: metadata.dates.due ?? (matchAnyDate(body, ['📅', '📆', '🗓']) || matchDataviewField(body, 'due')),
    dueTimezone: metadata.dueTimezone,
    dueTime: metadata.dates.dueTime,
    scheduledTime: metadata.dates.scheduledTime,
    startTime: metadata.dates.startTime,
    scheduled: metadata.dates.scheduled ?? (matchAnyDate(body, ['⏳', '⌛']) || matchDataviewField(body, 'scheduled')),
    start: metadata.dates.start ?? (matchDate(body, '🛫') || matchDataviewField(body, 'start')),
    created: matchDate(body, '➕') || matchDataviewField(body, 'created'),
    done: matchDate(body, '✅') || matchDataviewField(body, 'completion') || matchDataviewField(body, 'done'),
    cancelled: matchDate(body, '⛔') || matchDate(body, '❌') || matchDataviewField(body, 'cancelled'),
    reminder: matchReminderDate(body) ?? matchDataviewField(body, 'reminder'),
    time: body.match(/(?:^|\s)⌚\s*(\d{1,2}:\d{2})/u)?.[1] ?? matchDataviewField(body, 'time'),
    recurrence: body.match(/(?:^|\s)🔁\s+(.+?)(?=\s+(?:[📅📆🗓⏳⌛🛫✅➕⛔❌⏰📌💵💰]|🏁|🆔|[🔺⏫🔼🔽⏬])|$)/u)?.[1] ?? matchDataviewField(body, 'repeat'),
    onCompletion: normalizeEditableOnCompletion(EDIT_ON_COMPLETION_ACTION_REGEX.exec(body)?.[1] ?? EDIT_ON_COMPLETION_PATTERN.exec(body)?.[1] ?? (matchDataviewField(body, 'onCompletion') || matchDataviewField(body, 'on completion'))),
    id: body.match(/(?:^|\s)🆔\s+(\S+)/u)?.[1] ?? matchDataviewField(body, 'id'),
    dependsOn: matchEditableDependencyIds(body) || matchDataviewField(body, 'dependsOn') || matchDataviewField(body, 'depends on'),
    blockLink,
    effort: body.match(/(?:^|\s)⏱\uFE0F?\s*([\d]+h\s*[\d]+m|[\d]+h|[\d]+m)/u)?.[1] ?? (matchDataviewField(body, 'effort') || matchDataviewField(body, 'est')),
    actual: body.match(/(?:^|\s)🕐\uFE0F?\s*([\d]+h\s*[\d]+m|[\d]+h|[\d]+m)/u)?.[1] ?? (matchDataviewField(body, 'actual') || matchDataviewField(body, 'logged')),
    followUp: matchFollowUpDate(body) ?? (matchDataviewField(body, 'follow-up') || matchDataviewField(body, 'followup')),
    cost: matchEditableCost(body),
    pinned: matchEditablePinned(body),
    assignee,
    reviewer,
    project,
    team,
    recurrenceSeriesId: matchDataviewField(body, 'recurrenceSeriesId') || matchDataviewField(body, 'series') || matchDataviewField(body, 'seriesId'),
    recurrenceCount: matchDataviewField(body, 'recurrenceCount') ?? '',
  };
}

function matchEditableDependencyIds(body: string): string {
  const ids: string[] = [];
  const pattern = /(?:^|\s)⛔\uFE0F?\s+([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)(?=\s|$)/gu;
  for (const match of body.matchAll(pattern)) {
    const value = match[1];
    const firstToken = value.split(/\s*,\s*/u)[0];
    if (/^\d{4}-\d{2}-\d{2}$/u.test(firstToken)) continue;
    ids.push(...value.split(/\s*,\s*/u).map((e) => e.trim()).filter(Boolean));
  }
  return Array.from(new Set(ids)).join(',');
}

function matchEditableCost(body: string): string {
  return body.match(/(?:^|\s)[💵💰]\uFE0F?\s*([+-]?\d+(?:\.\d+)?)(?=\s|$)/u)?.[1]
    ?? (matchDataviewField(body, 'cost') || matchDataviewField(body, 'budget'));
}

function matchEditablePinned(body: string): string {
  if (/(?:^|\s)📌\uFE0F?(?=\s|$)/u.test(body)) return 'true';
  return matchDataviewField(body, 'pinned') || matchDataviewField(body, 'pin');
}

function isPinnedValueEnabled(value: string | undefined): boolean {
  return /^(?:true|yes|y|1|on|pinned)$/iu.test(value?.trim() ?? '');
}

export function formatEditableTaskLine(task: EditableTaskLine, configuredFormat: 'emoji' | 'dataview'): string {
  if (configuredFormat === 'dataview' || task.usesDataview) return formatDataviewTaskLine(task);
  const parts = [task.description.trim()];
  const priority = ({ lowest: '⏬', low: '🔽', medium: '🔼', high: '⏫', highest: '🔺', normal: '' } as Record<string, string>)[task.priority] ?? '';
  if (priority) parts.push(priority);
  if (task.recurrence.trim()) parts.push(`🔁 ${task.recurrence.trim()}`);
  if (task.created) parts.push(`➕ ${task.created}`);
  if (task.start) parts.push(`🛫 ${task.start}${task.startTime ? ` ${task.startTime}` : ''}`);
  if (task.scheduled) parts.push(`⏳ ${task.scheduled}${task.scheduledTime ? ` ${task.scheduledTime}` : ''}`);
  if (task.time.trim()) parts.push(`⌚ ${task.time.trim()}`);
  if (task.reminder.trim()) parts.push(`⏰ ${task.reminder.trim()}`);
  if (task.due) parts.push(`📅 ${task.due}${task.dueTime ? ` ${task.dueTime}` : ''}`);
  if (task.due && task.dueTimezone) parts.push(`[dueTimezone:: ${task.dueTimezone}]`);
  if (task.done) parts.push(`✅ ${task.done}`);
  if (task.cancelled) parts.push(`❌ ${task.cancelled}`);
  if (task.onCompletion.trim()) parts.push(`🏁 ${task.onCompletion.trim()}`);
  if (task.id.trim()) parts.push(`🆔 ${task.id.trim()}`);
  if (task.dependsOn.trim()) parts.push(`⛔ ${task.dependsOn.trim().replace(/\s+/gu, '')}`);
  if (task.effort?.trim()) parts.push(`⏱️ ${task.effort.trim()}`);
  if (task.actual?.trim()) parts.push(`🕐️ ${task.actual.trim()}`);
  if (task.followUp?.trim()) parts.push(`👀 ${task.followUp.trim()}`);
  if (isPinnedValueEnabled(task.pinned)) parts.push('📌');
  if (task.cost?.trim()) parts.push(`💵 ${task.cost.trim()}`);
  if (task.assignee?.trim()) parts.push(`👤 @${task.assignee.trim().replace(/^@/, '')}`);
  if (task.reviewer?.trim()) parts.push(`👁️ @${task.reviewer.trim().replace(/^@/, '')}`);
  if (task.project?.trim()) parts.push(`📋 ${task.project.trim()}`);
  if (task.team?.trim()) parts.push(`👥 ${task.team.trim()}`);
  if (task.recurrenceSeriesId?.trim()) parts.push(`[recurrenceSeriesId:: ${task.recurrenceSeriesId.trim()}]`);
  if (task.recurrenceCount?.trim()) parts.push(`[recurrenceCount:: ${task.recurrenceCount.trim()}]`);
  if (task.blockLink.trim()) parts.push(task.blockLink.trim());
  return `${task.linePrefix}${task.indentation}${task.listMarker} [${task.checkbox}] ${parts.filter(Boolean).join(' ')}`;
}

function formatDataviewTaskLine(task: EditableTaskLine): string {
  const parts = [task.description.trim()];
  if (task.priority !== 'normal') parts.push(`[priority:: ${task.priority}]`);
  if (task.recurrence.trim()) parts.push(`[repeat:: ${task.recurrence.trim()}]`);
  if (task.created) parts.push(`[created:: ${task.created}]`);
  if (task.start) parts.push(`[start:: ${task.start}${task.startTime ? ` ${task.startTime}` : ''}]`);
  if (task.scheduled) parts.push(`[scheduled:: ${task.scheduled}${task.scheduledTime ? ` ${task.scheduledTime}` : ''}]`);
  if (task.time.trim()) parts.push(`[time:: ${task.time.trim()}]`);
  if (task.reminder.trim()) parts.push(`[reminder:: ${task.reminder.trim()}]`);
  if (task.due) parts.push(`[due:: ${task.due}${task.dueTime ? ` ${task.dueTime}` : ''}]`);
  if (task.due && task.dueTimezone) parts.push(`[dueTimezone:: ${task.dueTimezone}]`);
  if (task.done) parts.push(`[completion:: ${task.done}]`);
  if (task.cancelled) parts.push(`[cancelled:: ${task.cancelled}]`);
  if (task.onCompletion.trim()) parts.push(`[onCompletion:: ${task.onCompletion.trim()}]`);
  if (task.id.trim()) parts.push(`[id:: ${task.id.trim()}]`);
  if (task.dependsOn.trim()) parts.push(`[dependsOn:: ${task.dependsOn.trim().replace(/\s+/gu, '')}]`);
  if (task.effort?.trim()) parts.push(`[effort:: ${task.effort.trim()}]`);
  if (task.actual?.trim()) parts.push(`[actual:: ${task.actual.trim()}]`);
  if (task.followUp?.trim()) parts.push(`[follow-up:: ${task.followUp.trim()}]`);
  if (task.pinned?.trim()) parts.push(`[pinned:: ${task.pinned.trim()}]`);
  if (task.cost?.trim()) parts.push(`[cost:: ${task.cost.trim()}]`);
  if (task.assignee?.trim()) parts.push(`[assignee:: ${task.assignee.trim().replace(/^@/, '')}]`);
  if (task.reviewer?.trim()) parts.push(`[reviewer:: ${task.reviewer.trim().replace(/^@/, '')}]`);
  if (task.project?.trim()) parts.push(`[project:: ${task.project.trim()}]`);
  if (task.team?.trim()) parts.push(`[team:: ${task.team.trim()}]`);
  if (task.recurrenceSeriesId?.trim()) parts.push(`[recurrenceSeriesId:: ${task.recurrenceSeriesId.trim()}]`);
  if (task.recurrenceCount?.trim()) parts.push(`[recurrenceCount:: ${task.recurrenceCount.trim()}]`);
  if (task.blockLink.trim()) parts.push(task.blockLink.trim());
  return `${task.linePrefix}${task.indentation}${task.listMarker} [${task.checkbox}] ${parts.filter(Boolean).join(' ')}`;
}

function parsePriorityFromLine(body: string): string {
  const dataviewPriority = matchDataviewField(body, 'priority').toLowerCase();
  if (dataviewPriority) return dataviewPriority === 'none' ? 'normal' : dataviewPriority;
  if (body.includes('🔺')) return 'highest';
  if (body.includes('⏫')) return 'high';
  if (body.includes('🔼')) return 'medium';
  if (body.includes('🔽')) return 'low';
  if (body.includes('⏬')) return 'lowest';
  return 'normal';
}

export function matchDataviewField(body: string, field: string): string {
  const escaped = escapeRegExp(field).replace(/\\ /gu, '[\\s_-]+');
  const value = body.match(new RegExp(`[\\[(]${escaped}::\\s*(\\[\\[[^\\]]+\\]\\]|[^\\])]+)[\\])]`, 'iu'))?.[1]?.trim() ?? '';
  return normalizeDataviewInlineValue(value);
}

function normalizeDataviewInlineValue(value: string): string {
  const match = value.match(/^\[\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?(?:\|[^\]]*)?\]\]$/u);
  return match ? `${match[1]}${match[2] ? ` ${match[2]}` : ''}` : value;
}

export function matchAnyDate(body: string, symbols: readonly string[]): string {
  for (const symbol of symbols) {
    const date = matchDate(body, symbol);
    if (date) return date;
  }
  return '';
}

export function matchDate(body: string, symbol: string): string {
  const match = body.match(new RegExp(`${escapeRegExp(symbol)}\\uFE0F?\\s*(?:\\[\\[(\\d{4}-\\d{2}-\\d{2})(?:[ T]\\d{1,2}:\\d{2})?(?:\\|[^\\]]*)?\\]\\]|(\\d{4}-\\d{2}-\\d{2}))`, 'u'));
  return match?.[1] ?? match?.[2] ?? '';
}

function matchReminderDate(body: string): string | undefined {
  const match = body.match(/(?:^|\s)⏰\uFE0F?\s*(?:\[\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?(?:\|[^\]]*)?\]\]|(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?)/u);
  const date = match?.[1] ?? match?.[3];
  const time = match?.[2] ?? match?.[4];
  return date ? `${date}${time ? ` ${time}` : ''}` : undefined;
}

function matchFollowUpDate(body: string): string | undefined {
  const match = body.match(/(?:^|\s)👀\uFE0F?\s*(?:\[\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?(?:\|[^\]]*)?\]\]|(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?)/u);
  const date = match?.[1] ?? match?.[3];
  const time = match?.[2] ?? match?.[4];
  return date ? `${date}${time ? ` ${time}` : ''}` : undefined;
}

// ── Task line rewriting ──────────────────────────────────────────────────────

export function rewriteTaskLineForStatus(
  line: string,
  checkbox: string,
  settings: TaskManagerSettings,
): string | null {
  if (!/^(?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\s+/u.test(line)) return null;
  if (settings.globalFilter && !line.toLowerCase().includes(settings.globalFilter.toLowerCase())) return null;
  const status = settings.supportedStates.find((s) => s.rawText === checkbox)?.type ?? 'untracked';
  let updated = line.replace(/^((?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[)[^\]]+(\]\s+)/u, `$1${checkbox}$2`);
  const timeSuffix = settings.dateTimeOnLifecycleDates ? ` ${currentTimeString()}` : '';
  const today = todayString();
  if (status === 'done' && settings.setDoneDate && !/(?:^|\s)✅\s*\d{4}-\d{2}-\d{2}/u.test(updated)) updated += ` ✅ ${today}${timeSuffix}`;
  if (status === 'cancelled' && settings.setCancelledDate && !/(?:^|\s)[❌⛔]\s*\d{4}-\d{2}-\d{2}/u.test(updated)) updated += ` ❌ ${today}${timeSuffix}`;
  return updated;
}

export function rewriteTaskLineForStatusWithLifecycle(
  line: string,
  checkbox: string,
  settings: TaskManagerSettings,
  shouldIncludeNextLine?: (nextLine: string) => boolean,
): string[] | null {
  if (!/^(?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\s+/u.test(line)) return null;
  if (settings.globalFilter && !line.toLowerCase().includes(settings.globalFilter.toLowerCase())) return null;
  if (durableCompletionDestinationAction(line, checkbox, settings.supportedStates, settings)) return null;
  return applyTaskCompletionLifecycleToLine(line, checkbox, settings.supportedStates, settings, undefined, shouldIncludeNextLine)
    ?? [rewriteTaskLineForStatus(line, checkbox, settings) ?? line];
}

export function rewriteSubmittedTaskLineForModal(line: string, settings: TaskManagerSettings): string[] | null {
  const parsed = parseEditableTaskLine(line);
  const status = settings.supportedStates.find((s) => s.rawText === parsed.checkbox)?.type ?? 'untracked';
  if (status === 'done') {
    if (durableCompletionDestinationAction(line, parsed.checkbox, settings.supportedStates, settings)) return null;
    return applyTaskCompletionLifecycleToLine(line, parsed.checkbox, settings.supportedStates, settings, parsed.done || todayString()) ?? [line];
  }
  return [line];
}

// ── Date normalisation helpers ───────────────────────────────────────────────

export function normalizeModalDate(value: string, onlyFuture = true): string {
  const expanded = expandDateAbbreviation(value).trim();
  if (!expanded) return '';
  return resolveFlexibleDate(expanded, todayString(), { onlyFuture }) ?? expanded;
}

export function buildModalStatusOptions(
  supportedStates: ReadonlyArray<{ rawText: string; name: string }>,
  currentCheckbox: string,
): Array<{ text: string; value: string }> {
  const options = supportedStates.map((state) => ({
    text: `${state.name} [- [${state.rawText}] ]`,
    value: state.rawText,
  }));
  if (currentCheckbox && !supportedStates.some((s) => s.rawText === currentCheckbox)) {
    options.push({ text: `Unknown [- [${currentCheckbox}] ]`, value: currentCheckbox });
  }
  return options;
}

export function resolveModalDateInput(value: string, today: string, onlyFuture: boolean): string | null {
  const expanded = expandDateAbbreviation(value).trim();
  if (!expanded) return null;
  return resolveFlexibleDate(expanded, today, { onlyFuture });
}

export function expandDateAbbreviation(value: string): string {
  const replacements: Readonly<Record<string, string>> = {
    td: 'today', tm: 'tomorrow', yd: 'yesterday',
    tw: 'this week', nw: 'next week', we: 'sat', weekend: 'sat',
  };
  const trimmed = value.trim().toLowerCase();
  return replacements[trimmed] ?? value;
}

export function computeModalLifecycleDates(
  previousStateType: string,
  nextStateType: string,
  parsed: { done: string; cancelled: string },
  settings: { setDoneDate: boolean; setCancelledDate: boolean },
  visibleDone: string | null,
  visibleCancelled: string | null,
  today: string = todayString(),
): { done: string; cancelled: string } {
  const transitioningToDone = nextStateType === 'done' && previousStateType !== 'done';
  const transitioningToCancelled = nextStateType === 'cancelled' && previousStateType !== 'cancelled';
  const transitioningAwayFromDone = previousStateType === 'done' && nextStateType !== 'done';
  const transitioningAwayFromCancelled = previousStateType === 'cancelled' && nextStateType !== 'cancelled';
  const autoDoneDate = settings.setDoneDate && transitioningToDone ? today : '';
  const autoCancelledDate = settings.setCancelledDate && transitioningToCancelled ? today : '';
  const done = visibleDone !== null
    ? (visibleDone || (nextStateType === 'done' && settings.setDoneDate ? today : ''))
    : (transitioningAwayFromDone ? '' : (autoDoneDate || parsed.done));
  const cancelled = visibleCancelled !== null
    ? (visibleCancelled || (nextStateType === 'cancelled' && settings.setCancelledDate ? today : ''))
    : (transitioningAwayFromCancelled ? '' : (autoCancelledDate || parsed.cancelled));
  return { done, cancelled };
}

export function suggestionDuplicatesExistingField(suggestion: string, parsed: EditableTaskLine): boolean {
  const value = suggestion.toLowerCase();
  const hasPriority = parsed.priority && parsed.priority !== 'normal';
  return (value.includes('📅') || value.includes('📆') || value.includes('🗓') || value.startsWith('[due::')) && Boolean(parsed.due)
    || (value.includes('⏳') || value.includes('⌛') || value.startsWith('[scheduled::')) && Boolean(parsed.scheduled)
    || (value.includes('🛫') || value.startsWith('[start::')) && Boolean(parsed.start)
    || (value.includes('➕') || value.startsWith('[created::')) && Boolean(parsed.created)
    || (value.includes('✅') || value.startsWith('[completion::')) && Boolean(parsed.done)
    || (value.includes('❌') || value.startsWith('[cancelled::')) && Boolean(parsed.cancelled)
    || (value.includes('⏰') || value.startsWith('[reminder::')) && Boolean(parsed.reminder)
    || (value.includes('🔺') || value.includes('⏫') || value.includes('🔼') || value.includes('🔽') || value.includes('⏬') || value.startsWith('[priority::') || /priority$/u.test(value)) && Boolean(hasPriority)
    || (value.includes('🔁') || value.startsWith('[repeat::')) && Boolean(parsed.recurrence)
    || (value.includes('🏁') || value.startsWith('[oncompletion::')) && Boolean(parsed.onCompletion)
    || (value.includes('🆔') || value.startsWith('[id::')) && Boolean(parsed.id);
}

// ── Auto-suggest helpers (exported for tests) ────────────────────────────────

export function autoSuggestDynamicSuggestions(query: string, dataviewMode: boolean, today: string = todayString()): string[] {
  if (!query) return [];
  const expanded = expandDateAbbreviation(query);
  const resolvedDate = resolveFlexibleDate(expanded, today, { onlyFuture: true });
  const suggestions: string[] = [];
  if (resolvedDate) {
    suggestions.push(
      dataviewMode ? `[due:: ${resolvedDate}]` : `📅 ${resolvedDate}`,
      dataviewMode ? `[scheduled:: ${resolvedDate}]` : `⏳ ${resolvedDate}`,
      dataviewMode ? `[start:: ${resolvedDate}]` : `🛫 ${resolvedDate}`,
      dataviewMode ? `[created:: ${resolvedDate}]` : `➕ ${resolvedDate}`,
      dataviewMode ? `[reminder:: ${resolvedDate} 09:00]` : `⏰ ${resolvedDate} 09:00`,
    );
  }
  const recurrenceQuery = query.match(/^(?:every|each)\s+/u) ? query.replace(/^each\s+/u, 'every ') : null;
  if (recurrenceQuery && !dataviewMode) suggestions.push(`🔁 ${recurrenceQuery}`);
  if (recurrenceQuery && dataviewMode) suggestions.push(`[repeat:: ${recurrenceQuery}]`);
  return suggestions;
}

const SLASH_DATE_OPTIONS = [
  'today', 'tomorrow', 'next week', 'next month',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;

/**
 * Parse a full task description with the NLP parser and return just the
 * metadata tokens (emoji + values) — the part that replaces the raw text.
 * Used for /nl command preview and resolution.
 */
export function resolveNlTaskDescription(description: string, today: string, locale: NLPLocale = 'en'): string {
  const parsed = parseNLPInput(description, today, locale);
  if (!parsed.description && parsed.tags.length === 0) return description;
  // Return only the metadata suffix (without the '- [ ] ' prefix and description)
  const fullLine = formatParsedNLPAsTaskLine(parsed, false, 'plain');
  // fullLine = '- [ ] <description> <meta> #tags'
  // We want just '<description> <meta> #tags' — the checkbox prefix is handled by the task line itself
  return fullLine.slice('- [ ] '.length);
}

export function buildNlDateTokens(instruction: string): string {
  const parsed = parseNaturalDateInstruction(instruction);
  const emoji: Record<DateTab, string> = { due: '📅', scheduled: '⏳', start: '🛫' };
  const tokens: string[] = [];
  for (const id of ['scheduled', 'start', 'due'] as DateTab[]) {
    const r = parsed.results[id];
    if (r) tokens.push(`${emoji[id]} ${r.iso}${r.time ? ` ${r.time}` : ''}`);
  }
  return tokens.join(' ');
}

export function buildSlashSuggestions(query: string, today: string): string[] {
  const q = query.slice(1).toLowerCase().trim();
  const rawAfterSlash = query.slice(1).trim();

  // /nl <full task description> — parse entire description with NLP
  const nlTaskMatch = /^(?:nl|task)\b\s*(.*)$/i.exec(rawAfterSlash);
  if (nlTaskMatch) {
    const description = nlTaskMatch[1].trim();
    if (description) {
      const preview = resolveNlTaskDescription(description, today);
      return [`/nl ${description}`].concat(preview !== description ? [`  → ${preview}`] : []);
    }
    return ['/nl buy groceries tomorrow urgent  (NL task — type description after /nl)'];
  }
  if (q && 'nl'.startsWith(q)) return ['/nl buy groceries tomorrow urgent  (NL task — type description after /nl)'];

  const WHEN_HINT = '/when due friday 2pm, start wednesday @ noon, scheduled next week';
  const nlMatch = /^(?:when|dates?|date)\b\s*(.*)$/i.exec(rawAfterSlash);
  if (nlMatch) {
    const instruction = nlMatch[1].trim();
    if (instruction && buildNlDateTokens(instruction)) return [`/when ${instruction}`];
    return [WHEN_HINT];
  }
  if (q && ('when'.startsWith(q) || (q.length >= 2 && 'dates'.startsWith(q)))) return [WHEN_HINT];
  const all: string[] = [
    ...SLASH_DATE_OPTIONS.map((d) => `/due ${d}`),
    ...SLASH_DATE_OPTIONS.map((d) => `/sched ${d}`),
    ...SLASH_DATE_OPTIONS.map((d) => `/start ${d}`),
    '/remind today 09:00', '/remind today 17:00', '/remind tomorrow 09:00', '/remind next week 09:00',
    '/priority highest', '/priority high', '/priority medium', '/priority low', '/priority lowest',
    '/repeat every day', '/repeat every weekday', '/repeat every week', '/repeat every 2 weeks',
    '/repeat every month', '/repeat every year', '/repeat every week on Monday',
    '/repeat every month for 3 times', '/repeat every day for 7 times',
    '/done keep', '/done delete', '/done archive', '/done move-to-end',
  ];
  if (!q) return all;
  return all.filter((s) => { const body = s.slice(1).toLowerCase(); return body.startsWith(q) || body.includes(` ${q}`); });
}

export function resolveSlashSuggestion(suggestion: string, today: string): string {
  const spaceIdx = suggestion.indexOf(' ');
  if (spaceIdx === -1) return suggestion;
  const cmd = suggestion.slice(1, spaceIdx).toLowerCase();
  const option = suggestion.slice(spaceIdx + 1);
  // /nl <description> — parse full NL description, replace token with expanded metadata
  if (cmd === 'nl' || cmd === 'task') return resolveNlTaskDescription(option.replace(/^\s*→\s*/, ''), today);
  const dateEmoji: Record<string, string> = { due: '📅', sched: '⏳', scheduled: '⏳', start: '🛫' };
  if (cmd === 'when' || cmd === 'dates' || cmd === 'date') return buildNlDateTokens(option) || option;
  if (dateEmoji[cmd]) { const resolved = resolveFlexibleDate(option, today) ?? option; return `${dateEmoji[cmd]} ${resolved}`; }
  if (cmd === 'remind' || cmd === 'reminder') {
    const timeMatch = option.match(/(\d{1,2}:\d{2})$/);
    const datePart = timeMatch ? option.slice(0, -(timeMatch[0].length)).trim() : option;
    const timePart = timeMatch ? timeMatch[0] : '';
    const resolved = resolveFlexibleDate(datePart, today) ?? datePart;
    return `⏰ ${resolved}${timePart ? ` ${timePart}` : ''}`;
  }
  if (cmd === 'priority' || cmd === 'p') {
    const priorityMap: Record<string, string> = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' };
    return priorityMap[option.toLowerCase()] ?? option;
  }
  if (cmd === 'repeat' || cmd === 'rec' || cmd === 'recurrence') return `🔁 ${option}`;
  if (cmd === 'done' || cmd === 'complete' || cmd === 'completion') return `🏁 ${option}`;
  return suggestion;
}

export function buildAtAssigneeSuggestions(query: string, existingAssignees: string[]): string[] {
  const search = query.slice(1).toLowerCase();
  const matches = existingAssignees
    .filter((name) => !search || name.toLowerCase().startsWith(search))
    .map((name) => `@${name}`)
    .sort();
  if (matches.length === 0) { const hint = search || 'name'; return [`@${hint} (new assignee)`]; }
  return matches;
}

export function resolveSuggestionValue(value: string): string {
  const today = new Date();
  const date = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;
  const tomorrow = new Date(today.getTime()); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = `${tomorrow.getFullYear()}-${`${tomorrow.getMonth() + 1}`.padStart(2, '0')}-${`${tomorrow.getDate()}`.padStart(2, '0')}`;
  const nextWeek = new Date(today.getTime()); nextWeek.setDate(nextWeek.getDate() + 7);
  const nextWeekDate = `${nextWeek.getFullYear()}-${`${nextWeek.getMonth() + 1}`.padStart(2, '0')}-${`${nextWeek.getDate()}`.padStart(2, '0')}`;
  const semantic: Record<string, string> = {
    '📅 due date': '📅 ', '⏳ scheduled date': '⏳ ', '🛫 start date': '🛫 ',
    '🔁 recurring (repeat)': '🔁 every ', '🏁 on completion': '🏁 ', '🆔 id': '🆔 ',
    '[due:: date]': '[due:: ]', '[scheduled:: date]': '[scheduled:: ]', '[start:: date]': '[start:: ]',
  };
  if (semantic[value]) return semantic[value];
  return value
    .replace(/reminder today/gu, date).replace(/created today/gu, date)
    .replace(/done today/gu, date).replace(/cancelled today/gu, date)
    .replace(/today/gu, date).replace(/tomorrow/gu, tomorrowDate)
    .replace(/next week/gu, nextWeekDate).replace(/generate id/gu, randomTaskId())
    .replace(/ priority$/u, '').replace('depends-on-id', '');
}

// ── parseQuickAddInput (exported for tests) ──────────────────────────────────

export function parseQuickAddInput(
  input: string,
  today: string,
): { description: string; dueDate: string; priority: string; tags: string[]; recurrence: string } {
  let text = input.trim();
  const tags: string[] = [];
  text = text.replace(/#([\w-]+)/gu, (_, tag: string) => { tags.push(tag); return ' '; });
  let priority = '';
  const priorityPatterns: Array<[RegExp, string]> = [
    [/\b(?:highest|critical)\s*priority\b|\b(?:highest|critical)\b/iu, '🔺'],
    [/\b(?:urgent|high\s*priority|high)\b/iu, '⏫'],
    [/\b(?:medium\s*priority|medium|normal)\b/iu, '🔼'],
    [/\b(?:low\s*priority|low)\b/iu, '🔽'],
    [/\b(?:lowest\s*priority|lowest)\b/iu, '⏬'],
  ];
  for (const [pattern, emoji] of priorityPatterns) {
    if (pattern.test(text)) { priority = emoji; text = text.replace(pattern, ' '); break; }
  }
  let recurrence = '';
  const recMatch = text.match(/\b(every\s+(?:day|week(?:day)?|month|year|\d+\s+days?|\d+\s+weeks?|\d+\s+months?)(?:\s+(?:until\s+\d{4}-\d{2}-\d{2}|for\s+\d+\s+times?))?)\b/iu);
  if (recMatch) { recurrence = recMatch[1].trim().toLowerCase(); text = text.replace(recMatch[0], ' '); }
  let dueDate = '';
  const datePhrasePattern = /\b(today|tomorrow|yesterday|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|in\s+\d+\s+days?|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/iu;
  const dateMatch = text.match(datePhrasePattern);
  if (dateMatch) {
    const resolved = resolveFlexibleDate(dateMatch[0].trim(), today);
    if (resolved) { dueDate = resolved; text = text.replace(dateMatch[0], ' '); }
  }
  return { description: text.replace(/\s+/gu, ' ').trim(), dueDate, priority, tags, recurrence };
}
