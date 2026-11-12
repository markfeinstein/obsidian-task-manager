import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkRequestError, requestJson, requestResponse, requestText } from '../src/network-request';

async function withFetch<T>(replacement: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('network request buffers and decodes a bounded JSON body', async () => {
  await withFetch(async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    const result = await requestJson<{ ok: boolean }>('https://provider.invalid', {}, { maxBytes: 64 });
    assert.equal(result.body.ok, true);
    assert.equal(result.response.ok, true);
  });
});

test('network request rejects declared and streamed bodies over the cap', async () => {
  await withFetch(async () => new Response('oversized', { headers: { 'content-length': '9' } }), async () => {
    await assert.rejects(requestText('https://provider.invalid', {}, { maxBytes: 4 }), (error: unknown) => error instanceof NetworkRequestError && error.code === 'too-large');
  });
  await withFetch(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('123')); controller.enqueue(new TextEncoder().encode('456')); controller.close(); } })), async () => {
    await assert.rejects(requestResponse('https://provider.invalid', {}, { maxBytes: 5 }), (error: unknown) => error instanceof NetworkRequestError && error.code === 'too-large');
  });
});

test('network timeout and parent cancellation remain active while reading the body', async () => {
  await withFetch(async (_input, init) => new Response(new ReadableStream({ start() { init?.signal?.addEventListener('abort', () => undefined); } })), async () => {
    await assert.rejects(requestResponse('https://provider.invalid', {}, { timeoutMs: 5, maxBytes: 64 }), (error: unknown) => error instanceof NetworkRequestError && error.code === 'timeout');
  });
  const controller = new AbortController();
  await withFetch(async (_input, init) => new Response(new ReadableStream({ start() { init?.signal?.addEventListener('abort', () => undefined); } })), async () => {
    const pending = requestResponse('https://provider.invalid', {}, { signal: controller.signal, timeoutMs: 1000, maxBytes: 64 });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof NetworkRequestError && error.code === 'cancelled');
  });
});
