import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const PROTOCOL_VERSION = '2025-06-18';
const PACKAGE_VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startCompanion(context, cliSource, environment = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'task-manager-mcp-companion-'));
  const cli = path.join(directory, 'fake-obsidian.mjs');
  writeFileSync(cli, `#!/usr/bin/env node\n${cliSource}\n`);
  chmodSync(cli, 0o755);
  const port = await freePort();
  const token = 'test-token-with-sufficient-entropy';
  const child = spawn(process.execPath, ['scripts/mcp-companion.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBSIDIAN_TASK_MANAGER_TOKEN: token,
      OBSIDIAN_TASK_MANAGER_MCP_PORT: String(port),
      OBSIDIAN_CLI: cli,
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(() => {
    child.kill('SIGTERM');
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('companion did not start')), 5_000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`companion exited before start (${code})`)));
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('listening')) return;
      clearTimeout(timer);
      resolve();
    });
  });

  let sessionId;
  const request = (body, options = {}) => fetch(`http://127.0.0.1:${port}${options.path ?? '/mcp'}`, {
    method: options.method ?? 'POST',
    headers: {
      ...(options.authorized === false ? {} : { Authorization: `Bearer ${token}` }),
      ...(options.contentType === false ? {} : { 'Content-Type': 'application/json' }),
      ...(options.accept === false ? {} : { Accept: 'application/json, text/event-stream' }),
      ...(options.protocol === false ? {} : options.protocol ? { 'MCP-Protocol-Version': options.protocol } : {}),
      ...(options.session === false ? {} : options.session ? { 'Mcp-Session-Id': options.session } : sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      ...options.headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: options.signal,
  });

  const initializeSession = async (makeDefault = false, clientName = 'test') => {
    const initialized = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: clientName, version: '1' } },
    }, { session: false });
    assert.equal(initialized.status, 200);
    const createdSessionId = initialized.headers.get('mcp-session-id');
    assert.ok(createdSessionId, 'initialize must issue a bounded client-scoped session');
    const envelope = await initialized.json();
    assert.equal(envelope.result.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(envelope.result.serverInfo, { name: 'task-manager-companion', version: PACKAGE_VERSION });
    const notification = await request(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { protocol: PROTOCOL_VERSION, session: createdSessionId },
    );
    assert.equal(notification.status, 202);
    assert.equal(await notification.text(), '');
    if (makeDefault) sessionId = createdSessionId;
    return createdSessionId;
  };
  const initialize = () => initializeSession(true);

  return { child, directory, port, token, request, initialize, initializeSession, sessionId: () => sessionId };
}

