import { normalizeTaskText, stripTaskMetadata } from './task-model';
import { isValidIsoDate } from './date-utils';

export type SyncPriority = 'high' | 'medium' | 'low';

const LEADING_TASK_MARKER_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]]*)\]\s*/u;
const PRIORITY_EMOJI_PATTERN = '[🔺⏫🔼🔽⏬]\uFE0F?';
const PRIORITY_EMOJI_MAP: Readonly<Record<string, SyncPriority>> = {
  '🔺': 'high',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'low',
};

export function taskLineCheckbox(taskLine: string): string | undefined {
  return taskLine.match(LEADING_TASK_MARKER_PATTERN)?.[1];
}

export function taskLineCompleted(taskLine: string): boolean {
  return taskLineCheckbox(taskLine)?.toLowerCase() === 'x';
}

export function taskLineTitle(taskLine: string, separators: RegExp): string {
  const body = taskLine.replace(LEADING_TASK_MARKER_PATTERN, '');
  const serviceTitle = stripTaskMetadata(body).split(new RegExp(`${separators.source}|\\s+${PRIORITY_EMOJI_PATTERN}`, separators.flags))[0];
  return normalizeTaskText(serviceTitle.replace(/(?:^|\s+)\[(?:\/|>)\](?=\s|$)/gu, ' '));
}

export function taskLineDueDate(taskLine: string): string | undefined {
  const date = taskLine.match(/[📅📆🗓]\uFE0F?\s+(?:\[\[)?(\d{4}-\d{2}-\d{2})(?=\]\]|[|\s]|$)/u)?.[1];
  return isValidIsoDate(date) ? date : undefined;
}

export function taskLinePriority(taskLine: string): SyncPriority | undefined {
  const label = taskLine.match(/🎯\s+(high|medium|low)(?=\s|$)/iu)?.[1]?.toLowerCase() as SyncPriority | undefined;
  if (label) return label;
  const emoji = taskLine.match(new RegExp(PRIORITY_EMOJI_PATTERN, 'u'))?.[0]?.replace(/\uFE0F$/u, '');
  return emoji ? PRIORITY_EMOJI_MAP[emoji] : undefined;
}

export function taskLineAssignee(taskLine: string): string | undefined {
  const assignee = taskLine.match(/👤\s+(.+?)(?=\s+(?:[📅📆🗓]|🎯|👤|🔁|🆔|🏁|[🔺⏫🔼🔽⏬]|\[[^\]]+::)|$)/u)?.[1];
  return assignee ? normalizeTaskText(assignee) : undefined;
}

export function taskLineServiceId(taskLine: string, service: string): string | undefined {
  const escapedService = service.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return taskLine.match(new RegExp(String.raw`(?:^|\s)\[id::\s*${escapedService}:([^\]\s]+)\]`, 'u'))?.[1];
}

export function priorityLabelFromNumber(priority: number | undefined, map: Record<number, SyncPriority>): SyncPriority | undefined {
  return priority === undefined ? undefined : map[priority];
}
