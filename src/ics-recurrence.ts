import { isValidIsoDate } from './date-utils';

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function positive(value: string, maximum = 2_147_483_647): boolean {
  return /^\d+$/u.test(value) && Number(value) > 0 && Number(value) <= maximum;
}

function validUntil(value: string): boolean {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/u);
  return Boolean(match && isValidIsoDate(`${match[1]}-${match[2]}-${match[3]}`)
    && (match[4] === undefined || (Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59)));
}

/** Deliberately bounded RFC subset: unsupported rules fail instead of being silently changed. */
function validateRFC(rule: string): string {
  const parts = new Map<string, string>();
  for (const part of rule.toUpperCase().split(';')) {
    const match = part.match(/^([A-Z]+)=([^=;]+)$/u);
    if (!match || parts.has(match[1])) throw new Error('Invalid or duplicate RFC recurrence rule part');
    parts.set(match[1], match[2]);
  }
  const frequency = parts.get('FREQ');
  if (!frequency || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(frequency)) throw new Error('Unsupported RFC recurrence frequency');
  if (parts.has('COUNT') && parts.has('UNTIL')) throw new Error('RFC recurrence cannot combine COUNT and UNTIL');
  for (const [key, value] of parts) {
    let valid = key === 'FREQ';
    if (key === 'INTERVAL' || key === 'COUNT') valid = positive(value);
    if (key === 'UNTIL') valid = validUntil(value);
    if (key === 'WKST') valid = DAYS.includes(value);
    if (key === 'BYMONTH') valid = value.split(',').every((part) => positive(part, 12));
    if (key === 'BYMONTHDAY') valid = frequency !== 'WEEKLY' && value.split(',').every((part) => /^-?\d+$/u.test(part) && Math.abs(Number(part)) >= 1 && Math.abs(Number(part)) <= 31);
    if (key === 'BYDAY') valid = value.split(',').every((part) => {
      const match = part.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/u);
      return Boolean(match && (!match[1] || (['MONTHLY', 'YEARLY'].includes(frequency) && Math.abs(Number(match[1])) >= 1 && Math.abs(Number(match[1])) <= (frequency === 'MONTHLY' ? 5 : 53))));
    });
    if (!valid) throw new Error(`Unsupported or invalid RFC recurrence field ${key}`);
  }
  return [...parts].map(([key, value]) => `${key}=${value}`).join(';');
}

function weekdays(value: string): string | undefined {
  const tokens = value.split(/\s*(?:,|\band\b)\s*/u);
  const days = tokens.map((token) => DAY_NAMES.findIndex((name) => token.length >= 3 && name.startsWith(token)));
  return days.length && days.every((day) => day >= 0) ? [...new Set(days)].map((day) => DAYS[day]).join(',') : undefined;
}