void test('MCP companion implements client-scoped Streamable HTTP lifecycle and never caches completed query results', async (context) => {
  const countFile = path.join(tmpdir(), `task-manager-mcp-count-${process.pid}-${Date.now()}.txt`);
  context.after(() => rmSync(countFile, { force: true }));
  const companion = await startCompanion(context, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const countFile = ${JSON.stringify(countFile)};
const run = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) + 1 : 1;
writeFileSync(countFile, String(run));
console.log(JSON.stringify({ success: true, data: { tasks: [], count: 0, run } }));
`);

  const health = await companion.request(undefined, { path: '/mcp/health', method: 'GET', authorized: false, contentType: false, accept: false });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const unsupportedMethod = await companion.request(undefined, { method: 'PATCH', contentType: false, accept: false });
  assert.equal(unsupportedMethod.status, 405);
  assert.equal(unsupportedMethod.headers.get('allow'), 'POST');
  for (const method of ['GET', 'DELETE']) {
    const response = await companion.request(undefined, { method, contentType: false, accept: false, protocol: '2025-03-26' });
    assert.equal(response.status, 400, `${method} must reject an unsupported protocol version before method handling`);
  }
  assert.equal((await companion.request({}, { path: '/wrong' })).status, 404);
  assert.equal((await companion.request({}, { authorized: false })).status, 401);
  assert.equal((await companion.request({}, { contentType: false })).status, 415);
  assert.equal((await companion.request({}, { headers: { 'Content-Type': 'application/json-foo' } })).status, 415);
  assert.equal((await companion.request({}, { accept: false })).status, 406);

  const initializeNotification = await companion.request({
    jsonrpc: '2.0',
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'invalid-notification', version: '1' } },
  });
  assert.equal(initializeNotification.status, 400);
  assert.equal((await initializeNotification.json()).error.code, -32600);
  const healthAfterInvalid = await companion.request(undefined, { path: '/mcp/health', method: 'GET', authorized: false, contentType: false, accept: false });
  assert.equal(healthAfterInvalid.status, 200, 'invalid initialize notifications must not terminate the companion');

  const malformedInitialize = await companion.request({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION },
  });
  assert.equal((await malformedInitialize.json()).error.code, -32602);

  await companion.initialize();

  const getResponse = await companion.request(undefined, { method: 'GET', contentType: false, accept: false, protocol: PROTOCOL_VERSION });
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get('allow'), 'POST, DELETE');
  assert.equal((await companion.request(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { protocol: PROTOCOL_VERSION, session: false },
  )).status, 400);
  assert.equal((await companion.request(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { protocol: PROTOCOL_VERSION, session: 'unknown-session' },
  )).status, 404);

  assert.equal((await companion.request(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { protocol: false },
  )).status, 400);
  assert.equal((await companion.request(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { protocol: '2025-03-26' },
  )).status, 400);

  const listedResponse = await companion.request(
    { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
    { protocol: PROTOCOL_VERSION },
  );
  assert.equal(listedResponse.status, 200);
  const listed = await listedResponse.json();
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['query_tasks', 'search_tasks']);

  const acceptedResponse = await companion.request(
    { jsonrpc: '2.0', id: 99, result: {} },
    { protocol: PROTOCOL_VERSION },
  );
  assert.equal(acceptedResponse.status, 202);
  assert.equal(await acceptedResponse.text(), '');
  const notification = await companion.request(
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'test', progress: 1 } },
    { protocol: PROTOCOL_VERSION },
  );
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');

  const queryRequest = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'query_tasks', arguments: { query: 'not done' } } };
  const queried = await companion.request(queryRequest, { protocol: PROTOCOL_VERSION });
  assert.equal((await queried.json()).result.data.run, 1);
  const refreshed = await companion.request(queryRequest, { protocol: PROTOCOL_VERSION });
  assert.equal((await refreshed.json()).result.data.run, 2, 'completed query responses must not outlive the vault revision that produced them');

  const parseError = await companion.request('{', { protocol: PROTOCOL_VERSION });
  assert.equal(parseError.status, 400);
  assert.equal((await parseError.json()).error.code, -32700);
  const invalid = await companion.request({ jsonrpc: '2.0', id: null, method: 'tools/list' }, { protocol: PROTOCOL_VERSION });
  assert.equal((await invalid.json()).error.code, -32600);

  const deleted = await companion.request(undefined, { method: 'DELETE', contentType: false, accept: false, protocol: PROTOCOL_VERSION });
  assert.equal(deleted.status, 204);
  const afterDelete = await companion.request(
    { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
    { protocol: PROTOCOL_VERSION },
  );
  assert.equal(afterDelete.status, 404);
});

void test('MCP companion coalesces only exact simultaneous requests within one session', async (context) => {
  const countFile = path.join(tmpdir(), `task-manager-mcp-coalescing-${process.pid}-${Date.now()}.txt`);
  context.after(() => rmSync(countFile, { force: true }));
  const companion = await startCompanion(context, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(countFile)}, '1\\n');
const encoded = process.argv[process.argv.indexOf('--query64') + 1];
const query = Buffer.from(encoded, 'base64url').toString('utf8');
await new Promise((resolve) => setTimeout(resolve, 200));
console.log(JSON.stringify({ success: true, data: { query } }));
`);
  await companion.initialize();
  const secondSession = await companion.initializeSession(false, 'second-client');
  const spawnCount = () => existsSync(countFile)
    ? readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length
    : 0;
  const call = (body, session) => companion.request(body, {
    protocol: PROTOCOL_VERSION,
    ...(session ? { session } : {}),
  });
  const exact = { jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'query_tasks', arguments: { query: 'same' } } };

  const exactResults = await Promise.all([call(exact), call(exact)]);
  assert.equal(spawnCount(), 1, 'simultaneous byte-identical requests in one session share one child');
  for (const response of exactResults) assert.equal((await response.json()).result.data.query, 'same');

  assert.equal((await (await call(exact)).json()).result.data.query, 'same');
  assert.equal(spawnCount(), 2, 'a completed repeat must spawn again');

  await Promise.all([
    call({ ...exact, id: 51 }),
    call({ ...exact, id: 52 }),
  ]);
  assert.equal(spawnCount(), 4, 'different JSON-RPC ids are different request bytes');

  await Promise.all([
    call({ ...exact, id: 53, params: { name: 'query_tasks', arguments: { query: 'left' } } }),
    call({ ...exact, id: 53, params: { name: 'query_tasks', arguments: { query: 'right' } } }),
  ]);
  assert.equal(spawnCount(), 6, 'different arguments must not coalesce');

  await Promise.all([call(exact), call(exact, secondSession)]);
  assert.equal(spawnCount(), 8, 'identical bytes in different sessions spawn independently');

  const cancellable = { ...exact, id: 77, params: { name: 'query_tasks', arguments: { query: 'cancel one waiter' } } };
  const first = call(cancellable);
  const second = call(cancellable);
  await waitFor(() => spawnCount() === 9);
  const cancellation = await companion.request(
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 77 } },
    { protocol: PROTOCOL_VERSION },
  );
  assert.equal(cancellation.status, 202);
  const envelopes = await Promise.all([first, second].map(async (pending) => (await pending).json()));
  assert.equal(envelopes.filter((envelope) => envelope.error?.code === -32800).length, 1);
  assert.equal(envelopes.filter((envelope) => envelope.result?.data?.query === 'cancel one waiter').length, 1);
  assert.equal(spawnCount(), 9, 'one waiter cancellation must not kill shared work needed by another waiter');
});

