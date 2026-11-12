import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinnedCalendarLookup, fetchSafeCalendarText, isSafeCalendarUrlForRequest, type PinnedCalendarTransport, type SafeCalendarRequest } from '../src/calendar-url-safety';
import type { HostnameResolver } from '../src/url-safety';

const publicResolver: HostnameResolver = async () => ['93.184.216.34'];
const privateResolver: HostnameResolver = async () => ['127.0.0.1'];
const mixedResolver: HostnameResolver = async () => ['93.184.216.34', '127.0.0.1'];
const unavailableResolver: HostnameResolver = async () => null;

test('calendar URL safety allows public HTTPS calendar URLs', async () => {
  assert.equal(await isSafeCalendarUrlForRequest('https://calendar.example/events.ics', publicResolver), true);
});

test('calendar URL safety rejects non-HTTPS and private hosts', async () => {
  assert.equal(await isSafeCalendarUrlForRequest('http://calendar.example/events.ics', publicResolver), false);
  assert.equal(await isSafeCalendarUrlForRequest('https://127.0.0.1/events.ics', publicResolver), false);
  assert.equal(await isSafeCalendarUrlForRequest('https://calendar.example/events.ics', privateResolver), false);
});

test('calendar URL safety fails closed when DNS validation is unavailable', async () => {
  assert.equal(await isSafeCalendarUrlForRequest('https://calendar.example/events.ics', unavailableResolver), false);
});

test('calendar safe fetch rejects mixed public and private DNS answers', async () => {
  assert.equal(await isSafeCalendarUrlForRequest('https://calendar.example/events.ics', mixedResolver), false);
  await assert.rejects(
    fetchSafeCalendarText('https://calendar.example/events.ics', { resolver: mixedResolver, transport: async () => ({ status: 200, text: '' }), timeoutMs: 20 }),
    /public HTTPS/u,
  );
});

test('calendar production path fails closed without a pinning and no-redirect transport', async () => {
  await assert.rejects(
    fetchSafeCalendarText('https://calendar.example/events.ics', { resolver: publicResolver }),
    /disabled.*cannot pin DNS and reject redirects/iu,
  );
});

test('calendar injected transport receives the validated address and rejects redirects', async () => {
  const capture: { request?: SafeCalendarRequest } = {};
  const transport: PinnedCalendarTransport = async (request) => {
    capture.request = request;
    return { status: 302, text: '' };
  };
  await assert.rejects(
    fetchSafeCalendarText('https://calendar.example/events.ics', { resolver: publicResolver, transport }),
    /HTTP 302/u,
  );
  assert.equal(capture.request?.url.hostname, 'calendar.example');
  assert.equal(capture.request?.address, '93.184.216.34');
});

test('calendar URL lookup pins the validated address for request time', async () => {
  const lookup = createPinnedCalendarLookup('93.184.216.34');
  await new Promise<void>((resolve, reject) => {
    lookup('calendar.example', {}, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      assert.equal(address, '93.184.216.34');
      assert.equal(family, 4);
      resolve();
    });
  });
});

test('calendar safe fetch timeout covers hung DNS resolution', async () => {
  const hangingResolver: HostnameResolver = () => new Promise(() => {});
  const startedAt = Date.now();

  await assert.rejects(
    fetchSafeCalendarText('https://calendar.example/events.ics', { resolver: hangingResolver, transport: async () => ({ status: 200, text: '' }), timeoutMs: 20 }),
    /timed out/u,
  );

  assert.ok(Date.now() - startedAt < 1_000);
});
