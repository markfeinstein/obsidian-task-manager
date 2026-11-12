/**
 * NLP Parser for Task Manager
 * Extracts task metadata from natural language input using deterministic local date parsing.
 * INPUT is always plain English — emoji appear only in the output task line.
 *
 * Supported patterns (no emoji input needed):
 *   Dates:       "tomorrow", "next Monday", "June 10", "in 3 days"
 *   Due marker:  "due Friday", "deadline next week", "by Thursday"
 *   Scheduled:   "scheduled for Monday", "on Tuesday" (with time → scheduled)
 *   Start:       "starting Wednesday", "from next month"
 *   Time:        "at 3pm", "at 9:30", "at noon"  →  stored as time; uses scheduled date
 *   Priority:    "urgent", "important", "asap", "high priority", "low priority", "critical"
 *   Tags:        #shopping #work
 *   Recurrence:  "every week", "every Monday", "every 2 weeks", "biweekly", "fortnightly"
 *                "recurring weekly", "repeating daily"
 *   Effort:      "for 2 hours", "30 minutes", "1.5h"
 */

import { resolveFlexibleDate } from './date-utils';
import { formatLocalDate } from './iso-date';
import { findNaturalDates, parseNaturalDate } from './natural-date-parser';

export type NLPLocale = 'en' | 'de' | 'fr' | 'ja' | 'zh';

function resolveNLPLocale(locale: string): NLPLocale {
  return locale === 'de' || locale === 'fr' || locale === 'ja' || locale === 'zh' ? locale : 'en';
}

// ── Priority ─────────────────────────────────────────────────────────────────
// English: require "priority" qualifier for ambiguous words (high/low) to avoid
// false positives in "high school", "low battery", etc.
// "medium" and "normal" standalone are kept — they're rare as adjectives in task context.
// Unambiguous standalone words (urgent, asap, important, critical) match freely.
const PRIORITY_KEYWORDS: Record<NLPLocale, Array<[RegExp, string]>> = {
  en: [
    [/\b(?:critical|highest\s*priority|p0)\b/iu, '\uD83D\uDD3A'],
    [/\b(?:urgent|asap|important|high\s*priority|p1)\b/iu, '\u23EB'],
    [/\b(?:medium\s*priority|medium|normal\s*priority|p2)\b/iu, '\uD83D\uDD3C'],
    [/\b(?:low\s*priority|not\s*urgent|p3)\b/iu, '\uD83D\uDD3D'],
    [/\b(?:lowest\s*priority|someday|maybe|p4)\b/iu, '\u23EC'],
  ],
  de: [
    [/\b(?:kritisch|höchste\s*priorität|p0)\b/iu, '\uD83D\uDD3A'],
    [/\b(?:dringend|wichtig|hohe\s*priorität|p1)\b/iu, '\u23EB'],
    [/\b(?:mittlere\s*priorität|mittel|normale\s*priorität|normal|p2)\b/iu, '\uD83D\uDD3C'],
    [/\b(?:niedrige\s*priorität|nicht\s*dringend|p3)\b/iu, '\uD83D\uDD3D'],
    [/\b(?:niedrigste\s*priorität|irgendwann|p4)\b/iu, '\u23EC'],
  ],
  fr: [
    [/\b(?:critique|très\s*haute\s*priorit[eé]|p0)(?!\w)/iu, '\uD83D\uDD3A'],
    [/\b(?:urgent|important|haute\s*priorit[eé]|p1)(?!\w)/iu, '\u23EB'],
    [/\b(?:priorit[eé]\s*moyenne|priorit[eé]\s*normale|p2)(?!\w)/iu, '\uD83D\uDD3C'],
    [/\b(?:basse\s*priorit[eé]|pas\s*urgent|p3)(?!\w)/iu, '\uD83D\uDD3D'],
    [/\b(?:priorit[eé]\s*la\s*plus\s*basse|peut-être|p4)(?!\w)/iu, '\u23EC'],
  ],
  ja: [
    [/(?:最高|極めて\s*高い|緊急)(?:\s*優先度)?\b/u, '\uD83D\uDD3A'],
    [/(?:緊急|重要|高\s*優先度)\b/u, '\u23EB'],
    [/(?:中|通常)(?:\s*優先度)?\b/u, '\uD83D\uDD3C'],
    [/(?:低\s*優先度|急ぎでない)\b/u, '\uD83D\uDD3D'],
    [/(?:最低|極めて\s*低い)(?:\s*優先度)?\b/u, '\u23EC'],
  ],
  zh: [
    [/(?:最高|极其|紧急)(?:\s*优先级)?\b/u, '\uD83D\uDD3A'],
    [/(?:紧急|重要|高\s*优先级)\b/u, '\u23EB'],
    [/(?:中|普通)(?:\s*优先级)?\b/u, '\uD83D\uDD3C'],
    [/(?:低\s*优先级|不紧急)\b/u, '\uD83D\uDD3D'],
    [/(?:最低|极低)(?:\s*优先级)?\b/u, '\u23EC'],
  ],
};

