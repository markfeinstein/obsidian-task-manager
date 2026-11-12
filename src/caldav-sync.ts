/**
 * CalDAV / ICS Import & Sync
 *
 * Import calendar events from ICS files or CalDAV feeds as tasks.
 * Supports bidirectional sync with conflict resolution.
 */

import { type App, TFile } from 'obsidian';
import { stripInlineTags } from './task-model';
import type { ParsedTask } from './task-scanner';
import { sanitizeUntrustedInlineFieldValue, sanitizeUntrustedTag, sanitizeUntrustedTaskText } from './untrusted-task-text';
import { isLocalOrPrivateHost } from './url-safety';
import { parseDAVCalendarListing } from './dav-calendar-listing';
import { fromICSRecurrenceRule, toICSRecurrenceRule } from './ics-recurrence';
import { reconcileVTODO, VTODOConflictError, withVTODOBaseline } from './ics-vtodo-reconciliation';

type CalDavHttpResponse = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
};

export type CalDAVFailureKind =
  | 'authentication'
  | 'conflict'
  | 'not-found'
  | 'server'
  | 'http'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'response-too-large'
  | 'busy'
  | 'circuit-open'
  | 'missing-precondition'
  | 'invalid-calendar'
  | 'invalid-data';

/** A transport/reconciliation failure that callers can safely classify and report. */
export class CalDAVError extends Error {
  constructor(
    message: string,
    public readonly kind: CalDAVFailureKind,
    public readonly operation: 'PROPFIND' | 'GET' | 'PUT' | 'DELETE' | 'reconcile',
    public readonly statusCode?: number,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'CalDAVError';
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export type CalDAVPrecondition =
  | { kind: 'match'; etag: string }
  | { kind: 'unmodified-since'; lastModified: string }
  | { kind: 'none-match' };

export interface CalDAVResource {
  content: string;
  etag?: string;
  lastModified?: string;
}

export type CalDAVReadResult =
  | { status: 'success'; resource: CalDAVResource }
  | { status: 'not-found' };

export type CalDAVWriteResult =
  | { status: 'success'; statusCode: number; etag?: string }
  | { status: 'conflict'; statusCode: 409 | 412 };

const SYNTHETIC_EMPTY_SUMMARY = 'Untitled task';
const EMPTY_SUMMARY_PROPERTY = 'X-OBSIDIAN-TASK-MANAGER-EMPTY-SUMMARY';
const MANAGED_VTODO_PROPERTY = 'X-OBSIDIAN-TASK-MANAGER-MANAGED';
const CALDAV_SYNC_HEADING = 'Synced from CalDAV';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CALDAV_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_CALDAV_ORIGIN_PENDING = 8;
const CALDAV_CIRCUIT_COOLDOWN_MS = 30_000;

interface CalDavOriginGate {
  tail: Promise<void>;
  pending: number;
  circuitUntil: number;
}

const calDavOriginGates = new Map<string, CalDavOriginGate>();

function responseHeaders(headers: Headers | Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;
  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => { normalized[key.toLowerCase()] = value; });
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, string>)) normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function enforceDeclaredResponseLimit(headers: Record<string, string>, operation: CalDAVError['operation']): void {
  const declaredLength = Number(headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CALDAV_RESPONSE_BYTES) {
    throw new CalDAVError(`CalDAV response exceeded the ${MAX_CALDAV_RESPONSE_BYTES}-byte limit`, 'response-too-large', operation);
  }
}

/** Fallback bound for response mocks/environments without a readable response stream. */
function enforceResponseLimit(text: string, headers: Record<string, string>, operation: CalDAVError['operation']): void {
  enforceDeclaredResponseLimit(headers, operation);
  if (new TextEncoder().encode(text).length > MAX_CALDAV_RESPONSE_BYTES) {
    throw new CalDAVError(`CalDAV response exceeded the ${MAX_CALDAV_RESPONSE_BYTES}-byte limit`, 'response-too-large', operation);
  }
}

function originGate(url: string): CalDavOriginGate {
  const origin = new URL(url).origin;
  let gate = calDavOriginGates.get(origin);
  if (!gate) {
    gate = { tail: Promise.resolve(), pending: 0, circuitUntil: 0 };
    calDavOriginGates.set(origin, gate);
  }
  return gate;
}

function enqueueOriginRequest<T>(
  url: string,
  operation: CalDAVError['operation'],
  start: () => Promise<T>,
): { promise: Promise<T>; cancel: (kind?: 'cancelled' | 'timeout') => void; tripCircuit: () => void } {
  const gate = originGate(url);
  if (Date.now() < gate.circuitUntil) {
    throw new CalDAVError('CalDAV origin circuit is cooling down after an unsafe request failure', 'circuit-open', operation);
  }
  if (gate.pending >= MAX_CALDAV_ORIGIN_PENDING) {
    throw new CalDAVError('CalDAV origin already has too many pending requests', 'busy', operation);
  }
  gate.pending += 1;
  let cancelled: 'cancelled' | 'timeout' | null = null;
  const promise = gate.tail.catch(() => undefined).then(async () => {
    if (cancelled) throw new CalDAVError(`CalDAV ${operation} was cancelled before it could start`, cancelled, operation);
    if (Date.now() < gate.circuitUntil) throw new CalDAVError('CalDAV origin circuit is cooling down after an unsafe request failure', 'circuit-open', operation);
    return start();
  });
  // Follow the underlying transport even when its caller observes cancellation,
  // so another same-origin request cannot overtake an abort-ignoring fetch.
  gate.tail = promise.then(() => undefined, () => undefined);
  void promise.then(
    () => { gate.pending = Math.max(0, gate.pending - 1); },
    () => { gate.pending = Math.max(0, gate.pending - 1); },
  );
  return {
    promise,
    cancel: (kind = 'cancelled') => { cancelled ??= kind; },
    tripCircuit: () => { gate.circuitUntil = Date.now() + CALDAV_CIRCUIT_COOLDOWN_MS; },
  };
}

/** Caller deadline; the per-origin gate remains occupied until the transport itself settles. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: CalDAVError['operation']): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CalDAVError(`CalDAV ${operation} timed out after ${timeoutMs} ms`, 'timeout', operation)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readFetchResponseText(
  response: Response,
  headers: Record<string, string>,
  operation: CalDAVError['operation'],
  controller: AbortController,
): Promise<string> {
  enforceDeclaredResponseLimit(headers, operation);
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    enforceResponseLimit(text, headers, operation);
    return text;
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_CALDAV_RESPONSE_BYTES) {
        controller.abort();
        throw new CalDAVError(`CalDAV response exceeded the ${MAX_CALDAV_RESPONSE_BYTES}-byte limit`, 'response-too-large', operation);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function calDavRequest(
  url: string,
  options: { method: CalDAVError['operation']; headers?: Record<string, string>; body?: string },
  parentSignal?: AbortSignal,
): Promise<CalDavHttpResponse> {
  if (parentSignal?.aborted) throw new CalDAVError(`CalDAV ${options.method} was cancelled`, 'cancelled', options.method);
  // Fetch is intentionally used instead of Obsidian requestUrl: redirect:error,
  // AbortSignal, and streaming reads are required before forwarding credentials.
  // Servers must therefore permit the Obsidian app origin through CORS.
  const controller = new AbortController();
  const scheduled = enqueueOriginRequest(url, options.method, async () => {
    const response = await globalThis.fetch(url, { ...options, redirect: 'error', signal: controller.signal });
    const headers = responseHeaders(response.headers);
    const text = await readFetchResponseText(response, headers, options.method, controller);
    return { ok: response.ok, status: response.status, headers, text };
  });
  let rejectCancellation: ((error: CalDAVError) => void) | undefined;
  const cancellation = parentSignal ? new Promise<never>((_resolve, reject) => { rejectCancellation = reject; }) : undefined;
  const abortFromParent = (): void => {
    scheduled.cancel('cancelled');
    controller.abort();
    rejectCancellation?.(new CalDAVError(`CalDAV ${options.method} was cancelled`, 'cancelled', options.method));
  };
  if (parentSignal) {
    parentSignal.addEventListener('abort', abortFromParent, { once: true });
    if (parentSignal.aborted) abortFromParent();
  }
  try {
    return await withTimeout(cancellation ? Promise.race([scheduled.promise, cancellation]) : scheduled.promise, DEFAULT_REQUEST_TIMEOUT_MS, options.method);
  } catch (error) {
    if (parentSignal?.aborted || error instanceof CalDAVError && error.kind === 'cancelled') {
      scheduled.cancel('cancelled');
      controller.abort();
      throw error instanceof CalDAVError && error.kind === 'cancelled'
        ? error
        : new CalDAVError(`CalDAV ${options.method} was cancelled`, 'cancelled', options.method, undefined, { cause: error });
    }
    if (error instanceof CalDAVError) {
      if (error.kind === 'timeout' || error.kind === 'response-too-large') {
        scheduled.cancel('timeout');
        scheduled.tripCircuit();
        controller.abort();
      }
      throw error;
    }
    if (controller.signal.aborted) {
      scheduled.tripCircuit();
      throw new CalDAVError(`CalDAV ${options.method} timed out after ${DEFAULT_REQUEST_TIMEOUT_MS} ms`, 'timeout', options.method, undefined, { cause: error });
    }
    throw new CalDAVError(`CalDAV ${options.method} network failure`, 'network', options.method, undefined, { cause: error });
  } finally {
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

/** Reset process-local origin guards for isolated transport tests. */
export function resetCalDavTransportGuardsForTests(): void {
  calDavOriginGates.clear();
}

