export interface IsoDateParts { year: number; month: number; day: number }

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function parseIsoDate(value: string | undefined): IsoDateParts | null {
  if (!value) return null;
  const match = value.match(ISO_DATE);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > daysInIsoMonth(year, month)) return null;
  return { year, month, day };
}

export function isValidIsoDate(value: string | undefined): boolean { return parseIsoDate(value) !== null; }

export function isoDateToUtcDate(value: string): Date {
  const parts = parseIsoDate(value);
  if (!parts) throw new Error(`Invalid date '${value}'.`);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

export function formatUtcDate(date: Date): string {
  return formatIsoParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function formatLocalDate(date: Date): string {
  return formatIsoParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function daysInIsoMonth(year: number, month: number): number {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || month < 1 || month > 12) return 0;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addIsoDays(value: string, days: number): string {
  const date = isoDateToUtcDate(value);
  date.setUTCDate(date.getUTCDate() + Math.trunc(days));
  return formatUtcDate(date);
}

export function addIsoWeeks(value: string, weeks: number): string { return addIsoDays(value, Math.trunc(weeks) * 7); }

export function addIsoMonths(value: string, months: number): string {
  const parts = parseIsoDate(value);
  if (!parts) throw new Error(`Invalid date '${value}'.`);
  const target = new Date(Date.UTC(parts.year, parts.month - 1 + Math.trunc(months), 1));
  const month = target.getUTCMonth() + 1;
  return formatIsoParts(target.getUTCFullYear(), month, Math.min(parts.day, daysInIsoMonth(target.getUTCFullYear(), month)));
}

export function addIsoYears(value: string, years: number): string { return addIsoMonths(value, Math.trunc(years) * 12); }

export function diffIsoDays(start: string, end: string): number {
  return Math.round((isoDateToUtcDate(end).getTime() - isoDateToUtcDate(start).getTime()) / 86_400_000);
}

function formatIsoParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
