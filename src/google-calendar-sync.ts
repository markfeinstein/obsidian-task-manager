import { ProviderHttpError, requestResponse, retryAfterMilliseconds } from './network-request';
import { buildPkceAuthorizationUrl, exchangeAuthorizationCodeForToken, parseOAuthCode, refreshOAuthAccessToken, type OAuthPkceStart, type OAuthTokenResponse } from './oauth-pkce';
import type { MarkdownTask } from './task-model';
import { normalizeTaskText, stripTaskMetadata } from './task-model';
import { addIsoDays as addDays } from './iso-date';

export interface GoogleCalendarConfig {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  calendarId?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

export interface GoogleCalendarEvent {
  id?: string;
  summary: string;
  description?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  status?: 'confirmed' | 'cancelled' | 'tentative';
  reminders?: { useDefault: boolean; overrides?: Array<{ method: 'popup' | 'email'; minutes: number }> };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const GOOGLE_CALENDAR_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_CALENDAR_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALENDAR_DEFAULT_REDIRECT_URI = 'http://localhost:42813/oauth/google-calendar/callback';

export function googleCalendarAuthHeader(config: GoogleCalendarConfig): Record<string, string> {
  const accessToken = config.accessToken?.trim();
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

export function assertGoogleCalendarMutationCredentials(config: GoogleCalendarConfig): void {
  if (!config.accessToken?.trim()) throw new Error('Google Calendar write operations require an OAuth access token');
}

export function googleCalendarId(config: GoogleCalendarConfig): string {
  return config.calendarId?.trim() || 'primary';
}

export async function googleCalendarPkceOAuthStart(
  clientId: string,
  options: { redirectUri?: string; state?: string; codeVerifier?: string } = {},
): Promise<OAuthPkceStart> {
  return buildPkceAuthorizationUrl({
    authorizationEndpoint: GOOGLE_CALENDAR_AUTH_ENDPOINT,
    clientId,
    redirectUri: options.redirectUri ?? GOOGLE_CALENDAR_DEFAULT_REDIRECT_URI,
    scope: GOOGLE_CALENDAR_SCOPE,
    state: options.state,
    codeVerifier: options.codeVerifier,
    extraParams: { access_type: 'offline', prompt: 'consent' },
  });
}

export async function exchangeGoogleCalendarAuthorizationCode(options: {
  clientId: string;
  codeOrCallbackUrl: string;
  codeVerifier: string;
  redirectUri?: string;
  expectedState?: string;
  signal?: AbortSignal;
}): Promise<OAuthTokenResponse> {
  const { code, state } = parseOAuthCode(options.codeOrCallbackUrl);
  if (options.expectedState !== undefined && state !== options.expectedState) {
    throw new Error('OAuth callback state did not match the active login session');
  }
  return exchangeAuthorizationCodeForToken({
    tokenEndpoint: GOOGLE_CALENDAR_TOKEN_ENDPOINT,
    clientId: options.clientId,
    code,
    codeVerifier: options.codeVerifier,
    redirectUri: options.redirectUri ?? GOOGLE_CALENDAR_DEFAULT_REDIRECT_URI,
    signal: options.signal,
  });
}

export async function refreshGoogleCalendarAccessToken(options: {
  clientId: string;
  refreshToken: string;
  signal?: AbortSignal;
}): Promise<OAuthTokenResponse> {
  return refreshOAuthAccessToken({
    tokenEndpoint: GOOGLE_CALENDAR_TOKEN_ENDPOINT,
    clientId: options.clientId,
    refreshToken: options.refreshToken,
    scope: GOOGLE_CALENDAR_SCOPE,
    signal: options.signal,
  });
}

function cleanSummary(task: MarkdownTask): string {
  return normalizeTaskText(stripTaskMetadata(task.normalizedText || task.body)).replace(/(^|\s)#google-calendar\b/giu, ' ').replace(/\s+/gu, ' ').trim() || task.body.trim() || 'Untitled task';
}

function addMinutesToDateTime(date: string, time: string, minutes: number): { date: string; time: string } {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  // Timed events use the runtime's IANA zone, so duration arithmetic must use
  // local instants rather than UTC-shaped wall-clock components. This carries a
  // one-hour default across DST gaps/overlaps correctly (for example 01:30 →
  // 03:30 on a spring-forward day).
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  d.setMinutes(d.getMinutes() + minutes);
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
}

function taskEventDateTime(task: MarkdownTask): { date: string; time: string } | null {
  const reminderTimed = task.metadata.reminder?.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/u);
  if (reminderTimed) return { date: reminderTimed[1], time: reminderTimed[2] };

  const candidates: Array<{ date?: string; time?: string }> = [
    { date: task.metadata.dates.scheduled, time: task.metadata.dates.scheduledTime },
    { date: task.metadata.dates.due, time: task.metadata.dates.dueTime },
    { date: task.metadata.dates.start, time: task.metadata.dates.startTime },
  ];
  for (const candidate of candidates) {
    if (candidate.date && candidate.time) return { date: candidate.date, time: candidate.time };
  }

  const timeStart = task.metadata.timeStart;
  const date = task.metadata.dates.scheduled ?? task.metadata.dates.due ?? task.metadata.dates.start;
  if (date && timeStart) return { date, time: timeStart };
  return null;
}

function googleCalendarTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function clockMinutes(value: string | undefined): number | null {
  const match = value?.match(/^(\d{1,2}):(\d{2})$/u);
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function googleCalendarTimedEnd(date: string, startTime: string, endTime: string | undefined, timeZone: string | undefined): { dateTime: string; timeZone?: string } | null {
  if (!endTime) return null;
  const start = clockMinutes(startTime);
  const end = clockMinutes(endTime);
  if (start === null || end === null) return null;
  const endDate = end <= start ? addDays(date, 1) : date;
  return { dateTime: `${endDate}T${endTime}:00`, ...(timeZone ? { timeZone } : {}) };
}

export function googleCalendarEventIdFromTaskId(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  if (!trimmed) return undefined;
  const prefixed = trimmed.match(/^google-calendar:(.+)$/u)?.[1] ?? trimmed.match(/^gcal-(.+)$/u)?.[1];
  return prefixed?.trim() || undefined;
}

async function sha256Hex(value: string): Promise<string> {
  const normalized = value.trim();
  if (!normalized) throw new Error('Google Calendar sync requires a stable non-empty task identity');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Google Calendar sync requires Web Crypto SHA-256 support');
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(normalized)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Deterministic Google-valid ID and non-reversible private mapping evidence. */
export async function identifyGoogleCalendarEvent(
  event: GoogleCalendarEvent,
  stableTaskSyncKey: string,
  assignDeterministicId: boolean,
): Promise<GoogleCalendarEvent> {
  const digest = await sha256Hex(stableTaskSyncKey);
  const deterministicId = `otm${digest}`;
  return {
    ...event,
    ...(assignDeterministicId ? { id: deterministicId } : {}),
    extendedProperties: {
      ...event.extendedProperties,
      private: {
        ...event.extendedProperties?.private,
        obsidianTaskManagerKey: digest,
      },
    },
  };
}

export function markdownTaskToGoogleCalendarEvent(task: MarkdownTask, options: { reminderMinutes?: number; useDefaultReminders?: boolean } = {}): GoogleCalendarEvent | null {
  if (task.metadata.excludeFromSync) return null;
  const date = task.metadata.dates.scheduled ?? task.metadata.dates.due ?? task.metadata.dates.start;
  if (!date) return null;
  const id = googleCalendarEventIdFromTaskId(task.metadata.id);
  const timed = taskEventDateTime(task);
  if (timed) {
    const timeZone = googleCalendarTimeZone();
    const endHint = googleCalendarTimedEnd(timed.date, timed.time, task.metadata.timeEnd, timeZone);
    const endTime = endHint ?? addMinutesToDateTime(timed.date, timed.time, 60);
    return {
      ...(id ? { id } : {}),
      summary: cleanSummary(task),
      start: { dateTime: `${timed.date}T${timed.time}:00`, ...(timeZone ? { timeZone } : {}) },
      end: typeof endTime === 'object' && 'dateTime' in endTime
        ? endTime
        : { dateTime: `${endTime.date}T${endTime.time}:00`, ...(timeZone ? { timeZone } : {}) },
      status: task.status === 'cancelled' ? 'cancelled' : 'confirmed',
      reminders: {
        useDefault: options.useDefaultReminders ?? false,
        ...(options.useDefaultReminders ? {} : { overrides: [{ method: 'popup', minutes: Math.max(0, Math.floor(options.reminderMinutes ?? 10)) }] }),
      },
    };
  }
  return {
    ...(id ? { id } : {}),
    summary: cleanSummary(task),
    start: { date },
    end: { date: addDays(date, 1) },
    status: task.status === 'cancelled' ? 'cancelled' : 'confirmed',
    reminders: {
      useDefault: options.useDefaultReminders ?? false,
      ...(options.useDefaultReminders ? {} : { overrides: [{ method: 'popup', minutes: Math.max(0, Math.floor(options.reminderMinutes ?? 10)) }] }),
    },
  };
}

async function throwGoogleCalendarApiError(response: Response, prefix: string): Promise<never> {
  let detail = '';
  try {
    const payload = await response.json() as { error?: { message?: string } };
    detail = payload.error?.message ?? '';
  } catch {
    detail = response.statusText ?? '';
  }
  detail = detail.slice(0, 512);
  throw new ProviderHttpError(`${prefix}: ${response.status}${detail ? ` - ${detail}` : ''}`, response.status, retryAfterMilliseconds(response));
}

export async function testGoogleCalendarConnection(config: GoogleCalendarConfig): Promise<void> {
  config.assertCurrent?.();
  assertGoogleCalendarMutationCredentials(config);
  const calendarId = googleCalendarId(config);
  const params = new URLSearchParams({ maxResults: '1', singleEvents: 'true' });
  const response = await requestResponse(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { headers: googleCalendarAuthHeader(config), signal: config.signal },
    { signal: config.signal, redirect: 'error' },
  );
  config.assertCurrent?.();
  if (!response.ok) await throwGoogleCalendarApiError(response, 'Google Calendar connection check failed');
}

function comparableGoogleCalendarEvent(event: GoogleCalendarEvent): string {
  return JSON.stringify({
    summary: event.summary,
    description: event.description ?? '',
    start: event.start,
    end: event.end,
    status: event.status ?? 'confirmed',
    reminders: event.reminders ?? null,
    extendedProperties: event.extendedProperties ?? null,
  });
}

export async function upsertGoogleCalendarEvent(
  config: GoogleCalendarConfig,
  event: GoogleCalendarEvent,
  options: { preflightCreate?: boolean; verifyExisting?: boolean } = {},
): Promise<GoogleCalendarEvent> {
  config.assertCurrent?.();
  assertGoogleCalendarMutationCredentials(config);
  if (config.dryRun) return event;
  const calendarId = googleCalendarId(config);
  const collectionUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const eventUrl = event.id ? `${collectionUrl}/${encodeURIComponent(event.id)}` : undefined;
  const headers = { ...googleCalendarAuthHeader(config), 'Content-Type': 'application/json' };
  const request = async (url: string, method: string, body?: GoogleCalendarEvent): Promise<Response> => {
    config.assertCurrent?.();
    const response = await requestResponse(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: config.signal,
    }, { signal: config.signal, redirect: 'error' });
    config.assertCurrent?.();
    return response;
  };
  const body = async (response: Response): Promise<GoogleCalendarEvent> => {
    const result = await response.json() as GoogleCalendarEvent;
    config.assertCurrent?.();
    return result;
  };

  if (!options.preflightCreate) {
    const response = await request(eventUrl ?? collectionUrl, eventUrl ? 'PATCH' : 'POST', event);
    if (!response.ok) await throwGoogleCalendarApiError(response, 'Google Calendar API error');
    return body(response);
  }
  if (!eventUrl || !event.id) throw new Error('Deterministic Google Calendar create requires an event ID');

  const existing = await request(eventUrl, 'GET');
  if (existing.ok) {
    if (options.verifyExisting) {
      const current = await body(existing);
      if (comparableGoogleCalendarEvent(current) === comparableGoogleCalendarEvent(event)) return current;
    }
    const patched = await request(eventUrl, 'PATCH', event);
    if (!patched.ok) await throwGoogleCalendarApiError(patched, 'Google Calendar API error');
    return body(patched);
  }
  if (existing.status !== 404) await throwGoogleCalendarApiError(existing, 'Google Calendar preflight failed');

  const created = await request(collectionUrl, 'POST', event);
  if (created.ok) return body(created);
  if (created.status !== 409) await throwGoogleCalendarApiError(created, 'Google Calendar API error');

  const recovered = await request(eventUrl, 'GET');
  if (!recovered.ok) await throwGoogleCalendarApiError(recovered, 'Google Calendar create recovery failed');
  const patched = await request(eventUrl, 'PATCH', event);
  if (!patched.ok) await throwGoogleCalendarApiError(patched, 'Google Calendar API error');
  return body(patched);
}