function transportError(operation: CalDAVError['operation'], statusCode: number): CalDAVError {
  const kind: CalDAVFailureKind = statusCode === 401 || statusCode === 403
    ? 'authentication'
    : statusCode >= 500 ? 'server' : 'http';
  return new CalDAVError(`CalDAV ${operation} failed with HTTP ${statusCode}`, kind, operation, statusCode);
}

function extractCalDAVHrefs(xml: string): string[] {
  const hrefs: string[] = [];
  const regex = /<(?:[A-Za-z_][\w.-]*:)?href\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?href>/giu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    hrefs.push(decodeXmlText(match[1].trim()));
  }
  return hrefs;
}

function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_match, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = entity.toLowerCase().startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _match;
    }

    const entities: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
    };
    return entities[entity] ?? _match;
  });
}

export interface CalendarEvent {
  /** Event UID (unique identifier) */
  uid: string;
  /** Event summary/title */
  summary: string;
  /** True when a Task Manager export had intentionally blank task text. */
  emptySummary?: boolean;
  /** Event description */
  description?: string;
  /** Start time (ISO 8601) */
  dtstart?: string;
  /** End time (ISO 8601) */
  dtend?: string;
  /** Due date (for tasks, uses DUE property) */
  due?: string;
  /** Priority (0-9, maps to highest/high/medium/low/lowest) */
  priority?: number;
  /** Categories/tags */
  categories?: string[];
  /** Alarm/reminder in minutes before due */
  alarm?: number;
  /** Recurrence rule (RRule format) */
  rrule?: string;
  /**
   * iCalendar STATUS property — present on VTODO components.
   * Used to round-trip task completion/cancellation from CalDAV.
   */
  status?: 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED';
  /** Completion date (YYYY-MM-DD), from the COMPLETED property. Only meaningful when status is COMPLETED. */
  completed?: string;
}

/**
 * CalDAV client for syncing tasks with CalDAV servers
 */
export class CalDAVClient {
  private serverUrl: string;
  private username: string;
  private password: string;
  private bearerToken?: string;
  private signal?: AbortSignal;

  constructor(serverUrl: string, username: string, password: string, bearerToken?: string, allowPrivateNetwork = false, signal?: AbortSignal) {
    const parsedServerUrl = parseCalDavServerUrl(serverUrl, allowPrivateNetwork);
    this.serverUrl = parsedServerUrl.toString().replace(/\/$/u, '');
    this.username = username;
    this.password = password;
    this.bearerToken = bearerToken;
    this.signal = signal;
  }

  /**
   * Get authorization header (Basic auth or Bearer token)
   *
   * Uses UTF-8 encoding before base64 so that usernames/passwords containing
   * non-Latin-1 characters (CJK, emoji, accented letters above U+00FF, …)
   * do not cause `btoa` to throw `Invalid character`.  RFC 7617 §2 requires
   * the user-id:password pair to be UTF-8 encoded before base64 encoding.
   */
  private getAuthHeader(): Record<string, string> {
    if (this.bearerToken) {
      return { Authorization: `Bearer ${this.bearerToken}` };
    }
    const raw = `${this.username}:${this.password}`;
    const bytes = new TextEncoder().encode(raw);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const credentials = btoa(binary);
    return { Authorization: `Basic ${credentials}` };
  }