void test('MCP companion caps active children and rejects work beyond its pending bound', async (context) => {
  const companion = await startCompanion(context, `
const encoded = process.argv[process.argv.indexOf('--query64') + 1];
const query = Buffer.from(encoded, 'base64url').toString('utf8');
const startedAt = Date.now();
await new Promise((resolve) => setTimeout(resolve, 200));
console.log(JSON.stringify({ success: true, data: { query, startedAt, endedAt: Date.now() } }));
`, {
    OBSIDIAN_TASK_MANAGER_MCP_MAX_CONCURRENT: '2',
    OBSIDIAN_TASK_MANAGER_MCP_MAX_PENDING: '4',
  });
  await companion.initialize();

  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => companion.request({
    jsonrpc: '2.0',
    id: index + 10,
    method: 'tools/call',
    params: { name: 'query_tasks', arguments: { query: `task ${index}` } },
  }, { protocol: PROTOCOL_VERSION })));
  const overloaded = responses.filter((response) => response.status === 503);
  assert.ok(overloaded.length >= 2, 'requests beyond the global pending cap must fail promptly');
  const intervals = [];
  for (const response of responses.filter((candidate) => candidate.status === 200)) {
    const envelope = await response.json();
    if (envelope.result?.data) intervals.push(envelope.result.data);
  }
  assert.ok(intervals.length <= 4);
  const points = intervals.flatMap((interval) => [
    { at: interval.startedAt, delta: 1 },
    { at: interval.endedAt, delta: -1 },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  assert.ok(maximum <= 2, `at most two CLI children may overlap (observed ${maximum})`);
});

