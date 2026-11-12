import { addIsoDays, addIsoMonths, addIsoWeeks, addIsoYears, isValidIsoDate, isoDateToUtcDate } from './iso-date';

export type NaturalDateLocale = 'en' | 'de' | 'fr' | 'ja' | 'zh';

export interface NaturalDateMatch {
  date: string;
  text: string;
  index: number;
}

type Unit = 'day' | 'week' | 'month' | 'year';
type Direction = 'next' | 'last' | 'this' | 'upcoming';

const EN_WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};
const DE_WEEKDAYS: Readonly<Record<string, number>> = {
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6,
};
const FR_WEEKDAYS: Readonly<Record<string, number>> = {
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
};
const JA_WEEKDAYS: Readonly<Record<string, number>> = {
  '日曜日': 0, '日曜': 0, '月曜日': 1, '月曜': 1, '火曜日': 2, '火曜': 2, '水曜日': 3, '水曜': 3,
  '木曜日': 4, '木曜': 4, '金曜日': 5, '金曜': 5, '土曜日': 6, '土曜': 6,
};
const ZH_WEEKDAYS: Readonly<Record<string, number>> = {
  '星期日': 0, '星期天': 0, '周日': 0, '周天': 0, '星期一': 1, '周一': 1, '星期二': 2, '周二': 2,
  '星期三': 3, '周三': 3, '星期四': 4, '周四': 4, '星期五': 5, '周五': 5, '星期六': 6, '周六': 6,
};

const DE_MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'] as const;
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'] as const;
const EN_MONTH_ALIASES: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const DE_MONTH_ALIASES: Readonly<Record<string, number>> = Object.fromEntries(DE_MONTHS.map((name, index) => [name, index + 1]));
const FR_MONTH_ALIASES: Readonly<Record<string, number>> = Object.fromEntries(FR_MONTHS.map((name, index) => [name, index + 1]));

const RELATIVE_DAYS: Readonly<Record<NaturalDateLocale, Readonly<Record<string, number>>>> = {
  en: { today: 0, tomorrow: 1, yesterday: -1 },
  de: { heute: 0, morgen: 1, übermorgen: 2, gestern: -1 },
  fr: { "aujourd'hui": 0, demain: 1, 'après-demain': 2, hier: -1 },
  ja: { '今日': 0, 'きょう': 0, '明日': 1, 'あした': 1, '明後日': 2, '昨日': -1 },
  zh: { '今天': 0, '明天': 1, '后天': 2, '後天': 2, '昨天': -1 },
};

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
};

function validToday(today: string): boolean { return isValidIsoDate(today); }
function normalize(value: string): string { return value.trim().toLocaleLowerCase().replace(/\s+/gu, ' '); }
function add(today: string, unit: Unit, count: number): string {
  return unit === 'day' ? addIsoDays(today, count)
    : unit === 'week' ? addIsoWeeks(today, count)
      : unit === 'month' ? addIsoMonths(today, count)
        : addIsoYears(today, count);
}
function parseCount(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number.parseInt(value, 10);
  const parts = value.split(/[ -]/u).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => WORD_NUMBERS[part] === undefined)) return null;
  return parts.reduce((sum, part) => sum + WORD_NUMBERS[part], 0);
}
function makeDate(year: number, month: number, day: number): string | null {
  const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidIsoDate(candidate) ? candidate : null;
}
function futureCalendarDate(month: number, day: number, explicitYear: number | undefined, today: string, onlyFuture: boolean): string | null {
  let year = explicitYear ?? isoDateToUtcDate(today).getUTCFullYear();
  let candidate = makeDate(year, month, day);
  if (!candidate) return null;
  if (onlyFuture && explicitYear === undefined && candidate < today) {
    year += 1;
    candidate = makeDate(year, month, day);
  }
  return candidate;
}
function weekdayDate(today: string, target: number, direction: Direction): string {
  const current = isoDateToUtcDate(today).getUTCDay();
  let delta = target - current;
  if (direction === 'next') delta = delta <= 0 ? delta + 7 : delta;
  else if (direction === 'last') delta = delta >= 0 ? delta - 7 : delta;
  else if (direction === 'upcoming') delta = delta < 0 ? delta + 7 : delta;
  else {
    const currentIso = (current + 6) % 7;
    const targetIso = (target + 6) % 7;
    delta = targetIso - currentIso;
  }
  return addIsoDays(today, delta);
}
function periodAnchor(today: string, direction: Direction, unit: Exclude<Unit, 'day'>): string {
  const offset = direction === 'next' ? 1 : direction === 'last' ? -1 : 0;
  if (unit === 'week') {
    const date = isoDateToUtcDate(today);
    const monday = addIsoDays(today, -((date.getUTCDay() + 6) % 7));
    return addIsoWeeks(monday, offset);
  }
  const shifted = unit === 'month' ? addIsoMonths(today, offset) : addIsoYears(today, offset);
  const date = isoDateToUtcDate(shifted);
  return unit === 'month'
    ? makeDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) ?? shifted
    : `${date.getUTCFullYear()}-01-01`;
}