  /** PROPFIND: list calendar entries. Failures are typed and never become an empty success. */
  async propfind(path: string): Promise<string[]> {
    const response = await calDavRequest(buildCalDavUrl(this.serverUrl, path), {
      method: 'PROPFIND',
      headers: {
        ...this.getAuthHeader(),
        'Content-Type': 'application/xml',
        Depth: '1',
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <D:getcontenttype/>
  </D:prop>
</D:propfind>`,
    }, this.signal);
    if (!response.ok) throw transportError('PROPFIND', response.status);
    return extractCalDAVHrefs(response.text);
  }

  /** Discover one explicit collection, not a shared downloadable ICS snapshot. */
  async calendarObjects(path: string): Promise<string[]> {
    const collection = new URL(buildCalDavUrl(this.serverUrl, path));
    if (!collection.pathname.endsWith('/')) throw new CalDAVError('CalDAV collection paths must end in /', 'invalid-data', 'PROPFIND');
    const response = await calDavRequest(collection.toString(), {
      method: 'PROPFIND',
      headers: { ...this.getAuthHeader(), 'Content-Type': 'application/xml', Depth: '1' },
      body: '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:resourcetype/><D:getcontenttype/><D:getetag/><C:supported-calendar-component-set/></D:prop></D:propfind>',
    }, this.signal);
    if (response.status !== 207) throw new CalDAVError('CalDAV collection did not return HTTP 207 multistatus', 'invalid-calendar', 'PROPFIND', response.status);
    let entries;
    try { entries = parseDAVCalendarListing(response.text); }
    catch (error) { throw new CalDAVError(error instanceof Error ? error.message : String(error), 'invalid-calendar', 'PROPFIND'); }
    const objects = new Set<string>();
    let foundCollection = false;
    for (const entry of entries) {
      const href = this.collectionHref(path, entry.href);
      const url = new URL(href);
      if (url.pathname === collection.pathname) {
        if (foundCollection || !entry.collection || !entry.calendar || entry.supportsVTODO === false) throw new CalDAVError('Configured DAV collection is not a unique VTODO-capable calendar', 'invalid-calendar', 'PROPFIND');
        foundCollection = true;
      } else if (!entry.collection && entry.calendarObject) {
        if (objects.has(href)) throw new CalDAVError('Duplicate calendar-object href', 'invalid-data', 'PROPFIND');
        objects.add(href);
      }
    }
    if (!foundCollection) throw new CalDAVError('DAV response did not identify the configured calendar collection', 'invalid-calendar', 'PROPFIND');
    return [...objects];
  }

  collectionHref(path: string, href: string): string {
    const collection = new URL(buildCalDavUrl(this.serverUrl, path));
    const target = new URL(buildCalDavUrl(this.serverUrl, new URL(href, collection).toString()));
    if (/%(?:2f|5c|25|00)/iu.test(target.pathname)) throw new CalDAVError('CalDAV object path has ambiguous separator or escape encoding', 'invalid-data', 'PROPFIND');
    if (!target.pathname.startsWith(collection.pathname)) throw new CalDAVError('CalDAV object is outside the configured collection', 'invalid-data', 'PROPFIND');
    return target.toString();
  }

  /** GET a calendar resource together with the precondition metadata needed for a safe update. */
  async get(path: string): Promise<CalDAVReadResult> {
    const response = await calDavRequest(buildCalDavUrl(this.serverUrl, path), {
      method: 'GET',
      headers: this.getAuthHeader(),
    }, this.signal);
    if (response.status === 404) return { status: 'not-found' };
    if (!response.ok) throw transportError('GET', response.status);
    return {
      status: 'success',
      resource: {
        content: response.text,
        etag: response.headers.etag?.trim() || undefined,
        lastModified: response.headers['last-modified']?.trim() || undefined,
      },
    };
  }

  /**
   * Conditionally replace/create a calendar resource. A precondition is mandatory,
   * so this API cannot accidentally perform an unconditional destructive PUT.
   */
  async put(path: string, content: string, precondition: CalDAVPrecondition): Promise<CalDAVWriteResult> {
    const conditionalHeaders: Record<string, string> = precondition.kind === 'match'
      ? { 'If-Match': precondition.etag }
      : precondition.kind === 'unmodified-since'
        ? { 'If-Unmodified-Since': precondition.lastModified }
        : { 'If-None-Match': '*' };
    const response = await calDavRequest(buildCalDavUrl(this.serverUrl, path), {
      method: 'PUT',
      headers: {
        ...this.getAuthHeader(),
        ...conditionalHeaders,
        'Content-Type': 'text/calendar; charset=utf-8',
      },
      body: content,
    }, this.signal);
    if (response.status === 409 || response.status === 412) {
      return { status: 'conflict', statusCode: response.status };
    }
    if (!response.ok) throw transportError('PUT', response.status);
    return { status: 'success', statusCode: response.status, etag: response.headers.etag?.trim() || undefined };
  }

  /** DELETE is retained for callers outside sync, but never hides failures. */
  async delete(path: string): Promise<void> {
    const response = await calDavRequest(buildCalDavUrl(this.serverUrl, path), {
      method: 'DELETE',
      headers: this.getAuthHeader(),
    }, this.signal);
    if (!response.ok) throw transportError('DELETE', response.status);
  }
}

function normalizedCalDavHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
}

export function isPrivateCalDavServerUrl(serverUrl: string): boolean {
  try {
    const hostname = normalizedCalDavHostname(new URL(serverUrl));
    return hostname.endsWith('.local') || isLocalOrPrivateHost(hostname);
  } catch {
    return false;
  }
}

function parseCalDavServerUrl(serverUrl: string, allowPrivateNetwork: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl.trim());
  } catch {
    throw new Error('CalDAV server URL is invalid');
  }
  if (parsed.protocol !== 'https:') throw new Error('CalDAV server URL must use HTTPS');
  if (parsed.username || parsed.password) throw new Error('CalDAV server URL must not contain embedded credentials');
  if (parsed.hash) throw new Error('CalDAV server URL must not contain a fragment');
  if (!allowPrivateNetwork) throw new Error('CalDAV endpoint access requires explicit trust');
  return parsed;
}

export function isAllowedCalDavServerUrl(serverUrl: string, allowPrivateNetwork = false): boolean {
  try {
    parseCalDavServerUrl(serverUrl, allowPrivateNetwork);
    return true;
  } catch {
    return false;
  }
}

export async function testCalDAVConnection(config: {
  serverUrl: string; username: string; password: string; calendarPath: string; allowPrivateNetwork: boolean; signal?: AbortSignal;
}): Promise<{ success: boolean; message: string }> {
  const serverUrl = config.serverUrl.trim();
  if (!serverUrl) return { success: false, message: 'CalDAV server URL not configured' };
  if (!isAllowedCalDavServerUrl(serverUrl, config.allowPrivateNetwork)) return { success: false, message: 'CalDAV server URL must be explicitly trusted, use HTTPS, and contain no embedded credentials or fragments' };
  if (!config.username.trim()) return { success: false, message: 'CalDAV username not configured' };
  if (!config.password.trim()) return { success: false, message: 'CalDAV password not configured' };
  try {
    const client = new CalDAVClient(serverUrl, config.username.trim(), config.password.trim(), undefined, config.allowPrivateNetwork, config.signal);
    const path = config.calendarPath.trim() || '/calendar.ics/';
    if (path.endsWith('/')) {
      await client.calendarObjects(path);
      return { success: true, message: 'CalDAV VTODO collection validated (read-only discovery). This trusts the configured hostname and its DNS resolution; Obsidian cannot pin the resolved address.' };
    }
    const result = await client.get(path);
    if (result.status === 'success' && (!/^BEGIN:VCALENDAR\s*$/imu.test(result.resource.content) || !/^END:VCALENDAR\s*$/imu.test(result.resource.content))) throw new CalDAVError('Response is not a valid VCALENDAR resource', 'invalid-calendar', 'GET');
    return result.status === 'success'
      ? { success: true, message: 'CalDAV connection succeeded. This trusts the configured hostname and its DNS resolution; Obsidian cannot pin the resolved address.' }
      : { success: false, message: 'The configured CalDAV calendar path was not found.' };
  } catch (error) {
    return { success: false, message: isCalDavCancellation(error) ? 'CalDAV connection cancelled' : `CalDAV connection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function buildCalDavUrl(serverUrl: string, href: string): string {
  const base = new URL(serverUrl);
  const trimmedHref = href.trim();
  if (trimmedHref && !trimmedHref.startsWith('/') && !base.pathname.endsWith('/')) base.pathname += '/';
  const resource = new URL(trimmedHref || '/', trimmedHref.startsWith('/') ? base.origin : base);
  if (resource.username || resource.password) throw new Error('CalDAV href must not contain embedded credentials');
  if (resource.hash) throw new Error('CalDAV href must not contain a fragment');
  if (resource.origin !== base.origin) throw new Error(`CalDAV href points to a different origin: ${resource.origin}`);
  return resource.toString();
}

/**
 * Parse ICS file content and extract events
 */
export function parseICSFile(content: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  const eventBlocks = rawCalendarComponents(content, false).map((component) => component.content);

  for (const block of eventBlocks) {
    const event: CalendarEvent = { uid: '', summary: '' };

    // RFC 5545 §3.1: unfold continuation lines (CRLF or LF followed by a single
    // space or tab) before splitting, so long SUMMARY/DESCRIPTION values are not
    // silently truncated at the fold point.
    const lines = unfoldICSLines(block).split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const uid = getICSPropertyValue(line, 'UID');
      const summary = getICSPropertyValue(line, 'SUMMARY');
      const description = getICSPropertyValue(line, 'DESCRIPTION');
      const priority = getICSPropertyValue(line, 'PRIORITY');
      const categories = getICSPropertyValue(line, 'CATEGORIES');
      const status = getICSPropertyValue(line, 'STATUS');
      const rrule = getICSPropertyValue(line, 'RRULE');
      const trigger = getICSPropertyValue(line, 'TRIGGER');
      const emptySummary = getICSPropertyValue(line, EMPTY_SUMMARY_PROPERTY);

      if (uid !== undefined) {
        event.uid = unescapeICSField(uid);
      } else if (summary !== undefined) {
        event.summary = unescapeICSField(summary);
      } else if (description !== undefined) {
        event.description = unescapeICSField(description);
      } else if (getICSPropertyValue(line, 'DTSTART') !== undefined) {
        event.dtstart = extractISODate(line);
      } else if (getICSPropertyValue(line, 'DTEND') !== undefined) {
        event.dtend = extractISODate(line);
      } else if (getICSPropertyValue(line, 'DUE') !== undefined) {
        event.due = extractISODate(line);
      } else if (getICSPropertyValue(line, 'COMPLETED') !== undefined) {
        event.completed = extractISODate(line)?.slice(0, 10);
      } else if (priority !== undefined) {
        const parsedPriority = parseICSPriorityNumber(priority);
        if (parsedPriority !== undefined) event.priority = parsedPriority;
      } else if (categories !== undefined) {
        event.categories = splitICSList(categories);
      } else if (status !== undefined) {
        const normalizedStatus = normalizeICSStatus(status);
        if (normalizedStatus) event.status = normalizedStatus;
      } else if (rrule !== undefined) {
        event.rrule = unescapeICSField(rrule);
      } else if (trigger !== undefined) {
        const alarmMatch = trigger.match(/^-PT(\d+)M/u);
        if (alarmMatch) {
          event.alarm = parseInt(alarmMatch[1], 10);
        }
      } else if (emptySummary !== undefined) {
        event.emptySummary = emptySummary.trim().toUpperCase() === 'TRUE';
      }
    }

    if (event.summary || event.emptySummary) {
      events.push(event);
    }
  }

  return events;
}

function unfoldICSLines(content: string): string {
  return content.replace(/\r?\n[ \t]/gu, '');
}

function getICSPropertyValue(line: string, name: string): string | undefined {
  const separatorIndex = findICSPropertySeparator(line);
  if (separatorIndex < 0) return undefined;

  const propertyName = line.slice(0, separatorIndex).split(';', 1)[0];
  if (propertyName.toUpperCase() !== name.toUpperCase()) return undefined;

  return line.slice(separatorIndex + 1);
}

function findICSPropertySeparator(line: string): number {
  let inQuotedParameter = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      inQuotedParameter = !inQuotedParameter;
    } else if (char === ':' && !inQuotedParameter) {
      return i;
    }
  }

  return -1;
}

/**
 * Extract a task-compatible date from an ICS property line.
 * Supports: DTSTART:20260527, DTSTART;VALUE=DATE:20260527, DTSTART:20260527T140000Z.
 * Date-times are returned at minute precision because task metadata only supports HH:MM times.
 */
function extractISODate(line: string): string | undefined {
  const separatorIndex = findICSPropertySeparator(line);
  if (separatorIndex < 0) return undefined;

  const dateValue = line.slice(separatorIndex + 1);

  const dateOnlyMatch = dateValue.match(/^(\d{4})(\d{2})(\d{2})$/u);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return isValidICSDateParts(year, month, day) ? `${year}-${month}-${day}` : undefined;
  }

  const dateTimeMatch = dateValue.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:Z|[+-]\d{4})?$/u);
  if (dateTimeMatch) {
    const [, year, month, day, hour, minute, second] = dateTimeMatch;
    if (!isValidICSDateParts(year, month, day) || !isValidICSTimeParts(hour, minute, second)) return undefined;
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }

  return undefined;
}

