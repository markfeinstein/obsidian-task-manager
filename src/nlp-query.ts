import { addDate } from './date-utils';
import { parseNLPInput } from './nlp-parser';

function hasExplicitQuerySyntax(source: string): boolean {
  return /^(?:not done|done|status\b|priority\b|due\b|scheduled\b|start\b|happens\b|sort\s+by\b|group\s+by\b|limit\b|view\s*:|hide\b|show\b|text\s+includes\b|description\s+includes\b|tags?\s+includes\b|path\s+includes\b)/imu.test(source.trim());
}

function priorityWordFromEmoji(priority: string): string | null {
  return ({ '🔺': 'highest', '⏫': 'high', '🔼': 'medium', '🔽': 'low', '⏬': 'lowest' } as Record<string, string>)[priority] ?? null;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/**
 * Conservative natural-language-to-query fallback.
 *
 * This intentionally translates only high-confidence phrases and otherwise
 * returns null so the normal query parser remains the source of truth.
 */
export function naturalLanguageToTaskQuery(source: string, today: string): string | null {
  const input = source.trim().replace(/\s+/gu, ' ');
  if (!input || input.includes('\n') || hasExplicitQuerySyntax(input)) return null;

  const lines: string[] = [];

  if (/\b(?:overdue|past due|late)\b/iu.test(input)) {
    lines.push('not done', `due before ${today}`);
  } else if (/\b(?:completed|finished|done)\b/iu.test(input)) {
    lines.push('done');
  } else if (/\b(?:open|active|pending|todo|to do|not done)\b/iu.test(input)) {
    lines.push('not done');
  }

  if (/\bdue\s+today\b|\btoday(?:'s)?\s+(?:tasks?|todos?)\b/iu.test(input)) {
    if (!lines.includes('not done') && !lines.includes('done')) lines.push('not done');
    lines.push(`due on ${today}`);
  } else if (/\bdue\s+tomorrow\b/iu.test(input)) {
    if (!lines.includes('not done') && !lines.includes('done')) lines.push('not done');
    lines.push(`due on ${addDate(today, 'day', 1)}`);
  } else if (/\bdue\b|\bdeadline\b|\bby\b/iu.test(input)) {
    const parsed = parseNLPInput(input, today, 'en');
    if (parsed.dueDate) {
      if (!lines.includes('not done') && !lines.includes('done')) lines.push('not done');
      lines.push(`due on ${parsed.dueDate}`);
    }
  }

  const parsed = parseNLPInput(input, today, 'en');
  const priority = priorityWordFromEmoji(parsed.priority);
  if (priority && /\b(?:priority|urgent|asap|important|critical|highest|high|medium|low|lowest|someday|maybe|p[0-4])\b/iu.test(input)) {
    lines.push(`priority is ${priority}`);
  }

  for (const tag of parsed.tags) {
    lines.push(`tag includes ${tag}`);
  }

  const textMatch = input.match(/\b(?:about|containing|contains|with text)\s+([\p{L}\p{N}][\p{L}\p{N}\s_-]{1,60})$/iu);
  if (textMatch?.[1]) {
    lines.push(`description includes ${quoted(textMatch[1].trim())}`);
  }

  const unique = Array.from(new Set(lines));
  return unique.length > 0 ? unique.join('\n') : null;
}