function parseEnglish(value: string, today: string, onlyFuture: boolean): string | null {
  const relative = value.match(/^(?:in|within)\s+([a-z\d -]+)\s+(day|week|month|year)s?(?:\s+from\s+now)?$/u)
    ?? value.match(/^([a-z\d -]+)\s+(day|week|month|year)s?\s+from\s+now$/u);
  if (relative) {
    const count = parseCount(relative[1]);
    return count === null ? null : add(today, relative[2] as Unit, count);
  }
  const ago = value.match(/^([a-z\d -]+)\s+(day|week|month|year)s?\s+ago$/u);
  if (ago) {
    const count = parseCount(ago[1]);
    return count === null ? null : add(today, ago[2] as Unit, -count);
  }
  const period = value.match(/^(next|last|this)\s+(week|month|year)$/u);
  if (period) return periodAnchor(today, period[1] as Direction, period[2] as Exclude<Unit, 'day'>);
  const weekday = value.match(/^(?:(next|last|this)\s+)?(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)$/u);
  if (weekday) return weekdayDate(today, EN_WEEKDAYS[weekday[2]], (weekday[1] as Direction | undefined) ?? (onlyFuture ? 'upcoming' : 'this'));
  const monthDay = value.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/u)
    ?? value.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\s+(\d{4}))?$/u);
  if (monthDay) {
    const firstMonth = EN_MONTH_ALIASES[monthDay[1]] !== undefined;
    const month = EN_MONTH_ALIASES[firstMonth ? monthDay[1] : monthDay[2]];
    const day = Number.parseInt(firstMonth ? monthDay[2] : monthDay[1], 10);
    const year = Number.parseInt(monthDay[3] ?? '', 10);
    return futureCalendarDate(month, day, Number.isNaN(year) ? undefined : year, today, onlyFuture);
  }
  const monthOnly = EN_MONTH_ALIASES[value];
  if (monthOnly !== undefined) return futureCalendarDate(monthOnly, 1, undefined, today, onlyFuture);
  const numeric = value.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/u);
  if (numeric) {
    const yearRaw = numeric[3];
    const year = yearRaw ? (yearRaw.length === 2 ? 2000 + Number.parseInt(yearRaw, 10) : Number.parseInt(yearRaw, 10)) : undefined;
    return futureCalendarDate(Number.parseInt(numeric[1], 10), Number.parseInt(numeric[2], 10), year, today, onlyFuture);
  }
  return null;
}