function isValidICSDateParts(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y
    && parsed.getUTCMonth() === m - 1
    && parsed.getUTCDate() === d;
}

function isValidICSTimeParts(hour: string, minute: string, second: string): boolean {
  const h = Number(hour);
  const m = Number(minute);
  const s = Number(second);
  return Number.isInteger(h) && h >= 0 && h <= 23
    && Number.isInteger(m) && m >= 0 && m <= 59
    && Number.isInteger(s) && s >= 0 && s <= 59;
}

/**
 * Priority number (0-9) to priority label
 */
function priorityFromICS(priority?: number): string | undefined {
  if (priority === undefined || !Number.isInteger(priority) || priority < 0 || priority > 9) return undefined;
  if (priority === 0) return undefined;
  if (priority <= 3) return 'highest';
  if (priority <= 4) return 'high';
  if (priority <= 6) return 'medium';
  if (priority <= 8) return 'low';
  return 'lowest';
}

function parseICSPriorityNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[0-9]$/u.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
}

function normalizeICSStatus(value: string): CalendarEvent['status'] | undefined {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'NEEDS-ACTION' || normalized === 'IN-PROCESS' || normalized === 'COMPLETED' || normalized === 'CANCELLED') {
    return normalized;
  }
  return undefined;
}

/**
 * Priority label to ICS number
 */
function priorityToICSNumber(priority: string): number {
  const map: Record<string, number> = {
    'highest': 1,
    'high': 4,
    'medium': 6,
    'low': 8,
    'lowest': 9,
  };
  return map[priority.toLowerCase()] ?? 5;
}

/**
 * Generate a VTODO component for a task
 */
export function generateVTODO(task: ParsedTask): string {
  if (task.metadata.excludeFromSync) return '';
  const lines: string[] = [];

  lines.push('BEGIN:VTODO');

  // The positional fallback is retained only for standalone ICS export callers.
  // Managed CalDAV sync filters through prepareManagedVTODOs() and never uses it.
  const uid = task.metadata.id || `task-${task.filePath.replace(/[^A-Za-z0-9@._-]/g, '-')}-L${task.lineNumber}`;
  lines.push(`UID:${uid}`);
  lines.push(`${MANAGED_VTODO_PROPERTY}:TRUE`);

  const normalizedSummary = markdownInline(task.normalizedText ?? '');
  const summary = normalizedSummary || SYNTHETIC_EMPTY_SUMMARY;
  lines.push(`SUMMARY:${escapeICSField(summary)}`);
  if (!normalizedSummary) {
    lines.push(`${EMPTY_SUMMARY_PROPERTY}:TRUE`);
  }

  if (task.metadata.dates.due) {
    lines.push(icsDateProperty('DUE', formatDateForICS(task.metadata.dates.due, task.metadata.dates.dueTime)));
  }
  if (task.metadata.dates.scheduled) {
    lines.push(icsDateProperty('DTSTART', formatDateForICS(task.metadata.dates.scheduled, task.metadata.dates.scheduledTime)));
  }

  if (task.metadata.priority) {
    lines.push(`PRIORITY:${priorityToICSNumber(task.metadata.priority)}`);
  }

  const statusMap: Record<string, string> = {
    'todo': 'NEEDS-ACTION',
    'in_progress': 'IN-PROCESS',
    'done': 'COMPLETED',
    'cancelled': 'CANCELLED',
  };
  lines.push(`STATUS:${statusMap[task.status] || 'NEEDS-ACTION'}`);

  if (task.status === 'in_progress') {
    lines.push('PERCENT-COMPLETE:50');
  } else if (task.status === 'done') {
    lines.push('PERCENT-COMPLETE:100');
    if (task.metadata.dates.done) {
      // RFC 5545 §3.8.2.1: COMPLETED MUST be a DATE-TIME in UTC format, not a bare date.
      // If the done date is date-only (YYYY-MM-DD), append end-of-day time (23:59:59Z)
      // so strict CalDAV servers don't reject the invalid bare-date COMPLETED value.
      const formatted = formatDateForICS(task.metadata.dates.done);
      const completedValue = /^\d{8}$/u.test(formatted) ? `${formatted}T235959Z` : formatted;
      lines.push(`COMPLETED:${completedValue}`);
    }
    // An unknown completion date stays unknown; generating 'now' causes false changes on every sync.
  }

  if (task.tags && task.tags.length > 0) {
    lines.push(`CATEGORIES:${task.tags.map((tag) => escapeICSField(tag)).join(',')}`);
  }

  if (task.metadata.recurrence) {
    lines.push(`RRULE:${toICSRecurrenceRule(task.metadata.recurrence, {
      count: task.metadata.recurrenceLimit === undefined ? undefined : task.metadata.recurrenceLimit - (task.metadata.recurrenceCount ?? 0),
      until: task.metadata.recurrenceUntil,
      timed: Boolean(task.metadata.dates.scheduledTime),
      anchor: task.metadata.dates.due ?? task.metadata.dates.scheduled ?? task.metadata.dates.start,
    })}`);
  }

  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  lines.push(`DTSTAMP:${now}`);

  lines.push('END:VTODO');
  return foldICSLines(withVTODOBaseline(lines.join('\r\n')).split('\r\n'));
}

/**
 * Build an ICS date/date-time property line, adding the `VALUE=DATE` parameter
 * for date-only values. The default value type for DUE/DTSTART is DATE-TIME, so a
 * bare 8-digit date (e.g. `DUE:20260615`) is an invalid DATE-TIME that strict
 * CalDAV servers reject; `DUE;VALUE=DATE:20260615` is the RFC 5545-compliant form.
 */
function icsDateProperty(name: string, formatted: string): string {
  const isDateOnly = /^\d{8}$/u.test(formatted);
  return isDateOnly ? `${name};VALUE=DATE:${formatted}` : `${name}:${formatted}`;
}

function foldICSLines(lines: string[]): string {
  return lines.flatMap((line) => line.split(/\r?\n/u)).map((line) => foldICSLine(line)).join('\r\n');
}

function foldICSLine(line: string): string {
  const maxLineOctets = 75;
  const continuationPrefix = ' ';
  let current = '';
  let currentOctets = 0;
  const folded: string[] = [];

  for (const char of Array.from(line)) {
    const charOctets = utf8ByteLength(char);

    if (current && currentOctets + charOctets > maxLineOctets) {
      folded.push(current);
      current = continuationPrefix;
      currentOctets = utf8ByteLength(continuationPrefix);
    }

    current += char;
    currentOctets += charOctets;
  }

  folded.push(current);
  return folded.join('\r\n');
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function generateICSUid(summary: string): string {
  return `task-${summary.replace(/[^A-Za-z0-9@._-]/g, '-')}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Escape special characters in ICS fields
 */
function escapeICSField(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\n/g, '\\n');
}

/**
 * Unescape special characters in ICS fields
 */
function unescapeICSField(text: string): string {
  return text.replace(/\\([nN,;\\])/g, (_match, escaped: string) => {
    if (escaped === 'n' || escaped === 'N') return '\n';
    return escaped;
  });
}

function markdownInline(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function sanitizeCalendarText(value: string | undefined): string {
  return sanitizeUntrustedTaskText(stripInlineTags(markdownInline(value ?? '')));
}

function safeCalendarTaskId(value: string | undefined): string | undefined {
  const safe = sanitizeUntrustedInlineFieldValue(markdownInline(value ?? ''))
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120);
  return safe || undefined;
}

function appendTaskLinesUnderHeading(content: string, taskLines: string[], heading: string): string {
  let targetContent = content;
  if (!targetContent.includes(`## ${heading}`)) {
    if (targetContent) targetContent += '\n\n';
    targetContent += `## ${heading}\n`;
  }
  return `${targetContent}\n${taskLines.join('\n')}\n`;
}

