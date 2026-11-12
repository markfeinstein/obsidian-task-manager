export const DEFAULT_NETWORK_TIMEOUT_MS = 15_000;
export const DEFAULT_NETWORK_MAX_BYTES = 5 * 1024 * 1024;
export const OAUTH_NETWORK_MAX_BYTES = 256 * 1024;
export const AI_NETWORK_MAX_BYTES = 1024 * 1024;

export interface NetworkReadOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  redirect?: RequestRedirect;
}

export class NetworkRequestError extends Error {
  constructor(message: string, readonly code: 'timeout' | 'cancelled' | 'too-large' | 'invalid-body' | 'network') {
    super(message);
    this.name = 'NetworkRequestError';
  }
}

/** Typed provider response failure consumed by sync retry/backoff policy. */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly statusCode: number;

  constructor(message: string, statusCode: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = statusCode;
    this.statusCode = statusCode;
  }
}

function normalizedOptions(init: RequestInit, options: NetworkReadOptions | number = {}): Required<Pick<NetworkReadOptions, 'timeoutMs' | 'maxBytes' | 'redirect'>> & { signal?: AbortSignal } {
  const resolved = typeof options === 'number' ? { timeoutMs: options } : options;
  return {
    timeoutMs: Math.max(1, resolved.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS),
    maxBytes: Math.max(0, resolved.maxBytes ?? DEFAULT_NETWORK_MAX_BYTES),
    redirect: resolved.redirect ?? 'error',
    signal: resolved.signal ?? init.signal ?? undefined,
  };
}

async function abortableRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void read.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readBoundedBody(response: Response, maxBytes: number, controller: AbortController): Promise<Uint8Array> {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    throw new NetworkRequestError(`Network response exceeded the ${maxBytes}-byte limit`, 'too-large');
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await abortableRead(reader.read(), controller.signal);
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new NetworkRequestError(`Network response exceeded the ${maxBytes}-byte limit`, 'too-large');
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return joined;
  }
  // Test/legacy Response doubles may expose only text/json. Production fetch
  // responses use the streaming branch above.
  let text = '';
  if (typeof response.text === 'function') text = await abortableRead(response.text(), controller.signal);
  else if (typeof response.json === 'function') text = JSON.stringify(await abortableRead(response.json(), controller.signal));
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) throw new NetworkRequestError(`Network response exceeded the ${maxBytes}-byte limit`, 'too-large');
  return bytes;
}

/** Fetch and fully buffer a bounded body before clearing timeout/cancellation. */
export async function requestResponse(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: NetworkReadOptions | number = {},
): Promise<Response> {
  const policy = normalizedOptions(init, options);
  const controller = new AbortController();
  const parentSignal = policy.signal;
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  let timedOut = false;
  const timer = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, policy.timeoutMs);
  try {
    const response = await fetch(input, { ...init, redirect: policy.redirect, signal: controller.signal });
    const bytes = await readBoundedBody(response, policy.maxBytes, controller);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const body: BodyInit | null = [204, 205, 304].includes(response.status) ? null : copy.buffer;
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    if (error instanceof NetworkRequestError) throw error;
    if (timedOut) throw new NetworkRequestError(`Network request timed out after ${policy.timeoutMs} ms`, 'timeout');
    if (parentSignal?.aborted) throw new NetworkRequestError('Network request was cancelled', 'cancelled');
    throw new NetworkRequestError(`Network request failed: ${error instanceof Error ? error.message : String(error)}`, 'network');
  } finally {
    globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

export async function requestText(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: NetworkReadOptions | number = {},
): Promise<{ response: Response; body: string }> {
  const response = await requestResponse(input, init, options);
  try {
    return { response, body: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(await response.arrayBuffer())) };
  } catch (error) {
    throw new NetworkRequestError(`Network response text was invalid: ${error instanceof Error ? error.message : String(error)}`, 'invalid-body');
  }
}

export async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: NetworkReadOptions | number = {},
): Promise<{ response: Response; body: T }> {
  const { response, body } = await requestText(input, init, options);
  try {
    return { response, body: JSON.parse(body) as T };
  } catch {
    throw new NetworkRequestError('Network response was not valid JSON', 'invalid-body');
  }
}

export async function requestWithoutBody(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: NetworkReadOptions | number = {},
): Promise<Response> {
  return requestResponse(input, init, options);
}

/** Compatibility alias while provider adapters migrate to the bounded helpers. */
export const fetchWithDeadline = requestResponse;

export function retryAfterMilliseconds(response: Response, maxMs = 30_000): number | undefined {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  const value = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(raw) - Date.now();
  return Number.isFinite(value) ? Math.max(0, Math.min(maxMs, value)) : undefined;
}