function parseEuropean(value: string, today: string, locale: 'de' | 'fr', onlyFuture: boolean): string | null {
  const weekdays = locale === 'de' ? DE_WEEKDAYS : FR_WEEKDAYS;
  const months = locale === 'de' ? DE_MONTH_ALIASES : FR_MONTH_ALIASES;
  const directionWords = locale === 'de'
    ? { next: /^(?:nächste[nsr]?|kommende[nsr]?)\s+/u, last: /^(?:letzte[nsr]?)\s+/u, this: /^(?:diese[nsr]?)\s+/u }
    : { next: /^(?:prochain|prochaine)\s+/u, last: /^(?:dernier|dernière)\s+/u, this: /^(?:ce|cette)\s+/u };
  let direction: Direction = onlyFuture ? 'upcoming' : 'this';
  let remainder = value;
  if (locale === 'fr') {
    const suffix = remainder.match(/\s+(prochain|prochaine|dernier|dernière)$/u);
    if (suffix) {
      direction = suffix[1].startsWith('prochain') ? 'next' : 'last';
      remainder = remainder.slice(0, -(suffix[0].length));
    }
  }
  for (const [candidate, pattern] of Object.entries(directionWords) as Array<[Direction, RegExp]>) {
    if (pattern.test(remainder)) { direction = candidate; remainder = remainder.replace(pattern, ''); break; }
  }
  if (weekdays[remainder] !== undefined) return weekdayDate(today, weekdays[remainder], direction);
  const monthDay = value.match(/^(\d{1,2})(?:er)?\s+([\p{L}.]+)(?:\s+(\d{4}))?$/u)
    ?? value.match(/^([\p{L}.]+)\s+(\d{1,2})(?:er)?(?:\s+(\d{4}))?$/u);
  if (monthDay) {
    const firstMonth = months[monthDay[1].replace(/\.$/u, '')] !== undefined;
    const monthName = (firstMonth ? monthDay[1] : monthDay[2]).replace(/\.$/u, '');
    const month = months[monthName];
    if (month === undefined) return null;
    const day = Number.parseInt(firstMonth ? monthDay[2] : monthDay[1], 10);
    const year = Number.parseInt(monthDay[3] ?? '', 10);
    return futureCalendarDate(month, day, Number.isNaN(year) ? undefined : year, today, onlyFuture);
  }
  return null;
}

function parseAsian(value: string, today: string, locale: 'ja' | 'zh', onlyFuture: boolean): string | null {
  const weekdays = locale === 'ja' ? JA_WEEKDAYS : ZH_WEEKDAYS;
  let direction: Direction = onlyFuture ? 'upcoming' : 'this';
  let remainder = value;
  const qualifiers: Array<[RegExp, Direction]> = locale === 'ja'
    ? [[/^(?:次の|来週の?)/u, 'next'], [/^(?:前の|先週の?)/u, 'last'], [/^(?:今週の?|この)/u, 'this']]
    : [[/^(?:下周|下星期)/u, 'next'], [/^(?:上周|上星期)/u, 'last'], [/^(?:本周|这周|這周)/u, 'this']];
  for (const [pattern, candidate] of qualifiers) {
    if (pattern.test(remainder)) { direction = candidate; remainder = remainder.replace(pattern, ''); break; }
  }
  const weekdayKey = Object.keys(weekdays).find((key) => remainder === key || (locale === 'zh' && remainder === key.replace(/^(?:星期|周)/u, '')));
  if (weekdayKey) return weekdayDate(today, weekdays[weekdayKey], direction);
  const fullDate = value.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/u);
  if (fullDate) return makeDate(Number.parseInt(fullDate[1], 10), Number.parseInt(fullDate[2], 10), Number.parseInt(fullDate[3], 10));
  const monthDay = value.match(/^(\d{1,2})月(\d{1,2})日?$/u);
  if (monthDay) return futureCalendarDate(Number.parseInt(monthDay[1], 10), Number.parseInt(monthDay[2], 10), undefined, today, onlyFuture);
  return null;
}