function removeCalDavManagedSections(content: string): string {
  const lines = content.split(/\r?\n/u);
  const kept: string[] = [];
  let skippingManagedSection = false;

  for (const line of lines) {
    if (/^#\s+Synced from CalDAV\s*$/u.test(line)) {
      skippingManagedSection = true;
      continue;
    }
    if (skippingManagedSection && /^#{1,6}\s+\S/u.test(line)) {
      skippingManagedSection = false;
    }
    if (!skippingManagedSection) {
      kept.push(line);
    }
  }

  return kept.join('\n').replace(/^\n+|\n+$/gu, '');
}

function replaceCalDavManagedSection(content: string, taskLines: string[], conflictDirection: 'vault-first' | 'service-first'): string {
  const block = `# ${CALDAV_SYNC_HEADING}\n${taskLines.join('\n')}`;
  const unmanagedContent = removeCalDavManagedSections(content);

  if (!unmanagedContent) {
    return `${block}\n`;
  }

  return conflictDirection === 'service-first'
    ? `${block}\n\n${unmanagedContent}\n`
    : `${unmanagedContent}\n\n${block}\n`;
}

async function updateVaultFileWithCurrentContent(
  app: App,
  path: string,
  updater: (current: string) => string,
  assertCurrent: () => void = () => undefined,
): Promise<void> {
  const guardedUpdater = (current: string): string => { assertCurrent(); return updater(current); };
  assertCurrent();
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.process(existing, guardedUpdater);
    assertCurrent();
    return;
  }
  const parentPath = path.replace(/\/[^/]+$/u, '');
  if (parentPath && parentPath !== path) {
    try { await app.vault.adapter.mkdir(parentPath); } catch { /* Parent folder may already exist. */ }
    assertCurrent();
  }
  try {
    assertCurrent();
    await app.vault.create(path, guardedUpdater(''));
    assertCurrent();
  } catch (error) {
    assertCurrent();
    const concurrentExisting = app.vault.getAbstractFileByPath(path);
    if (concurrentExisting instanceof TFile) {
      await app.vault.process(concurrentExisting, guardedUpdater);
      assertCurrent();
      return;
    }
    throw error;
  }
}

function splitICSList(text: string): string[] {
  const values: string[] = [];
  let current = '';
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === ',') {
      values.push(unescapeICSField(current).trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (escaped) current += '\\';
  values.push(unescapeICSField(current).trim());
  return values;
}

/**
 * Parse a VTODO component to extract task data
 */
export function parseVTODO(vtodo: string): Partial<ParsedTask> | null {
  const lines = unfoldICSLines(vtodo).split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
  if (!/^BEGIN:VTODO$/iu.test(lines[0] ?? '')) return null;

  const metadata: ParsedTask['metadata'] = {
    id: '',
    priority: 'normal' as const,
    dates: {},
    invalidDates: {},
    dependsOn: [],
  };
  const task: Partial<ParsedTask> & { tags: string[]; metadata: ParsedTask['metadata'] } = {
    normalizedText: '',
    tags: [],
    status: 'todo' as const,
    metadata,
  };

  for (const line of lines) {
    const uid = getICSPropertyValue(line, 'UID');
    const summary = getICSPropertyValue(line, 'SUMMARY');
    const description = getICSPropertyValue(line, 'DESCRIPTION');
    const priority = getICSPropertyValue(line, 'PRIORITY');
    const status = getICSPropertyValue(line, 'STATUS');
    const categories = getICSPropertyValue(line, 'CATEGORIES');
    const rrule = getICSPropertyValue(line, 'RRULE');
    const emptySummary = getICSPropertyValue(line, EMPTY_SUMMARY_PROPERTY);

    if (uid !== undefined) {
      metadata.id = unescapeICSField(uid);
    } else if (summary !== undefined) {
      task.normalizedText = unescapeICSField(summary);
    } else if (emptySummary !== undefined && emptySummary.trim().toUpperCase() === 'TRUE') {
      task.normalizedText = '';
    } else if (description !== undefined) {
      // No description field on TaskMetadata — append to normalizedText as a note
      const desc = unescapeICSField(description);
      if (desc) task.normalizedText = (task.normalizedText ?? '') + (task.normalizedText ? ' — ' + desc : desc);
    } else if (getICSPropertyValue(line, 'DUE') !== undefined) {
      const due = extractISODate(line);
      if (due) metadata.dates.due = due;
    } else if (getICSPropertyValue(line, 'DTSTART') !== undefined) {
      const start = extractISODate(line);
      if (start) metadata.dates.scheduled = start;
    } else if (priority !== undefined) {
      const pri = priorityFromICS(parseICSPriorityNumber(priority));
      if (pri) metadata.priority = pri as import('./task-model').TaskPriority;
    } else if (status !== undefined) {
      const statusMap: Record<NonNullable<CalendarEvent['status']>, import('./types').TaskStateType> = {
        'NEEDS-ACTION': 'todo',
        'IN-PROCESS': 'in_progress',
        'COMPLETED': 'done',
        'CANCELLED': 'cancelled',
      };
      const normalizedStatus = normalizeICSStatus(status);
      task.status = normalizedStatus ? statusMap[normalizedStatus] : 'todo';
    } else if (categories !== undefined) {
      task.tags = splitICSList(categories).map((tag) => tag.toLowerCase());
    } else if (rrule !== undefined) {
      metadata.recurrence = fromICSRecurrenceRule(rrule);
      metadata.recurrenceRaw = rrule;
      metadata.invalidRecurrence = !metadata.recurrence;
    }
  }

  const hasSyntheticEmptySummary = lines.some((line) => getICSPropertyValue(line, EMPTY_SUMMARY_PROPERTY)?.trim().toUpperCase() === 'TRUE');
  if (hasSyntheticEmptySummary && task.normalizedText === SYNTHETIC_EMPTY_SUMMARY) {
    task.normalizedText = '';
  }
  return task.normalizedText || hasSyntheticEmptySummary ? task : null;
}

/**
 * Format ICS calendar with VTODO components
 */
export function formatCalendarICS(vtodos: string[], options: { method?: 'PUBLISH' } = {}): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Obsidian Task Manager//EN',
    'CALSCALE:GREGORIAN',
    ...(options.method ? [`METHOD:${options.method}`] : []),
  ];

  lines.push(...vtodos);

  lines.push('END:VCALENDAR');
  return foldICSLines(lines);
}

interface RawCalendarComponent {
  type: 'VEVENT' | 'VTODO';
  uid?: string;
  start: number;
  end: number;
  content: string;
}

function rawCalendarComponents(content: string, strict = true): RawCalendarComponent[] {
  const components: RawCalendarComponent[] = [];
  const componentMarkerPattern = /^(BEGIN|END):(VEVENT|VTODO)[^\S\r\n]*$/gimu;
  let active: { type: RawCalendarComponent['type']; start: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = componentMarkerPattern.exec(content)) !== null) {
    const marker = match[1].toUpperCase();
    const type = match[2].toUpperCase() as RawCalendarComponent['type'];
    if (marker === 'BEGIN') {
      if (active) {
        if (strict) throw new CalDAVError('CalDAV calendar has nested component boundaries', 'invalid-calendar', 'reconcile');
        active = { type, start: match.index };
        continue;
      }
      active = { type, start: match.index };
      continue;
    }
    if (!active) {
      if (strict) throw new CalDAVError('CalDAV calendar has an END without a matching BEGIN', 'invalid-calendar', 'reconcile');
      continue;
    }
    if (active.type !== type) {
      if (strict) throw new CalDAVError('CalDAV calendar has mismatched component boundaries', 'invalid-calendar', 'reconcile');
      active = null;
      continue;
    }
    const end = match.index + match[0].length;
    const component = content.slice(active.start, end);
    const uidLine = unfoldICSLines(component).split(/\r?\n/u)
      .find((line) => getICSPropertyValue(line.trim(), 'UID') !== undefined);
    const uidValue = uidLine ? getICSPropertyValue(uidLine.trim(), 'UID') : undefined;
    components.push({
      type,
      uid: uidValue === undefined ? undefined : unescapeICSField(uidValue),
      start: active.start,
      end,
      content: component,
    });
    active = null;
  }
  if (active && strict) throw new CalDAVError('CalDAV calendar has a BEGIN without a matching END', 'invalid-calendar', 'reconcile');
  return components;
}

