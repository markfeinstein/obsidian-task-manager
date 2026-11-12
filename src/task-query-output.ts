import type { MarkdownTask as ParsedTask } from './task-model';
import { encodeCsvCell } from './csv-utils';

export function serializeTaskQueryCsv(tasks: readonly ParsedTask[]): string {
  const header = ['File', 'Line', 'Status', 'Content', 'Priority', 'Due Date', 'Tags'].join(',');
  const rows = tasks.map((task) => [
    task.filePath,
    String(task.lineNumber),
    task.checkbox,
    task.normalizedText,
    task.metadata.priority,
    task.metadata.dates.due || '',
    task.tags.join(' '),
  ].map((field) => encodeCsvCell(String(field ?? ''))).join(','));
  return [header, ...rows].join('\n');
}

function escapeMarkdownField(field: string): string {
  return field.replace(/[|[\]()]/gu, '\\$&');
}

export function serializeTaskQueryMarkdown(tasks: readonly ParsedTask[]): string {
  const header = '| File | Line | Status | Content | Priority | Due Date |';
  const separator = '|------|------|--------|---------|----------|----------|';
  const rows = tasks.map((task) =>
    `| ${escapeMarkdownField(task.filePath)} | ${task.lineNumber} | ${task.checkbox} | ${escapeMarkdownField(task.normalizedText)} | ${task.metadata.priority} | ${task.metadata.dates.due || ''} |`);
  return [header, separator, ...rows, '', `**Total: ${tasks.length} tasks**`].join('\n');
}