export function parseNaturalDate(rawValue: string, today: string, locale: NaturalDateLocale = 'en', onlyFuture = false): string | null {
  if (!validToday(today)) return null;
  const value = normalize(rawValue);
  if (!value) return null;
  if (isValidIsoDate(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}/u.test(value)) return null;
  const relative = RELATIVE_DAYS[locale][value];
  if (relative !== undefined) return addIsoDays(today, relative);
  if (locale === 'en') return parseEnglish(value, today, onlyFuture);
  return locale === 'de' || locale === 'fr'
    ? parseEuropean(value, today, locale, onlyFuture)
    : parseAsian(value, today, locale, onlyFuture);
}

function candidatePatterns(locale: NaturalDateLocale): RegExp[] {
  const shared = [/\b\d{4}-\d{2}-\d{2}\b/gu];
  if (locale === 'en') return [...shared,
    /\b(?:today|tomorrow|yesterday)\b/giu,
    /\b(?:(?:in|within)\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?\s+(?:days?|weeks?|months?|years?)(?:\s+(?:ago|from\s+now))?\b/giu,
    /\b(?:next|last|this)\s+(?:week|month|year)\b/giu,
    /\b(?:(?:next|last|this)\s+)?(?:sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\b/giu,
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/giu,
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\s+\d{4})?\b/giu,
    /\b\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})\b/gu,
  ];
  if (locale === 'de') return [...shared,
    /\b(?:heute|übermorgen|morgen|gestern)\b/giu,
    /\b(?:(?:nächste[nsr]?|kommende[nsr]?|letzte[nsr]?|diese[nsr]?)\s+)?(?:sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend)\b/giu,
    /\b(?:\d{1,2}(?:er)?\s+)?(?:januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)(?:\s+\d{1,2}(?:er)?)?(?:\s+\d{4})?\b/giu,
  ];
  if (locale === 'fr') return [...shared,
    /\b(?:aujourd'hui|après-demain|demain|hier)\b/giu,
    /\b(?:(?:prochain|prochaine|dernier|dernière|ce|cette)\s+)?(?:dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)(?:\s+(?:prochain|prochaine|dernier|dernière))?\b/giu,
    /\b(?:\d{1,2}(?:er)?\s+)?(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)(?:\s+\d{1,2}(?:er)?)?(?:\s+\d{4})?\b/giu,
  ];
  if (locale === 'ja') return [...shared,
    /(?:明後日|今日|きょう|明日|あした|昨日)/gu,
    /(?:(?:次の|来週の?|前の|先週の?|今週の?|この))?(?:日曜日|日曜|月曜日|月曜|火曜日|火曜|水曜日|水曜|木曜日|木曜|金曜日|金曜|土曜日|土曜)/gu,
    /(?:\d{4}年)?\d{1,2}月\d{1,2}日?/gu,
  ];
  return [...shared,
    /(?:今天|明天|后天|後天|昨天)/gu,
    /(?:(?:下周|下星期|上周|上星期|本周|这周|這周))?(?:星期日|星期天|周日|周天|星期一|周一|星期二|周二|星期三|周三|星期四|周四|星期五|周五|星期六|周六)/gu,
    /(?:\d{4}年)?\d{1,2}月\d{1,2}日?/gu,
  ];
}

export function findNaturalDates(text: string, today: string, locale: NaturalDateLocale = 'en', onlyFuture = true): NaturalDateMatch[] {
  if (!validToday(today)) return [];
  const candidates: Array<{ text: string; index: number }> = [];
  for (const pattern of candidatePatterns(locale)) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) candidates.push({ text: match[0], index: match.index ?? 0 });
  }
  candidates.sort((left, right) => left.index - right.index || right.text.length - left.text.length);
  const results: NaturalDateMatch[] = [];
  let occupiedUntil = -1;
  for (const candidate of candidates) {
    if (candidate.index < occupiedUntil) continue;
    const date = parseNaturalDate(candidate.text, today, locale, onlyFuture);
    if (!date) continue;
    results.push({ date, text: candidate.text, index: candidate.index });
    occupiedUntil = candidate.index + candidate.text.length;
  }
  return results;
}