// ── Recurrence ────────────────────────────────────────────────────────────────
// Covers: "every week", "every Monday", "every 2 weeks", "every other day",
//         "biweekly", "bi-weekly", "fortnightly", "recurring weekly",
//         "repeating daily"
const RECURRENCE_PATTERNS: Record<NLPLocale, RegExp> = {
  en: /\b(bi-?weekly|fortnightly|(?:recurring|repeating)\s+(?:daily|weekly|monthly|yearly)|every\s+(?:other\s+)?(?:day|week(?:day)?(?:\s+on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)(?:\s+and\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun))*)?|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|\d+\s+days?|\d+\s+weeks?|\d+\s+months?|\d+\s+years?)(?:\s+(?:until\s+\d{4}-\d{2}-\d{2}|for\s+\d+\s+times?))?)\b/iu,
  de: /\b(alle?\s+(?:tage?|wochen?|monate?|jahre?|\d+\s+tage?|\d+\s+wochen?|\d+\s+monate?)(?:\s+(?:bis\s+\d{4}-\d{2}-\d{2}|für\s+\d+\s+mal))?)\b/iu,
  fr: /\b((?:tous?\s+les?|chaque)\s+(?:jours?|semaines?|mois|ans?|\d+\s+jours?|\d+\s+semaines?|\d+\s+mois)(?:\s+(?:jusqu'au\s+\d{4}-\d{2}-\d{2}|pendant\s+\d+\s+fois))?)\b/iu,
  ja: /((?:毎|每)\s*(?:日|週|月|年|\d+日|\d+週|\d+月)(?:\s+(?:\d{4}-\d{2}-\d{2}\s*まで|\d+\s*回))?)/u,
  zh: /((?:每|每个)\s*(?:天|周|月|年|\d+天|\d+周|\d+月)(?:\s+(?:到\s+\d{4}-\d{2}-\d{2}|重复\d+次))?)/u,
};

/** Normalize captured recurrence text to canonical scanner form. */
function normalizeRecurrence(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const aliases: Record<string, string> = {
    daily:               'every day',
    'recurring daily':   'every day',
    'repeating daily':   'every day',
    weekly:              'every week',
    'recurring weekly':  'every week',
    'repeating weekly':  'every week',
    biweekly:            'every 2 weeks',
    'bi-weekly':         'every 2 weeks',
    fortnightly:         'every 2 weeks',
    monthly:             'every month',
    'recurring monthly': 'every month',
    'repeating monthly': 'every month',
    yearly:              'every year',
    'recurring yearly':  'every year',
    'repeating yearly':  'every year',
  };
  const normalised = aliases[lower] ?? lower;
  // "every other N" → "every 2 Ns"
  return normalised.replace(/every\s+other\s+(weekday|day|week|month|year)/iu, (_, u: string) => `every 2 ${u}s`);
}

export interface ParsedNLPResult {
  description: string;
  dueDate?: string;
  scheduledDate?: string;
  startDate?: string;
  time?: string;         // HH:MM extracted from "at 3pm", "at 9:30"
  priority: string;
  tags: string[];
  recurrence: string;
  effort?: string;       // e.g. "2h", "30m"
  context?: string;
  fullText: string;
}

/**
 * Parse natural language task input.
 * All input should be plain English — no emoji required.
 */
export function parseNLPInput(
  input: string,
  today: string = getTodayDateString(),
  locale: string = 'en',
): ParsedNLPResult {
  let text = input.trim();
  const fullText = text;
  const nlpLocale = resolveNLPLocale(locale);

  // ── 1. Tags ────────────────────────────────────────────────────────────────
  const tags: string[] = [];
  text = text.replace(/#([\p{L}\p{N}\w-]+)/gu, (_, tag: string) => {
    tags.push(tag);
    return ' ';
  });

  // ── 2. Priority ────────────────────────────────────────────────────────────
  let priority = '';
  for (const [pattern, emoji] of PRIORITY_KEYWORDS[nlpLocale]) {
    if (pattern.test(text)) {
      priority = emoji;
      text = text.replace(pattern, ' ');
      break;
    }
  }

  // ── 3. Recurrence ──────────────────────────────────────────────────────────
  let recurrence = '';
  const recMatch = text.match(RECURRENCE_PATTERNS[nlpLocale]);
  if (recMatch) {
    recurrence = normalizeRecurrence(recMatch[1]);
    text = text.replace(recMatch[0], ' ');
  }

  // ── 4. Time ("at 3pm", "at 9:30", "at noon", "at midnight") ───────────────
  // Extract before effort/date so "for 2 hours at 3pm" doesn't lose the time.
  let time: string | undefined;
  const timePattern = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)\b/iu;
  const timeMatch = text.match(timePattern);
  if (timeMatch) {
    const normalizedTime = normalizeTime(timeMatch[1]);
    if (normalizedTime) {
      time = normalizedTime;
      text = text.replace(timeMatch[0], ' ');
    }
  }

  // ── 5. Effort ("for 2 hours", "30 minutes", "1.5h") ───────────────────────
  let effort = '';
  const durationPatterns: Array<{
    pattern: RegExp;
    extract: (match: RegExpMatchArray) => string;
    reject?: (match: RegExpMatchArray, source: string) => boolean;
  }> = [
    { pattern: /(?:(?:for|pendant|takes?)\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|heures?|hrs?|h)\b(?!\s*\d)/giu, extract: (match) => `${match[1]}h` },
    { pattern: /(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/giu, extract: (match) => `${match[1]}m` },
    {
      pattern: /(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:days?)\b(?!\s*ago|\s*from)/giu,
      extract: (match) => `${match[1]}d`,
      reject: (match, source) => !/^for\s/iu.test(match[0]) && /\b(?:in|within)\s+-?\s*$/iu.test(source.slice(0, match.index ?? 0)),
    },
  ];
  durationLoop: for (const { pattern, extract, reject } of durationPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (reject?.(match, text)) continue;
      effort = extract(match);
      const matchIndex = match.index ?? 0;
      text = `${text.slice(0, matchIndex)} ${text.slice(matchIndex + match[0].length)}`;
      break durationLoop;
    }
  }

  // ── 6. Explicit date markers ("due Friday", "scheduled for Monday", etc.) ──
  const dateMarkers = extractDateMarkers(text, today, nlpLocale);
  let dueDate       = dateMarkers.dueDate;
  let scheduledDate = dateMarkers.scheduledDate;
  let startDate     = dateMarkers.startDate;
  text              = dateMarkers.remainingText;

  // ── 7. Generic deterministic date extraction ───────────────────────────────
  if (!dueDate && !scheduledDate) {
    const { dates: genericDates, rawTexts } = extractNaturalDates(text, today, nlpLocale);
    if (genericDates.length > 0) {
      // If a time was found → treat the date as SCHEDULED (it's an appointment)
      // Otherwise treat it as DUE.
      if (time) {
        scheduledDate = genericDates[0];
      } else {
        dueDate = genericDates[0];
      }
      if (genericDates.length > 1) {
        startDate = genericDates[0];
        if (time) {
          scheduledDate = genericDates[1];
        } else {
          dueDate = genericDates[1];
        }
      }
    }
    text = removeDatesFromText(text, genericDates, rawTexts);
  } else if (time && dueDate && !scheduledDate) {
    // User wrote "due Friday at 3pm" — treat as scheduled, not deadline
    scheduledDate = dueDate;
    dueDate = undefined;
  }

  // ── 8. Clean up ────────────────────────────────────────────────────────────
  const description = text.replace(/\s+/gu, ' ').trim();

  return {
    description,
    dueDate:       dueDate       || undefined,
    scheduledDate: scheduledDate || undefined,
    startDate:     startDate     || undefined,
    time,
    priority,
    tags,
    recurrence,
    effort:  effort  || undefined,
    fullText,
  };
}

