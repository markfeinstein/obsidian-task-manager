import { normalizeTaskText, sourceLineIdentity, splitContentLines } from './task-model';
import { type ParsedTask, TaskScanner } from './task-scanner';

export interface ReminderTaskExpectation {
  filePath: string;
  lineNumber: number;
  taskText: string;
  reminder: string;
}

/**
 * Resolve the task represented by a reminder without trusting its stale line number.
 * The original line is used when it still matches. Otherwise relocation succeeds only
 * when exactly one task in the same file matches the persisted identity and reminder.
 */
export function resolveReminderTaskForCompletion(
  content: string,
  expected: ReminderTaskExpectation,
  scanner: TaskScanner,
): ParsedTask {
  const expectedTask = scanner.parseTaskLine(expected.taskText, expected.filePath, expected.lineNumber);
  const expectedIdentity = expectedTask ? sourceLineIdentity(expectedTask.rawLine) : null;
  const expectedNormalizedText = expectedTask?.normalizedText || normalizeTaskText(expected.taskText);

  const matchesExpected = (candidate: ParsedTask): boolean => {
    if (candidate.metadata.reminder !== expected.reminder) return false;
    if (expectedTask && candidate.status !== expectedTask.status) return false;
    if (expectedTask?.stableKey) return candidate.stableKey === expectedTask.stableKey;
    if (expectedIdentity) return sourceLineIdentity(candidate.rawLine) === expectedIdentity;
    return candidate.normalizedText === expectedNormalizedText;
  };

  const lines = splitContentLines(content);
  const originalLine = lines[expected.lineNumber - 1]?.text;
  if (originalLine) {
    const originalTask = scanner.parseTaskLine(originalLine, expected.filePath, expected.lineNumber);
    if (originalTask && matchesExpected(originalTask)) return originalTask;
  }

  const matches: ParsedTask[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = scanner.parseTaskLine(lines[index].text, expected.filePath, index + 1);
    if (candidate && matchesExpected(candidate)) matches.push(candidate);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('Reminder task moved and now matches multiple tasks; no task was completed');
  throw new Error('Reminder task no longer matches the expected task; no task was completed');
}