void test('MCP companion does not treat HTTP disconnect as cancellation', async (context) => {
  const markerBase = path.join(tmpdir(), `task-manager-mcp-disconnect-${process.pid}-${Date.now()}`);
  const startedMarker = `${markerBase}-started`;
  const completedMarker = `${markerBase}-completed`;
  context.after(() => {
    rmSync(startedMarker, { force: true });
    rmSync(completedMarker, { force: true });
  });
  const companion = await startCompanion(context, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(startedMarker)}, 'started');
await new Promise((resolve) => setTimeout(resolve, 250));
writeFileSync(${JSON.stringify(completedMarker)}, 'completed');
console.log(JSON.stringify({ success: true, data: { completed: true } }));
`);
  await companion.initialize();
  const controller = new AbortController();
  const request = companion.request({
    jsonrpc: '2.0',
    id: 19,
    method: 'tools/call',
    params: { name: 'query_tasks', arguments: { query: 'disconnect' } },
  }, { protocol: PROTOCOL_VERSION, signal: controller.signal });
  await waitFor(() => existsSync(startedMarker));
  controller.abort();
  await assert.rejects(request, /abort/iu);
  await waitFor(() => existsSync(completedMarker));
  assert.equal(existsSync(completedMarker), true, 'transport disconnect must not cancel accepted server work');
});

void test('MCP companion bounds CLI output and escalates timed-out children before releasing capacity', async (context) => {
  const companion = await startCompanion(context, `
const encoded = process.argv[process.argv.indexOf('--query64') + 1];
const query = Buffer.from(encoded, 'base64url').toString('utf8');
if (query === 'overflow') {
  process.stdout.write('x'.repeat(2048));
} else if (query === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (query === 'descendant') {
  const { spawn } = await import('node:child_process');
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
  descendant.unref();
} else {
  console.log(JSON.stringify({ success: true, data: { query } }));
}
`, {
    OBSIDIAN_TASK_MANAGER_MCP_MAX_CONCURRENT: '1',
    OBSIDIAN_TASK_MANAGER_MCP_MAX_PENDING: '4',
    OBSIDIAN_TASK_MANAGER_MCP_MAX_OUTPUT_BYTES: '1024',
    OBSIDIAN_TASK_MANAGER_MCP_CHILD_TIMEOUT_MS: '1000',
    OBSIDIAN_TASK_MANAGER_MCP_KILL_GRACE_MS: '100',
    OBSIDIAN_TASK_MANAGER_MCP_REQUEST_TIMEOUT_MS: '4000',
  });
  await companion.initialize();
  const call = (id, query, session) => companion.request({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'query_tasks', arguments: { query } },
  }, { protocol: PROTOCOL_VERSION, ...(session ? { session } : {}) });

  const overflow = await call(20, 'overflow');
  const overflowEnvelope = await overflow.json();
  assert.equal(overflowEnvelope.error.code, -32603);
  assert.match(overflowEnvelope.error.message, /stdout exceeded 1024 bytes/u);

  const secondSession = await companion.initializeSession(false, 'second-client');
  const hungPromise = call(21, 'hang');
  const recoveredPromise = call(21, 'healthy', secondSession);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancellation = await companion.request(
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 21, reason: 'test' } },
    { protocol: PROTOCOL_VERSION },
  );
  assert.equal(cancellation.status, 202);
  const [hung, recovered] = await Promise.all([hungPromise, recoveredPromise]);
  const hungEnvelope = await hung.json();
  const recoveredEnvelope = await recovered.json();
  assert.equal(hungEnvelope.error.code, -32800);
  assert.match(hungEnvelope.error.message, /cancelled/iu);
  assert.equal(recoveredEnvelope.result.data.query, 'healthy', 'cancellation must not cross session boundaries when request IDs collide');

  const blockingPromise = call(30, 'hang');
  const queuedPromise = call(31, 'queued');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelQueued = await companion.request(
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 31 } },
    { protocol: PROTOCOL_VERSION },
  );
  assert.equal(cancelQueued.status, 202);
  const queuedEnvelope = await (await queuedPromise).json();
  assert.equal(queuedEnvelope.error.code, -32800);
  const cancelBlocking = await companion.request(
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 30 } },
    { protocol: PROTOCOL_VERSION },
  );
  assert.equal(cancelBlocking.status, 202);
  assert.equal((await (await blockingPromise).json()).error.code, -32800);

  const started = Date.now();
  const [descendant, afterDescendant] = await Promise.all([call(23, 'descendant'), call(24, 'after descendant')]);
  const descendantEnvelope = await descendant.json();
  const afterDescendantEnvelope = await afterDescendant.json();
  assert.equal(descendantEnvelope.error.code, -32603);
  assert.match(descendantEnvelope.error.message, /exceeded 1000 ms/u);
  assert.equal(afterDescendantEnvelope.result.data.query, 'after descendant');
  assert.ok(Date.now() - started < 2500, 'inherited descendant pipes must not occupy the only slot indefinitely');
});
