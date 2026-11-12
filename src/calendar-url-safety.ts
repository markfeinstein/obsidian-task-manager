import { isLocalOrPrivateHost, isSafeHttpsUrlForRequest, resolveHostnameWithNodeDns, type HostnameResolver } from './url-safety';

const DEFAULT_CALENDAR_FETCH_TIMEOUT_MS = 15_000;
const MAX_CALENDAR_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface SafeCalendarRequest {
  url: URL;
  address: string;
  headers?: Record<string, string>;
}

export interface SafeCalendarResponse {
  status: number;
  text: string;
}

export type PinnedCalendarTransport = (request: SafeCalendarRequest) => Promise<SafeCalendarResponse>;

export interface SafeCalendarFetchOptions {
  headers?: Record<string, string>;
  resolver?: HostnameResolver;
  transport?: PinnedCalendarTransport;
  timeoutMs?: number;
}

interface SafeCalendarTarget {
  url: URL;
  address: string;
}

export function isSafeCalendarUrlForRequest(url: string, resolver?: HostnameResolver): Promise<boolean> {
  return isSafeHttpsUrlForRequest(url, resolver);
}

export async function fetchSafeCalendarText(url: string, options: SafeCalendarFetchOptions = {}): Promise<string> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CALENDAR_FETCH_TIMEOUT_MS);
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const work = (async (): Promise<string> => {
    if (!options.transport) {
      throw new Error('Remote calendar URLs are disabled because this plugin runtime cannot pin DNS and reject redirects safely.');
    }
    const target = await resolveSafeCalendarTarget(url, options.resolver);
    if (!target) throw new Error('Calendar URL must be a public HTTPS URL.');
    const response = await options.transport({ url: target.url, address: target.address, headers: options.headers });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    if (new TextEncoder().encode(response.text).byteLength > MAX_CALENDAR_RESPONSE_BYTES) throw new Error('Calendar response is too large.');
    return response.text;
  })();
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error('Calendar request timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

/** Compatibility helper for a trusted transport that supports a pinned lookup. */
export function createPinnedCalendarLookup(address: string): (
  hostname: string,
  options: unknown,
  callback: (error: Error | null, address: string, family: number) => void,
) => void {
  const family = address.includes(':') ? 6 : 4;
  return (_hostname, _options, callback) => callback(null, address, family);
}

async function resolveSafeCalendarTarget(url: string, resolver?: HostnameResolver): Promise<SafeCalendarTarget | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || isLocalOrPrivateHost(parsed.hostname)) return null;
  const addresses = await (resolver ?? resolveHostnameWithNodeDns)(parsed.hostname);
  if (addresses === null || addresses.length === 0 || addresses.some((address) => isLocalOrPrivateHost(address))) return null;
  return { url: parsed, address: addresses[0] };
}
