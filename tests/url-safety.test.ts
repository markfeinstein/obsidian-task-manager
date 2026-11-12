import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeHttpsUrlForRequest, type HostnameResolver } from '../src/url-safety';

test('isSafeHttpsUrlForRequest allows public HTTPS hosts resolving to public IPs', async () => {
  const resolver: HostnameResolver = async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];

  assert.equal(await isSafeHttpsUrlForRequest('https://example.com/hook', resolver), true);
});

test('isSafeHttpsUrlForRequest rejects empty DNS results', async () => {
  const resolver: HostnameResolver = async () => [];

  assert.equal(await isSafeHttpsUrlForRequest('https://example.com/hook', resolver), false);
});

test('isSafeHttpsUrlForRequest rejects hosts resolving to private addresses', async () => {
  const resolver: HostnameResolver = async () => ['93.184.216.34', '10.0.0.5'];

  assert.equal(await isSafeHttpsUrlForRequest('https://example.com/hook', resolver), false);
});

test('isSafeHttpsUrlForRequest rejects .local hosts before DNS resolution', async () => {
  let resolved = false;
  const resolver: HostnameResolver = async () => { resolved = true; return ['93.184.216.34']; };

  assert.equal(await isSafeHttpsUrlForRequest('https://printer.local/hook', resolver), false);
  assert.equal(resolved, false);
});

test('isSafeHttpsUrlForRequest rejects special-use non-public addresses', async () => {
  const blocked = [
    '198.18.0.1', '224.0.0.1', '240.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    'ff02::1', '2001:db8::1', '64:ff9b::808:808', '100::1',
    '2001::1', '2001:2::1', '2001:10::1', '2001:20::1', '2002::1', 'fec0::1',
  ];

  for (const address of blocked) {
    const resolver: HostnameResolver = async () => [address];
    assert.equal(await isSafeHttpsUrlForRequest('https://example.com/hook', resolver), false, address);
  }
});

test('isSafeHttpsUrlForRequest fails closed without an injected resolver', async () => {
  assert.equal(await isSafeHttpsUrlForRequest('https://example.com/hook'), false);
});

test('isSafeHttpsUrlForRequest rejects when DNS validation is unavailable', async () => {
  const resolver: HostnameResolver = async () => null;

  assert.equal(await isSafeHttpsUrlForRequest('https://example.com/hook', resolver), false);
});