/** Parse "3pm", "9:30am", "noon", "midnight" → "15:00", "09:30", "12:00", "00:00" */
function normalizeTime(raw: string): string | undefined {
  const lower = raw.trim().toLowerCase();
  if (lower === 'noon') return '12:00';
  if (lower === 'midnight') return '00:00';
  const m = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/u);
  if (!m) return undefined;
  let hours = Number.parseInt(m[1], 10);
  const mins = m[2] ? Number.parseInt(m[2], 10) : 0;
  const meridiem = m[3];
  if (mins > 59) return undefined;
  if (meridiem) {
    if (hours < 1 || hours > 12) return undefined;
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  } else if (hours > 23) {
    return undefined;
  }
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function extractDateMarkers(text: string, today: string, locale: NLPLocale): {
  dueDate?: string; scheduledDate?: string; startDate?: string; remainingText: string;
} {
  const DATE_CAPTURE = `((?:(?:next|last|this)\\s+)?(?:\\d{4}-\\d{2}-\\d{2}|[a-z]+(?:\\s+\\d{1,2})?(?:\\s+\\d{4})?|today|tomorrow|yesterday|\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?))`;

  const dueMarkers:       Record<NLPLocale, string> = { en: 'due|deadline|by',           de: 'fällig|termin|bis',                fr: 'dû|échéance|par',              ja: '期限|締切|までに', zh: '截止|期限|到'       };
  const scheduledMarkers: Record<NLPLocale, string> = { en: 'scheduled?(?:\\s+for)?|on', de: 'geplant(?:\\s+für)?|terminiert',   fr: 'planifié(?:\\s+pour)?|prévu',  ja: '予定(?:\\s+の)?',  zh: '计划(?:\\s+在)?|安排' };
  const startMarkers:     Record<NLPLocale, string> = { en: 'start(?:ing)?|from|begin(?:ning)?', de: 'start(?:ing)?|ab|von|beginnen', fr: 'commençant|à partir de|débuter', ja: 'スタート|開始|から', zh: '开始|从|开始于' };

  const tryExtract = (markers: string, remaining: string): [string | undefined, string] => {
    const pat = new RegExp(`(?:^|\\s)(?:${markers})(?:\\s+(?:on|by|for))?\\s+${DATE_CAPTURE}`, 'iu');
    const m = remaining.match(pat);
    if (m) {
      const phrase = m[1].trim();
      const resolved = parseNaturalDate(phrase, today, locale, true)
        ?? resolveFlexibleDate(phrase, today, { onlyFuture: true });
      if (resolved) return [resolved, remaining.replace(m[0], ' ')];
    }

    const markerPat = new RegExp(`(?:^|\\s)(?:${markers})(?:\\s+(?:on|by|for))?\\s+(.+)$`, 'iu');
    const markerMatch = remaining.match(markerPat);
    if (markerMatch) {
      const parsed = extractLeadingNaturalDate(markerMatch[1], today, locale);
      if (parsed) {
        const markerStart = markerMatch.index ?? remaining.indexOf(markerMatch[0]);
        const removeTo = markerStart + markerMatch[0].length - markerMatch[1].length + parsed.rawText.length;
        return [parsed.date, `${remaining.slice(0, markerStart)} ${remaining.slice(removeTo)}`];
      }
    }
    return [undefined, remaining];
  };

  const [dueDate, afterDue]             = tryExtract(dueMarkers[locale],       text);
  const [scheduledDate, afterScheduled] = tryExtract(scheduledMarkers[locale], afterDue);
  const [startDate, remainingText]      = tryExtract(startMarkers[locale],     afterScheduled);

  return { dueDate, scheduledDate, startDate, remainingText };
}