interface PreparedManagedVTODOs {
  byUid: Map<string, string>;
  managedCount: number;
  skippedCount: number;
}

function prepareManagedVTODOs(tasks: ParsedTask[]): PreparedManagedVTODOs {
  const byUid = new Map<string, string>();
  let skippedCount = 0;

  for (const task of tasks) {
    if (task.metadata.excludeFromSync) continue;
    const uid = task.metadata.id?.trim();
    if (!uid) {
      skippedCount += 1;
      continue;
    }
    if (byUid.has(uid)) {
      throw new CalDAVError(`Multiple local tasks share CalDAV UID ${uid}`, 'invalid-data', 'reconcile');
    }
    const identifiedTask: ParsedTask = {
      ...task,
      metadata: { ...task.metadata, id: uid },
    };
    byUid.set(uid, generateVTODO(identifiedTask));
  }

  return { byUid, managedCount: byUid.size, skippedCount };
}

function reconcilePreparedCalendar(
  remoteContent: string,
  prepared: PreparedManagedVTODOs,
  _conflictDirection: 'vault-first' | 'service-first',
): { content: string; managedCount: number; skippedCount: number; changed: boolean } {
  if (!/^BEGIN:VCALENDAR\s*$/imu.test(remoteContent) || !/^END:VCALENDAR\s*$/imu.test(remoteContent)) {
    throw new CalDAVError('CalDAV resource is not a valid VCALENDAR envelope', 'invalid-calendar', 'reconcile');
  }

  const localByUid = new Map(prepared.byUid);
  const replacements = new Map<number, string>();
  const matchedRemoteUids = new Set<string>();
  const components = rawCalendarComponents(remoteContent);
  for (const component of components) {
    if (component.type !== 'VTODO' || !component.uid || !localByUid.has(component.uid)) continue;
    if (matchedRemoteUids.has(component.uid)) {
      throw new CalDAVError(`Remote calendar contains duplicate VTODO UID ${component.uid}`, 'invalid-data', 'reconcile');
    }
    matchedRemoteUids.add(component.uid);
    const replacement = localByUid.get(component.uid);
    if (!replacement) continue;

    try {
      const merged = reconcileVTODO(component.content, replacement);
      if (merged !== component.content) replacements.set(component.start, merged);
    } catch (error) {
      if (error instanceof VTODOConflictError) throw new CalDAVError(error.message, 'conflict', 'reconcile', 409);
      throw error;
    }
    localByUid.delete(component.uid);
  }

  let merged = '';
  let cursor = 0;
  for (const component of components) {
    merged += remoteContent.slice(cursor, component.start);
    merged += replacements.get(component.start) ?? component.content;
    cursor = component.end;
  }
  merged += remoteContent.slice(cursor);

  if (localByUid.size > 0) {
    const endMatch = /^END:VCALENDAR\s*$/imu.exec(merged);
    if (!endMatch) throw new CalDAVError('CalDAV calendar has no closing VCALENDAR boundary', 'invalid-calendar', 'reconcile');
    const lineEnding = merged.includes('\r\n') ? '\r\n' : '\n';
    const before = merged.slice(0, endMatch.index);
    const separator = before.endsWith('\n') ? '' : lineEnding;
    const additions = Array.from(localByUid.values()).join(lineEnding);
    merged = `${before}${separator}${additions}${lineEnding}${merged.slice(endMatch.index)}`;
  }

  return {
    content: merged,
    managedCount: prepared.managedCount,
    skippedCount: prepared.skippedCount,
    changed: merged !== remoteContent,
  };
}

/**
 * Reconcile explicitly identified Task Manager VTODOs into a previously-read
 * calendar. Tasks without a durable ID are skipped; line positions are never
 * used as managed sync identity. Remote-only components are never deleted.
 */
export function reconcileCalendarICS(
  remoteContent: string,
  tasks: ParsedTask[],
  conflictDirection: 'vault-first' | 'service-first' = 'vault-first',
): { content: string; managedCount: number; skippedCount: number; changed: boolean } {
  return reconcilePreparedCalendar(remoteContent, prepareManagedVTODOs(tasks), conflictDirection);
}

/**
 * Convert CalendarEvent to Obsidian task markdown line
 */
export function calendarEventToTaskLine(event: CalendarEvent): string {
  const parts: string[] = [];

  const checkboxByStatus: Record<NonNullable<CalendarEvent['status']>, string> = {
    'NEEDS-ACTION': ' ',
    'IN-PROCESS': '/',
    'COMPLETED': 'x',
    'CANCELLED': '-',
  };
  parts.push(`- [${event.status ? checkboxByStatus[event.status] : ' '}]`);
  const summary = event.emptySummary ? '' : sanitizeCalendarText(event.summary);
  if (summary) {
    parts.push(summary);
  } else if (!event.emptySummary) {
    parts.push('Untitled calendar event');
  }

  if (event.due) parts.push(`📅 ${event.due}`);
  if (event.dtstart) parts.push(`🛫 ${event.dtstart}`);
  if (event.completed) parts.push(`✅ ${event.completed}`);

  const priority = priorityFromICS(event.priority);
  if (priority) parts.push(`🎯 ${priority}`);

  const recurrence = event.rrule ? fromICSRecurrenceRule(event.rrule) : undefined;
  if (recurrence) parts.push(`🔁 ${recurrence}`);
  else if (event.rrule) parts.push(`[caldav_rrule:: ${encodeURIComponent(event.rrule)}]`);
  if (event.alarm !== undefined) parts.push(`⏰ alarm-${event.alarm}m`);

  if (event.categories) {
    for (const cat of event.categories) {
      const tag = sanitizeUntrustedTag(markdownInline(cat));
      if (tag) parts.push(`#${tag}`);
    }
  }

  const uid = safeCalendarTaskId(event.uid);
  if (uid) parts.push(`[id:: ${uid}]`);

  return parts.join(' ');
}

/**
 * Import ICS file into vault as tasks
 */
export async function importICSFile(
  app: App,
  file: TFile,
  targetPath: string,
  heading: string = 'Imported Tasks',
): Promise<number> {
  const content = await app.vault.read(file);

  const events = parseICSFile(content);

  const taskLines = events.map(calendarEventToTaskLine);

  await updateVaultFileWithCurrentContent(app, targetPath, (current) => appendTaskLinesUnderHeading(current, taskLines, heading));

  return events.length;
}

type CalDAVRemoteSyncResult =
  | { status: 'success'; content: string; uploaded: number; skipped: number; remoteChanged: boolean }
  | { status: 'conflict'; uploaded: number; skipped: number; statusCode: 409 | 412 }
  | { status: 'not-found'; uploaded: 0; skipped: number }
  | { status: 'partial'; uploaded: number; skipped: number; error: Error };

export type CalDAVSyncResult =
  | { status: 'success'; uploaded: number; skipped: 0; fetched: number; remoteChanged: boolean }
  | { status: 'partial'; uploaded: number; skipped: number; fetched: number; reason: 'skipped' | 'vault-write' | 'remote-write'; error?: Error }
  | { status: 'conflict'; uploaded: number; skipped: number; fetched: 0; statusCode: 409 | 412 }
  | { status: 'not-found'; uploaded: 0; skipped: number; fetched: 0 }
  | { status: 'cancelled'; uploaded: number; skipped: number; fetched: number }
  | { status: 'failure'; uploaded: 0; skipped: number; fetched: 0; error: Error };

export interface CalDAVRunContext { signal?: AbortSignal; isCurrent?: () => boolean }

function isCalDavCancellation(error: unknown): boolean {
  return error instanceof CalDAVError && error.kind === 'cancelled';
}

function assertCalDavRunCurrent(context: CalDAVRunContext, operation: CalDAVError['operation'] = 'reconcile'): void {
  if (context.signal?.aborted || context.isCurrent?.() === false) {
    throw new CalDAVError('CalDAV run was cancelled', 'cancelled', operation);
  }
}

function reportCalDavProgress(context: CalDAVRunContext, onProgress: ((status: string) => void) | undefined, status: string): void {
  assertCalDavRunCurrent(context);
  onProgress?.(status);
  assertCalDavRunCurrent(context);
}