/** Only emit executable Markdown recurrence when the local grammar can preserve it. */
export function fromICSRecurrenceRule(input: string): string | undefined {
  let validated: string;
  try { validated = validateRFC(input); } catch { return undefined; }
  const parts = new Map(validated.split(';').map((part) => part.split('=') as [string, string]));
  if (parts.has('BYMONTH') || (parts.has('WKST') && parts.get('WKST') !== 'MO')) return undefined;
  const frequency = parts.get('FREQ') ?? '';
  const units: Record<string, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
  const interval = parts.get('INTERVAL') ?? '1';
  let result = `every ${interval === '1' ? '' : `${interval} `}${units[frequency]}${interval === '1' ? '' : 's'}`;
  const byDay = parts.get('BYDAY');
  if (byDay) {
    const days = byDay.split(',');
    if (frequency !== 'WEEKLY' || days.some((day) => !DAYS.includes(day))) return undefined;
    result += ` on ${days.map((day) => DAY_NAMES[DAYS.indexOf(day)]).join(' and ')}`;
  }
  const monthDay = parts.get('BYMONTHDAY');
  if (monthDay) {
    if (frequency !== 'MONTHLY' || !positive(monthDay, 28)) return undefined;
    result += ` on day ${Number(monthDay)}`;
  }
  const until = parts.get('UNTIL');
  if (until) {
    if (!/^\d{8}(?:T235959)?$/u.test(until)) return undefined;
    result += ` until ${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  }
  if (parts.has('COUNT')) result += ` for ${parts.get('COUNT')} times`;
  return result;
}

export interface ICSRecurrenceOptions { count?: number; until?: string; timed?: boolean; anchor?: string }

/** Scheduled rules only: completion-relative recurrence has no faithful fixed RRULE. */
export function toICSRecurrenceRule(input: string, options: ICSRecurrenceOptions = {}): string {
  if (!input.trim() || input.length > 2048 || /[\r\n\u0000]/u.test(input)) throw new Error('Invalid recurrence rule for ICS export');
  let rule = input.toLowerCase().trim();
  if (rule.includes('when done')) throw new Error('Completion-relative recurrence cannot be represented by a fixed ICS RRULE');
  if (/^freq=/u.test(rule)) return validateRFC(rule);
  let count = options.count;
  let until = options.until;
  rule = rule.replace(/\s+for\s+(\d+)\s+times?$/u, (_match, value: string) => { count ??= Number(value); return ''; });
  rule = rule.replace(/\s+until\s+(\d{4}-\d{2}-\d{2})$/u, (_match, value: string) => { until ??= value; return ''; });
  const aliases: Record<string, string> = { daily: 'every day', weekly: 'every week', monthly: 'every month', yearly: 'every year' };
  rule = aliases[rule] ?? rule;
  const namedDays = rule.startsWith('every ') ? weekdays(rule.slice(6)) : undefined;
  const match = rule.match(/^every(?:\s+(\d+|other))?\s+(day|weekday|week|month|year)s?(?:\s+on\s+(.+))?$/u);
  let result: string;
  if (namedDays) result = `FREQ=WEEKLY;BYDAY=${namedDays}`;
  else if (match) {
    const interval = match[1] === 'other' ? '2' : match[1] ?? '1';
    if (!positive(interval)) throw new Error('Invalid recurrence interval');
    const frequencies: Record<string, string> = { day: 'DAILY', weekday: 'WEEKLY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
    if (!match[3] && options.anchor && ((match[2] === 'month' && Number(options.anchor.slice(8, 10)) > 28) || (match[2] === 'year' && options.anchor.slice(5) === '02-29'))) throw new Error('Clamped month/year recurrence cannot be faithfully represented by a fixed ICS RRULE');
    result = `FREQ=${frequencies[match[2]]}${interval === '1' ? '' : `;INTERVAL=${interval}`}`;
    if (match[2] === 'weekday') {
      if (interval !== '1' || match[3]) throw new Error('Unsupported weekday recurrence interval');
      result += ';BYDAY=MO,TU,WE,TH,FR';
    } else if (match[3]) {
      const byDay = weekdays(match[3]);
      const monthDay = match[3].match(/^(?:the\s+)?(?:day\s+)?(\d{1,2})(?:st|nd|rd|th)?$/u)?.[1];
      if (match[2] === 'week' && byDay) result += `;BYDAY=${byDay}`;
      else if (match[2] === 'month' && monthDay && positive(monthDay, 28)) result += `;BYMONTHDAY=${Number(monthDay)}`;
      else throw new Error('Unsupported recurrence qualifier for ICS export');
    }
  } else throw new Error(`Unsupported recurrence for ICS export: ${input}`);
  if (count !== undefined) result += `;COUNT=${count}`;
  if (until !== undefined) {
    if (!isValidIsoDate(until)) throw new Error('Invalid recurrence end date');
    result += `;UNTIL=${until.replace(/-/gu, '')}${options.timed ? 'T235959' : ''}`;
  }
  return validateRFC(result);
}
