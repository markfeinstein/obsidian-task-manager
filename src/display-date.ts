import { getLocale } from './i18n';

const cache = new Map<string, Intl.DateTimeFormat>();

function formatterLocale(locale: string = getLocale()): string {
  return locale === 'pseudo' || locale === 'rtl-test' ? 'en' : locale;
}

export function formatIsoDisplayDate(
  isoDate: string,
  options: Intl.DateTimeFormatOptions,
  locale: string = getLocale(),
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return isoDate;
  const normalizedOptions = { ...options, timeZone: 'UTC' };
  const key = `${formatterLocale(locale)}\0${JSON.stringify(normalizedOptions)}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(formatterLocale(locale), normalizedOptions);
    cache.set(key, formatter);
  }
  return formatter.format(date);
}

export function formatIsoWeekday(isoDate: string, locale: string = getLocale()): string {
  return formatIsoDisplayDate(isoDate, { weekday: 'short' }, locale);
}

export function formatIsoMonthDay(isoDate: string, locale: string = getLocale()): string {
  return formatIsoDisplayDate(isoDate, { month: 'short', day: 'numeric' }, locale);
}