function updatePrecondition(resource: CalDAVResource): CalDAVPrecondition | undefined {
  // Only a syntactically strong ETag is a version guard (never wildcard/weak).
  // Legacy ICS snapshots may fall back to Last-Modified; collection objects may not.
  if (resource.etag && /^"[\x21\x23-\x7e]*"$/u.test(resource.etag)) return { kind: 'match', etag: resource.etag };
  if (resource.lastModified) return { kind: 'unmodified-since', lastModified: resource.lastModified };
  return undefined;
}

interface CollectionObject { path: string; resource: CalDAVResource; components: RawCalendarComponent[] }

function collectionRunCheck(context: CalDAVRunContext): () => void {
  const started = Date.now();
  return () => {
    assertCalDavRunCurrent(context);
    if (Date.now() - started > 120_000) throw new CalDAVError('CalDAV collection run exceeded its two-minute work budget; read remote state before retrying', 'timeout', 'reconcile');
  };
}

async function readCalDAVCollection(client: CalDAVClient, path: string, check: () => void): Promise<Map<string, CollectionObject>> {
  check();
  const hrefs = await client.calendarObjects(path);
  check();
  const objects = new Map<string, CollectionObject>();
  let bytes = 0;
  for (const href of hrefs) {
    check();
    const read = await client.get(href);
    check();
    if (read.status !== 'success') throw new CalDAVError('A listed calendar object disappeared; snapshot is incomplete', 'conflict', 'GET', 409);
    bytes += new TextEncoder().encode(read.resource.content).byteLength;
    if (bytes > 32 * 1024 * 1024) throw new CalDAVError('CalDAV collection exceeds the 32 MiB aggregate limit', 'response-too-large', 'GET');
    reconcilePreparedCalendar(read.resource.content, { byUid: new Map(), managedCount: 0, skippedCount: 0 }, 'vault-first');
    const components = rawCalendarComponents(read.resource.content);
    const uids = new Set(components.map((component) => component.uid));
    const types = new Set(components.map((component) => component.type));
    if (!components.length || uids.size !== 1 || uids.has(undefined) || types.size !== 1) throw new CalDAVError('Each CalDAV calendar-object resource must contain one UID and one component type', 'invalid-calendar', 'GET');
    const uid = components[0].uid;
    if (!uid || objects.has(uid)) throw new CalDAVError('Duplicate calendar-object UID across collection resources', 'invalid-data', 'GET');
    objects.set(uid, { path: href, resource: read.resource, components });
  }
  return objects;
}

function collectionProjection(objects: ReadonlyMap<string, CollectionObject>): string {
  return formatCalendarICS([...objects.values()].flatMap((object) => object.components
    .filter((component) => !/^RECURRENCE-ID[;:]/imu.test(component.content)).map((component) => component.content)));
}

