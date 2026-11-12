#!/usr/bin/env node
/**
 * Desktop-only, read-only MCP Streamable HTTP companion.
 *
 * The mobile-safe plugin does not embed Node's HTTP server. This companion
 * forwards query requests to the plugin's Obsidian CLI handler and intentionally
 * exposes no mutation tools. Client-scoped sessions bound cancellation IDs and lifecycle state.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const COMPANION_VERSION = '0.1.0';
const port = Number(process.env.OBSIDIAN_TASK_MANAGER_MCP_PORT || 7777);
const token = process.env.OBSIDIAN_TASK_MANAGER_TOKEN || '';
const obsidianCli = process.env.OBSIDIAN_CLI || 'obsidian';

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    console.error(`${name} must be an integer from ${minimum} through ${maximum}.`);
    process.exit(1);
  }
  return value;
}

const maxConcurrentQueries = boundedInteger('OBSIDIAN_TASK_MANAGER_MCP_MAX_CONCURRENT', 4, 1, 32);
const maxPendingRequests = boundedInteger('OBSIDIAN_TASK_MANAGER_MCP_MAX_PENDING', 32, 1, 256);
const maxOutputBytes = boundedInteger('OBSIDIAN_TASK_MANAGER_MCP_MAX_OUTPUT_BYTES', 5 * 1024 * 1024, 1024, 32 * 1024 * 1024);
const maxRequestBytes = boundedInteger('OBSIDIAN_TASK_MANAGER_MCP_MAX_REQUEST_BYTES', 1024 * 1024, 1024, 8 * 1024 * 1024);
const childTimeoutMs = boundedInteger('OBSIDIAN_TASK_MANAGER_MCP_CHILD_TIMEOUT_MS', 30_000, 1000, 300_000);
const requestTimeoutMs = boundedInteger('OBSIDIAN_TASK_MANAGER_MCP_REQUEST_TIMEOUT_MS', 35_000, 1000, 310_000);
const killGraceMs = boundedInteger('OBSIDIAN_TASK_MANAGER_MCP_KILL_GRACE_MS', 2_000, 100, 30_000);
const maxSessions = boundedInteger('OBSIDIAN_TASK_MANAGER_MCP_MAX_SESSIONS', 64, 1, 1024);
const sessionTtlMs = boundedInteger('OBSIDIAN_TASK_MANAGER_MCP_SESSION_TTL_MS', 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);

if (!token || !Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('Set OBSIDIAN_TASK_MANAGER_TOKEN and a valid OBSIDIAN_TASK_MANAGER_MCP_PORT.');
  process.exit(1);
}

const tools = [
  { name: 'query_tasks', description: 'Run Task Manager query DSL.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'search_tasks', description: 'Search task descriptions.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
];

function rpcError(message, code) {
  return Object.assign(new Error(message), { code });
}

function authorized(header = '') {
  const supplied = header.match(/^Bearer\s+(.+)$/iu)?.[1] || '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function acceptsJsonAndEventStream(header = '') {
  const mediaTypes = header.split(',').map((part) => part.split(';', 1)[0]?.trim().toLowerCase());
  return mediaTypes.includes('application/json') && mediaTypes.includes('text/event-stream');
}

function writeJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}

let activeQueries = 0;
const queryWaiters = [];
const childProcesses = new Set();

function acquireQuerySlot(signal) {
  if (signal.aborted) return Promise.reject(rpcError('Request cancelled', -32800));
  if (activeQueries < maxConcurrentQueries) {
    activeQueries += 1;
    return Promise.resolve();
  }
  if (queryWaiters.length >= maxPendingRequests) {
    return Promise.reject(rpcError('Server busy: query queue is full', -32000));
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: undefined };
    waiter.onAbort = () => {
      const index = queryWaiters.indexOf(waiter);
      if (index >= 0) queryWaiters.splice(index, 1);
      reject(rpcError('Request cancelled', -32800));
    };
    signal.addEventListener('abort', waiter.onAbort, { once: true });
    queryWaiters.push(waiter);
  });
}

function releaseQuerySlot() {
  while (queryWaiters.length > 0) {
    const waiter = queryWaiters.shift();
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (waiter.signal.aborted) {
      waiter.reject(rpcError('Request cancelled', -32800));
      continue;
    }
    waiter.resolve();
    return;
  }
  activeQueries = Math.max(0, activeQueries - 1);
}

function signalChildTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group already ended or was never created.
    }
  }
  if (process.platform === 'win32' && signal === 'SIGKILL' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => undefined);
    killer.unref();
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function stopChild(child) {
  signalChildTree(child, 'SIGTERM');
  const escalation = setTimeout(() => signalChildTree(child, 'SIGKILL'), killGraceMs);
  escalation.unref();
  return escalation;
}

async function runQuery(query, signal) {
  await acquireQuerySlot(signal);
  try {
    return await new Promise((resolve, reject) => {
      const encoded = Buffer.from(query, 'utf8').toString('base64url');
      const child = spawn(obsidianCli, ['task-manager:query', '--query64', encoded, '--format', 'json'], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      childProcesses.add(child);
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalError;
      let escalation;
      let forceSettle;
      let settled = false;

      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (escalation !== undefined) clearTimeout(escalation);
        if (forceSettle !== undefined) clearTimeout(forceSettle);
        signal.removeEventListener('abort', onAbort);
        childProcesses.delete(child);
        if (terminalError) {
          reject(terminalError);
          return;
        }
        const errorText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          reject(new Error(errorText || `Obsidian CLI exited ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString('utf8').trim()));
        } catch {
          reject(new Error('Obsidian CLI returned invalid JSON'));
        }
      };
      const requestStop = (error) => {
        terminalError ??= error;
        if (escalation !== undefined) return;
        signalChildTree(child, 'SIGTERM');
        escalation = setTimeout(() => {
          signalChildTree(child, 'SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
          forceSettle = setTimeout(() => finish(child.exitCode), 25);
          forceSettle.unref();
        }, killGraceMs);
        escalation.unref();
      };
      const timeout = setTimeout(() => requestStop(new Error(`Obsidian CLI exceeded ${childTimeoutMs} ms`)), childTimeoutMs);
      timeout.unref();
      const onAbort = () => requestStop(rpcError('Request cancelled', -32800));
      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes > maxOutputBytes) {
          requestStop(new Error(`Obsidian CLI stdout exceeded ${maxOutputBytes} bytes`));
          return;
        }
        stdout.push(bytes);
      });
      child.stderr.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += bytes.length;
        if (stderrBytes > maxOutputBytes) {
          requestStop(new Error(`Obsidian CLI stderr exceeded ${maxOutputBytes} bytes`));
          return;
        }
        stderr.push(bytes);
      });
      child.on('error', (error) => {
        terminalError ??= error;
        finish(child.exitCode);
      });
      child.on('close', (code) => finish(code));
    });
  } finally {
    releaseQuerySlot();
  }
}

async function dispatch(rpc, signal) {
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.jsonrpc !== '2.0'
    || !Object.prototype.hasOwnProperty.call(rpc, 'id') || rpc.id === null
    || (typeof rpc.id !== 'string' && !Number.isInteger(rpc.id)) || typeof rpc.method !== 'string') {
    throw rpcError('Invalid Request', -32600);
  }
  if (rpc.method === 'initialize') {
    const params = rpc.params;
    const clientInfo = params && typeof params === 'object' && !Array.isArray(params) ? params.clientInfo : undefined;
    const capabilities = params && typeof params === 'object' && !Array.isArray(params) ? params.capabilities : undefined;
    if (!params || typeof params !== 'object' || Array.isArray(params) || typeof params.protocolVersion !== 'string'
      || !capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
      || !clientInfo || typeof clientInfo !== 'object' || Array.isArray(clientInfo)
      || typeof clientInfo.name !== 'string' || !clientInfo.name
      || typeof clientInfo.version !== 'string' || !clientInfo.version) {
      throw rpcError('initialize requires protocolVersion, capabilities, and clientInfo name/version', -32602);
    }
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'task-manager-companion', version: COMPANION_VERSION },
    };
  }
  if (rpc.method === 'ping') return {};
  if (rpc.method === 'tools/list') return { tools };
  if (rpc.method !== 'tools/call' || !rpc.params || typeof rpc.params !== 'object' || Array.isArray(rpc.params) || typeof rpc.params.name !== 'string') {
    throw rpcError('Method not found', -32601);
  }
  const args = rpc.params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 100_000) {
    throw rpcError('Tool arguments require a non-empty query of at most 100000 characters', -32602);
  }
  let query;
  if (rpc.params.name === 'query_tasks') query = args.query;
  else if (rpc.params.name === 'search_tasks') query = `description includes ${JSON.stringify(args.query)}`;
  else throw rpcError('Unknown or write-capable tool; this companion is read-only', -32602);
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit <= 0 || args.limit > 100_000) throw rpcError('limit must be an integer from 1 through 100000', -32602);
    query += `\nlimit ${args.limit}`;
  }
  const result = await runQuery(query, signal);
  return { ...result, content: [{ type: 'text', text: JSON.stringify(result) }] };
}

let activeRequests = 0;
const sessions = new Map();
const activeRpcRequests = new Map();
/** Exact, session-scoped work shared only while the CLI request is in flight. */
const inFlightRequests = new Map();