function extractLeadingNaturalDate(text: string, today: string, locale: NLPLocale): { date: string; rawText: string } | undefined {
  const result = findNaturalDates(text, today, locale, true).find((item) => item.index === 0);
  return result ? { date: result.date, rawText: result.text } : undefined;
}

function extractNaturalDates(text: string, today: string, locale: NLPLocale = 'en'): { dates: string[]; rawTexts: string[] } {
  const dates: string[] = [];
  const rawTexts: string[] = [];
  for (const result of findNaturalDates(text, today, locale, true)) {
    if (!dates.includes(result.date)) dates.push(result.date);
    rawTexts.push(result.text);
  }
  return { dates, rawTexts };
}

function removeDatesFromText(text: string, dates: string[], rawTexts: string[] = []): string {
  let result = text;
  for (const raw of rawTexts) result = result.replace(raw, ' ');
  for (const date of dates) {
    result = result.replace(new RegExp(`\\b${date.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'gu'), ' ');
  }
  result = result.replace(/\b(?:on|at)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu, ' ');
  result = result.replace(/\b(?:next|last|this)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year)\b/iu, ' ');
  result = result.replace(/\b(?:today|tomorrow|yesterday)\b/iu, ' ');
  return result;
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/**
 * Format a ParsedNLPResult into a Markdown task line.
 * Emoji are added here in the output — users never need to type them.
 */
export function formatParsedNLPAsTaskLine(
  parsed: ParsedNLPResult,
  includeCreatedDate = false,
  dateFormat: 'plain' | 'wikilink' = 'plain',
): string {
  if (!parsed.description && parsed.tags.length === 0) return '';

  const fmt = (emoji: string, date: string) =>
    dateFormat === 'wikilink' ? `${emoji} [[${date}]]` : `${emoji} ${date}`;

  const parts: string[] = [];
  if (parsed.priority)                                               parts.push(parsed.priority);
  if (parsed.dueDate)                                                parts.push(fmt('📅', parsed.dueDate));
  if (parsed.scheduledDate && parsed.scheduledDate !== parsed.dueDate) parts.push(fmt('⏳', parsed.scheduledDate));
  if (parsed.startDate && parsed.startDate !== parsed.dueDate && parsed.startDate !== parsed.scheduledDate)
                                                                     parts.push(fmt('🛫', parsed.startDate));
  if (parsed.time)                                                   parts.push(`⏰ ${parsed.time}`);
  if (parsed.effort)                                                 parts.push(`⏱️ ${parsed.effort}`);
  if (parsed.recurrence)                                             parts.push(`🔁 ${parsed.recurrence}`);
  if (includeCreatedDate)                                            parts.push(`➕ ${getTodayDateString()}`);

  const tags = parsed.tags.length > 0 ? ` ${parsed.tags.map((t) => `#${t}`).join(' ')}` : '';
  const meta = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  return `- [ ] ${parsed.description}${meta}${tags}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format the current local calendar date. */
function getTodayDateString(): string { return formatLocalDate(new Date()); }