async function reconcileRemoteCollection(
  client: CalDAVClient, tasks: ParsedTask[], path: string, direction: 'vault-first' | 'service-first',
  onProgress: ((status: string) => void) | undefined, context: CalDAVRunContext,
): Promise<CalDAVRemoteSyncResult> {
  const check = collectionRunCheck(context);
  const prepared = prepareManagedVTODOs(tasks);
  reportCalDavProgress(context, onProgress, 'Discovering and reading CalDAV calendar-object resources...');
  const objects = await readCalDAVCollection(client, path, check);
  const writes: Array<{ path: string; content: string; uid: string; precondition: CalDAVPrecondition; prepared: PreparedManagedVTODOs }> = [];
  for (const [uid, component] of prepared.byUid) {
    check();
    const existing = objects.get(uid);
    const single = { byUid: new Map([[uid, component]]), managedCount: 1, skippedCount: 0 };
    if (existing) {
      if (existing.components.length !== 1 || existing.components[0].type !== 'VTODO') throw new CalDAVError('Matching UID has an unsupported event/recurrence-exception structure; refusing replacement', 'conflict', 'reconcile', 409);
      const merged = reconcilePreparedCalendar(existing.resource.content, single, direction);
      if (!merged.changed) continue;
      const precondition = updatePrecondition(existing.resource);
      if (!precondition || precondition.kind !== 'match') throw new CalDAVError('Calendar-object updates require a strong ETag', 'missing-precondition', 'PUT');
      writes.push({ path: existing.path, uid, content: merged.content, precondition, prepared: single });
    } else {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uid));
      const name = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      writes.push({ path: client.collectionHref(path, `task-${name}.ics`), uid, content: formatCalendarICS([component]), precondition: { kind: 'none-match' }, prepared: single });
    }
  }
  let committed = 0;
  // Plan every object before the first mutation; an unrelated conflict must not cause a partial batch.
  for (const write of writes) {
    try {
      check();
      reportCalDavProgress(context, onProgress, 'Conditionally writing one CalDAV calendar object...');
      const result = await client.put(write.path, write.content, write.precondition);
      check();
      if (result.status === 'conflict') {
        if (!committed) return { status: 'conflict', uploaded: 0, skipped: prepared.skippedCount, statusCode: result.statusCode };
        throw new CalDAVError('A later object changed remotely; earlier conditional writes may have committed', 'conflict', 'PUT', result.statusCode);
      }
      committed += 1;
      const verified = await client.get(write.path);
      check();
      if (verified.status !== 'success' || reconcilePreparedCalendar(verified.resource.content, write.prepared, direction).changed) throw new CalDAVError('Calendar-object post-write verification failed; do not replay without a fresh read', 'conflict', 'GET', 409);
      const components = rawCalendarComponents(verified.resource.content);
      if (components.length !== 1 || components[0].uid !== write.uid || components[0].type !== 'VTODO') throw new CalDAVError('Calendar-object identity verification failed', 'invalid-data', 'GET');
      objects.set(write.uid, { path: write.path, resource: verified.resource, components });
    } catch (error) {
      if (isCalDavCancellation(error)) throw error;
      return { status: 'partial', uploaded: committed, skipped: prepared.skippedCount, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
  return { status: 'success', content: collectionProjection(objects), uploaded: prepared.managedCount, skipped: prepared.skippedCount, remoteChanged: writes.length > 0 };
}

async function reconcileRemoteCalendar(
  client: CalDAVClient,
  tasks: ParsedTask[],
  calendarPath: string,
  conflictDirection: 'vault-first' | 'service-first',
  onProgress?: (status: string) => void,
  context: CalDAVRunContext = {},
): Promise<CalDAVRemoteSyncResult> {
  assertCalDavRunCurrent(context);
  if (calendarPath.endsWith('/')) return reconcileRemoteCollection(client, tasks, calendarPath, conflictDirection, onProgress, context);
  if (!/\.ics(?:\?|$)/iu.test(calendarPath)) throw new CalDAVError('Use a collection path ending in /, or an explicit legacy .ics snapshot resource', 'invalid-data', 'reconcile');
  const prepared = prepareManagedVTODOs(tasks);
  if (prepared.skippedCount > 0) reportCalDavProgress(context, onProgress, `Skipping ${prepared.skippedCount} task(s) without a durable ID...`);
  reportCalDavProgress(context, onProgress, 'Reading CalDAV calendar and precondition metadata...');
  const read = await client.get(calendarPath);
  assertCalDavRunCurrent(context, 'GET');
  if (read.status === 'not-found') {
    const vtodos = Array.from(prepared.byUid.values());
    if (vtodos.length === 0) return { status: 'not-found', uploaded: 0, skipped: prepared.skippedCount };
    reportCalDavProgress(context, onProgress, 'Creating missing CalDAV calendar safely...');
    const content = formatCalendarICS(vtodos);
    assertCalDavRunCurrent(context, 'PUT');
    const create = await client.put(calendarPath, content, { kind: 'none-match' });
    assertCalDavRunCurrent(context, 'PUT');
    if (create.status === 'conflict') return { status: 'conflict', uploaded: vtodos.length, skipped: prepared.skippedCount, statusCode: create.statusCode };
    return { status: 'success', content, uploaded: vtodos.length, skipped: prepared.skippedCount, remoteChanged: true };
  }
  reportCalDavProgress(context, onProgress, 'Reconciling VTODOs by UID...');
  const reconciled = reconcilePreparedCalendar(read.resource.content, prepared, conflictDirection);
  if (!reconciled.changed) return { status: 'success', content: read.resource.content, uploaded: reconciled.managedCount, skipped: reconciled.skippedCount, remoteChanged: false };
  const precondition = updatePrecondition(read.resource);
  if (!precondition) throw new CalDAVError('CalDAV server did not provide a usable strong ETag or Last-Modified precondition; refusing calendar replacement', 'missing-precondition', 'PUT');
  reportCalDavProgress(context, onProgress, 'Uploading reconciled calendar with an optimistic precondition...');
  assertCalDavRunCurrent(context, 'PUT');
  const write = await client.put(calendarPath, reconciled.content, precondition);
  assertCalDavRunCurrent(context, 'PUT');
  if (write.status === 'conflict') return { status: 'conflict', uploaded: reconciled.managedCount, skipped: reconciled.skippedCount, statusCode: write.statusCode };
  return { status: 'success', content: reconciled.content, uploaded: reconciled.managedCount, skipped: reconciled.skippedCount, remoteChanged: true };
}

/**
 * Safe outbound-only entry point retained for API compatibility. It always reads,
 * reconciles, and conditionally writes; it never creates a whole local calendar
 * over an existing resource.
 */
export async function syncTasksToCalDAV(
  client: CalDAVClient,
  tasks: ParsedTask[],
  calendarPath: string,
  onProgress?: (status: string) => void,
): Promise<number> {
  const result = await reconcileRemoteCalendar(client, tasks, calendarPath, 'vault-first', onProgress);
  if (result.status === 'success') return result.uploaded;
  if (result.status === 'partial') throw result.error;
  if (result.status === 'not-found') {
    throw new CalDAVError('CalDAV calendar was not found', 'not-found', 'GET', 404);
  }
  throw new CalDAVError(`CalDAV calendar changed during sync (HTTP ${result.statusCode})`, 'conflict', 'PUT', result.statusCode);
}

/** Fetch a calendar into the managed vault section. Read failures never become zero-count success. */
export async function syncTasksFromCalDAV(
  app: App,
  client: CalDAVClient,
  calendarPath: string,
  targetVaultPath: string,
  conflictDirection: 'vault-first' | 'service-first',
  onProgress?: (status: string) => void,
): Promise<number> {
  onProgress?.('Fetching from CalDAV server...');
  const read = calendarPath.endsWith('/')
    ? { status: 'success' as const, resource: { content: collectionProjection(await readCalDAVCollection(client, calendarPath, collectionRunCheck({}))) } }
    : await client.get(calendarPath);
  if (read.status === 'not-found') {
    throw new CalDAVError('CalDAV calendar was not found', 'not-found', 'GET', 404);
  }
  const events = parseICSFile(read.resource.content);
  onProgress?.(`Found ${events.length} events on server`);
  const taskLines = events.map(calendarEventToTaskLine);
  await updateVaultFileWithCurrentContent(app, targetVaultPath, (current) => replaceCalDavManagedSection(current, taskLines, conflictDirection));
  onProgress?.('CalDAV sync complete');
  return events.length;
}

/** One read-first, reconcile-first CalDAV run used by the plugin command. */
export async function syncTasksWithCalDAV(
  app: App,
  client: CalDAVClient,
  tasks: ParsedTask[],
  calendarPath: string,
  targetVaultPath: string,
  conflictDirection: 'vault-first' | 'service-first',
  onProgress?: (status: string) => void,
  context: CalDAVRunContext = {},
): Promise<CalDAVSyncResult> {
  // The managed import section is a remote projection, not a second outbound
  // source. Excluding it prevents remote-only/unmanaged items from becoming
  // implicitly managed merely because a previous run displayed them locally.
  const outboundTasks = tasks.filter((task) => !(
    task.filePath === targetVaultPath && task.heading === CALDAV_SYNC_HEADING
  ));

  const skipped = outboundTasks.reduce((count, task) => (
    !task.metadata.excludeFromSync && !task.metadata.id?.trim() ? count + 1 : count
  ), 0);
  let remote: CalDAVRemoteSyncResult;
  try {
    remote = await reconcileRemoteCalendar(client, outboundTasks, calendarPath, conflictDirection, onProgress, context);
    assertCalDavRunCurrent(context);
  } catch (error) {
    if (isCalDavCancellation(error)) return { status: 'cancelled', uploaded: 0, skipped, fetched: 0 };
    if (error instanceof CalDAVError && error.kind === 'conflict') return { status: 'conflict', uploaded: 0, skipped, fetched: 0, statusCode: 409 };
    return { status: 'failure', uploaded: 0, skipped, fetched: 0, error: error instanceof Error ? error : new Error(String(error)) };
  }
  if (remote.status === 'conflict') {
    return { status: 'conflict', uploaded: remote.uploaded, skipped: remote.skipped, fetched: 0, statusCode: remote.statusCode };
  }
  if (remote.status === 'not-found') return { status: 'not-found', uploaded: 0, skipped: remote.skipped, fetched: 0 };
  if (remote.status === 'partial') return { status: 'partial', uploaded: remote.uploaded, skipped: remote.skipped, fetched: 0, reason: 'remote-write', error: remote.error };

  const events = parseICSFile(remote.content);
  try {
    assertCalDavRunCurrent(context);
    await updateVaultFileWithCurrentContent(app, targetVaultPath, (current) => replaceCalDavManagedSection(
      current,
      events.map(calendarEventToTaskLine),
      conflictDirection,
    ), () => assertCalDavRunCurrent(context));
    assertCalDavRunCurrent(context);
  } catch (error) {
    if (isCalDavCancellation(error)) return { status: 'cancelled', uploaded: remote.uploaded, skipped: remote.skipped, fetched: events.length };
    return { status: 'partial', uploaded: remote.uploaded, skipped: remote.skipped, fetched: events.length, reason: 'vault-write', error: error instanceof Error ? error : new Error(String(error)) };
  }
  try {
    if (remote.skipped > 0) {
      reportCalDavProgress(context, onProgress, `CalDAV sync partially complete: ${remote.skipped} task(s) skipped without durable IDs`);
      return { status: 'partial', uploaded: remote.uploaded, skipped: remote.skipped, fetched: events.length, reason: 'skipped' };
    }
    reportCalDavProgress(context, onProgress, 'CalDAV sync complete');
    return { status: 'success', uploaded: remote.uploaded, skipped: 0, fetched: events.length, remoteChanged: remote.remoteChanged };
  } catch (error) {
    if (isCalDavCancellation(error)) return { status: 'cancelled', uploaded: remote.uploaded, skipped: remote.skipped, fetched: events.length };
    throw error;
  }
}

/**
 * Sync configuration for CalDAV
 */
export interface CalDAVSyncConfig {
  /** CalDAV server URL */
  url: string;
  /** Username for basic auth */
  username: string;
  /** Password for basic auth */
  password: string;
  /** Path to target vault file for synced tasks */
  vaultPath: string;
  /** Last sync timestamp */
  lastSync?: number;
}

/**
 * Export vault tasks as ICS calendar feed
 */
export function tasksToICS(tasks: Array<{ summary: string; due?: string; priority?: string; rrule?: string }>): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Obsidian Task Manager//EN',
    'CALSCALE:GREGORIAN',
  ];

  for (const task of tasks) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${generateICSUid(task.summary)}`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
    lines.push(`SUMMARY:${escapeICSField(task.summary)}`);
    if (task.due) {
      lines.push(icsDateProperty('DUE', formatDateForICS(task.due)));
    }
    if (task.priority) {
      lines.push(`PRIORITY:${priorityToICSNumber(task.priority)}`);
    }
    if (task.rrule) {
      lines.push(`RRULE:${toICSRecurrenceRule(task.rrule, { anchor: task.due })}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return foldICSLines(lines);
}

/**
 * Format date for ICS (YYYYMMDD or YYYYMMDDTHHmmss)
 */
function formatDateForICS(dateStr: string, timeStr?: string): string {
  const trimmed = dateStr.trim();
  const match = trimmed.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[ T](\d{1,2}):?(\d{2})(?::?(\d{2}))?Z?)?$/u);
  if (!match) {
    return dateStr.replace(/[-:]/g, '').split('T')[0];
  }

  const [, year, month, day, inlineHour, inlineMinute, inlineSecond] = match;
  const time = normalizeICSTimeForExport(timeStr)
    ?? normalizeICSTimeForExport(inlineHour && inlineMinute ? `${inlineHour}:${inlineMinute}${inlineSecond ? `:${inlineSecond}` : ''}` : undefined);

  if (time) return `${year}${month}${day}T${time}`;
  return `${year}${month}${day}`;
}

function normalizeICSTimeForExport(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] ? Number(match[3]) : 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(minute) || minute < 0 || minute > 59
    || !Number.isInteger(second) || second < 0 || second > 59) {
    return undefined;
  }
  return `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}${String(second).padStart(2, '0')}`;
}