function rpcIdKey(sessionId, id) {
  return `${sessionId}\0${typeof id}:${String(id)}`;
}

function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const controller of session.controllers) controller.abort();
  sessions.delete(sessionId);
}

function pruneSessions() {
  const cutoff = Date.now() - sessionTtlMs;
  for (const [sessionId, session] of sessions) {
    if (session.lastSeen < cutoff && session.controllers.size === 0) closeSession(sessionId);
  }
}

function createSession() {
  pruneSessions();
  if (sessions.size >= maxSessions) return undefined;
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { initialized: false, lastSeen: Date.now(), controllers: new Set() });
  return sessionId;
}

function getSession(sessionId) {
  pruneSessions();
  if (!sessionId || typeof sessionId !== 'string') return undefined;
  const session = sessions.get(sessionId);
  if (session) session.lastSeen = Date.now();
  return session;
}

function registerRpcRequest(sessionId, id, controller) {
  const key = rpcIdKey(sessionId, id);
  const controllers = activeRpcRequests.get(key) ?? new Set();
  controllers.add(controller);
  activeRpcRequests.set(key, controllers);
  sessions.get(sessionId)?.controllers.add(controller);
}

function unregisterRpcRequest(sessionId, id, controller) {
  const key = rpcIdKey(sessionId, id);
  const controllers = activeRpcRequests.get(key);
  if (controllers) {
    controllers.delete(controller);
    if (controllers.size === 0) activeRpcRequests.delete(key);
  }
  sessions.get(sessionId)?.controllers.delete(controller);
}

function cancelRpcRequest(sessionId, id) {
  const key = rpcIdKey(sessionId, id);
  const controllers = activeRpcRequests.get(key);
  const controller = controllers?.values().next().value;
  if (!controller) return;
  // Duplicate byte-identical requests are separate waiters. One cancellation
  // notification detaches one waiter; repeated notifications can cancel more.
  controllers.delete(controller);
  if (controllers.size === 0) activeRpcRequests.delete(key);
  sessions.get(sessionId)?.controllers.delete(controller);
  controller.abort();
}

function inFlightRequestKey(sessionId, rawBody) {
  return `${sessionId}\0${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

function settleInFlightEntry(entry, error, result) {
  if (entry.settled) return;
  entry.settled = true;
  if (inFlightRequests.get(entry.key) === entry) inFlightRequests.delete(entry.key);
  for (const waiter of [...entry.waiters]) {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    entry.waiters.delete(waiter);
    if (waiter.settled) continue;
    waiter.settled = true;
    if (error) waiter.reject(error);
    else waiter.resolve(result);
  }
}

function detachInFlightWaiter(entry, waiter) {
  if (waiter.settled) return;
  waiter.settled = true;
  waiter.signal.removeEventListener('abort', waiter.onAbort);
  entry.waiters.delete(waiter);
  waiter.reject(rpcError('Request cancelled', -32800));
  if (!entry.settled && entry.waiters.size === 0) entry.controller.abort();
}

function dispatchCoalesced(sessionId, rawBody, rpc, signal) {
  if (signal.aborted) return Promise.reject(rpcError('Request cancelled', -32800));
  const key = inFlightRequestKey(sessionId, rawBody);
  let entry = inFlightRequests.get(key);
  let created = false;
  if (!entry) {
    created = true;
    entry = {
      key,
      controller: new AbortController(),
      waiters: new Set(),
      settled: false,
      promise: undefined,
    };
    inFlightRequests.set(key, entry);
  }
  const result = new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: undefined, settled: false };
    waiter.onAbort = () => detachInFlightWaiter(entry, waiter);
    entry.waiters.add(waiter);
    signal.addEventListener('abort', waiter.onAbort, { once: true });
  });
  if (created) {
    entry.promise = dispatch(rpc, entry.controller.signal).then(
      (value) => settleInFlightEntry(entry, undefined, value),
      (error) => settleInFlightEntry(entry, error),
    );
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(origin)) {
    writeJson(res, 403, { error: 'Forbidden origin' });
    return;
  }

  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && requestUrl.pathname === '/mcp/health') {
    writeJson(res, 200, { status: 'ok' });
    return;
  }
  if (requestUrl.pathname !== '/mcp' || requestUrl.search) {
    writeJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!authorized(req.headers.authorization)) {
    writeJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    return;
  }
  if (req.method === 'GET' || req.method === 'DELETE') {
    const suppliedVersion = req.headers['mcp-protocol-version'];
    if (suppliedVersion !== MCP_PROTOCOL_VERSION) {
      writeJson(res, 400, { error: `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}` });
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') {
      writeJson(res, 400, { error: 'Mcp-Session-Id is required' });
      return;
    }
    if (!getSession(sessionId)) {
      writeJson(res, 404, { error: 'MCP session not found; initialize again' });
      return;
    }
    if (req.method === 'DELETE') {
      closeSession(sessionId);
      res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    writeJson(res, 405, { error: 'This companion does not expose an SSE stream.' }, { Allow: 'POST, DELETE' });
    return;
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
    return;
  }
  const requestMediaType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (requestMediaType !== 'application/json') {
    writeJson(res, 415, { error: 'Content-Type must be application/json' });
    return;
  }
  if (!acceptsJsonAndEventStream(String(req.headers.accept ?? ''))) {
    writeJson(res, 406, { error: 'Accept must include application/json and text/event-stream' });
    return;
  }
  if (activeRequests >= maxPendingRequests) {
    writeJson(res, 503, { error: 'Server busy: pending request limit reached' }, { 'Retry-After': '1' });
    return;
  }

  activeRequests += 1;
  let requestFinished = false;
  const finishRequest = () => {
    if (requestFinished) return;
    requestFinished = true;
    activeRequests = Math.max(0, activeRequests - 1);
  };
  res.once('finish', finishRequest);
  res.once('close', finishRequest);
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
    writeJson(res, 413, { error: 'Request too large' });
    return;
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxRequestBytes) {
        writeJson(res, 413, { error: 'Request too large' });
        return;
      }
      chunks.push(bytes);
    }
  } catch {
    if (!res.headersSent) writeJson(res, 400, { error: 'Incomplete request body' });
    return;
  }

  const rawBody = Buffer.concat(chunks);
  let rpc;
  try {
    rpc = JSON.parse(rawBody.toString('utf8'));
  } catch {
    writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.jsonrpc !== '2.0') {
    writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }

  const isInitialize = rpc.method === 'initialize';
  if (isInitialize && !Object.prototype.hasOwnProperty.call(rpc, 'id')) {
    writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'initialize must be a JSON-RPC request with an id' } });
    return;
  }
  if (!isInitialize && req.headers['mcp-protocol-version'] !== MCP_PROTOCOL_VERSION) {
    writeJson(res, 400, { error: `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}` });
    return;
  }
  const suppliedSessionId = req.headers['mcp-session-id'];
  let sessionId;
  let session;
  if (isInitialize) {
    if (suppliedSessionId !== undefined) {
      writeJson(res, 400, { error: 'Initialization must not include Mcp-Session-Id' });
      return;
    }
  } else {
    if (typeof suppliedSessionId !== 'string') {
      writeJson(res, 400, { error: 'Mcp-Session-Id is required' });
      return;
    }
    sessionId = suppliedSessionId;
    session = getSession(sessionId);
    if (!session) {
      writeJson(res, 404, { error: 'MCP session not found; initialize again' });
      return;
    }
  }

  const hasId = Object.prototype.hasOwnProperty.call(rpc, 'id');
  const hasMethod = typeof rpc.method === 'string';
  if (!hasMethod) {
    const isResponse = hasId && rpc.id !== null
      && (typeof rpc.id === 'string' || Number.isInteger(rpc.id))
      && (Object.prototype.hasOwnProperty.call(rpc, 'result') !== Object.prototype.hasOwnProperty.call(rpc, 'error'));
    if (!isResponse) {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    if (!session?.initialized) {
      writeJson(res, 400, { error: 'MCP session has not completed initialization' });
      return;
    }
    writeJson(res, 202, undefined);
    return;
  }
  if (!hasId) {
    if (rpc.method === 'notifications/initialized') {
      session.initialized = true;
    } else if (!session.initialized) {
      writeJson(res, 400, { error: 'notifications/initialized must complete the session lifecycle first' });
      return;
    }
    if (rpc.method === 'notifications/cancelled') {
      const requestId = rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params) ? rpc.params.requestId : undefined;
      if (requestId === null || (typeof requestId !== 'string' && !Number.isInteger(requestId))) {
        writeJson(res, 400, { error: 'notifications/cancelled requires a string or integer requestId' });
        return;
      }
      cancelRpcRequest(sessionId, requestId);
    }
    writeJson(res, 202, undefined);
    return;
  }

  if (!isInitialize && rpc.method !== 'ping' && !session.initialized) {
    writeJson(res, 400, { error: 'MCP session has not completed initialization' });
    return;
  }
  const controller = new AbortController();
  const validRequestId = rpc.id !== null && (typeof rpc.id === 'string' || Number.isInteger(rpc.id));
  if (validRequestId && sessionId) registerRpcRequest(sessionId, rpc.id, controller);
  let envelope;
  try {
    const result = sessionId && rpc.method === 'tools/call'
      ? await dispatchCoalesced(sessionId, rawBody, rpc, controller.signal)
      : await dispatch(rpc, controller.signal);
    envelope = { jsonrpc: '2.0', id: rpc.id, result };
  } catch (error) {
    envelope = {
      jsonrpc: '2.0',
      id: rpc?.id ?? null,
      error: { code: error?.code ?? -32603, message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    if (validRequestId && sessionId) unregisterRpcRequest(sessionId, rpc.id, controller);
  }
  const responseHeaders = { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION };
  if (isInitialize && !envelope.error) {
    const createdSessionId = createSession();
    if (!createdSessionId) {
      envelope = { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'MCP session capacity reached' } };
    } else {
      responseHeaders['Mcp-Session-Id'] = createdSessionId;
    }
  }
  if (!res.writableEnded && !res.destroyed) {
    writeJson(res, 200, envelope, responseHeaders);
  }
});

server.requestTimeout = requestTimeoutMs;
server.headersTimeout = Math.min(requestTimeoutMs, 10_000);
server.keepAliveTimeout = 5_000;
server.on('connection', (socket) => {
  socket.setTimeout(requestTimeoutMs, () => socket.destroy());
});

function shutdown(signal) {
  server.close();
  for (const child of childProcesses) stopChild(child);
  const forcedExit = setTimeout(() => process.exit(0), killGraceMs + 250);
  forcedExit.unref();
  if (childProcesses.size === 0) process.exit(0);
  console.error(`Task Manager MCP companion stopping after ${signal}.`);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

server.listen(port, '127.0.0.1', () => {
  console.log(`Task Manager read-only MCP companion listening on http://127.0.0.1:${port}`);
});
