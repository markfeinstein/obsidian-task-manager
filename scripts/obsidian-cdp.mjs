import { readFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const disabledFeatures = Object.freeze([
  'enableReminderNotifications', 'todoistSyncEnabled', 'caldavSyncEnabled',
  'googleTasksEnabled', 'googleCalendarEnabled', 'msToDoEnabled',
  'appleRemindersEnabled', 'appleRemindersWebhookEnabled', 'aiQueryEnabled',
]);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(read, label, timeoutMs = 12_000) {
  const until = Date.now() + timeoutMs;
  do {
    if (await read()) return;
    await delay(100);
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${label}; inspect before repeating any mutation.`);
}

export async function canonical(file, directory = false) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || await realpath(file) !== file) throw new Error('Noncanonical smoke path.');
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unexpected smoke path type.');
  return file;
}
export function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export async function validateSession(file, { initial = false } = {}) {
  await canonical(file);
  const session = JSON.parse(await readFile(file, 'utf8'));
  if (session.schemaVersion !== 1 || typeof session.nonce !== 'string' || !/^\d+\.\d+\.\d+$/u.test(session.version)) throw new Error('Invalid smoke session.');
  for (const key of ['folder', 'vault', 'profile']) await canonical(session[key], true);
  if (!contained(session.folder, session.vault) || !contained(session.folder, session.profile) || contained(session.vault, session.profile) || contained(session.profile, session.vault) || session.vault === session.profile || path.dirname(file) !== session.folder) throw new Error('Overlapping or escaped smoke paths.');
  await canonical(session.binary);
  const markerPath = path.join(session.vault, '.task-manager-smoke.json');
  await canonical(markerPath);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (marker.nonce !== session.nonce || marker.vault !== session.vault || marker.syntheticOnly !== true) throw new Error('Synthetic-vault marker mismatch.');
  if (initial) {
    for (const [name, hash] of Object.entries(session.fixtureHashes ?? {})) {
      if (path.basename(name) !== name) throw new Error('Unsafe fixture filename.');
      const note = path.join(session.vault, name);
      await canonical(note);
      if (digest(await readFile(note)) !== hash) throw new Error(`Initial synthetic note changed: ${name}`);
    }
    if (Object.keys(session.fixtureHashes ?? {}).length !== 7) throw new Error('Missing initial fixture inventory.');
  }
  for (const suffix of ['.obsidian', '.obsidian/plugins', '.obsidian/plugins/task-manager']) await canonical(path.join(session.vault, suffix), true);
  if (Object.keys(session.pluginHashes ?? {}).sort().join(',') !== 'main.js,manifest.json,styles.css,versions.json') throw new Error('Expected exactly four plugin artifacts.');
  for (const [name, hash] of Object.entries(session.pluginHashes)) {
    const artifact = path.join(session.vault, '.obsidian/plugins/task-manager', name);
    await canonical(artifact);
    if (digest(await readFile(artifact)) !== hash) throw new Error(`Prepared plugin artifact changed: ${name}`);
  }
  const settingsPath = path.join(session.vault, '.obsidian/plugins/task-manager/data.json');
  await canonical(settingsPath);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')).settings;
  if (!settings || disabledFeatures.some(key => settings[key] !== false)) throw new Error('Unsafe smoke feature settings.');
  const registrationPath = path.join(session.profile, 'obsidian.json');
  await canonical(registrationPath);
  const registration = JSON.parse(await readFile(registrationPath, 'utf8'));
  if (registration.updateDisabled !== true || Object.keys(registration.vaults ?? {}).length !== 1 || registration.vaults[session.vaultId]?.path !== session.vault) throw new Error('Unexpected vault registration or enabled automatic updates.');
  return session;
}
export function debuggerPort(text) {
  const line = text.split('\n')[0];
  const port = Number(line);
  if (!/^\d+$/u.test(line) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid isolated debugger port.');
  return port;
}
export function debuggerTarget(targets, port, { settings = false, vault, targetId } = {}) {
  if (!Array.isArray(targets)) throw new Error('Invalid debugger target list.');
  const candidates = targets.filter(target => target.type === 'page' && (settings
    ? target.url === 'about:blank' && target.title.startsWith(`Settings - ${path.basename(vault)} - Obsidian `)
    : target.url === 'app://obsidian.md/index.html' && (!targetId || target.id === targetId)));
  if (candidates.length !== 1) throw new Error(`Expected one owned ${settings ? 'Settings' : 'main'} target; found ${candidates.length}.`);
  const target = candidates[0];
  const socket = new URL(target.webSocketDebuggerUrl);
  if (socket.protocol !== 'ws:' || socket.hostname !== '127.0.0.1' || socket.port !== String(port) || socket.username || socket.password || socket.search || socket.hash || socket.pathname !== `/devtools/page/${target.id}`) throw new Error('Debugger target escaped the exact loopback endpoint or target.');
  return target;
}
export function identityGuard(session, needVault = true) {
  if (!Number.isSafeInteger(session.pid) || session.pid < 1) throw new Error('Missing exact owned PID.');
  return `const remote=require('@electron/remote');if(remote.app.getPath('userData')!==${JSON.stringify(session.profile)}||remote.app.getPath('exe')!==${JSON.stringify(session.binary)}||remote.process.pid!==${session.pid})throw Error('Smoke profile/executable/PID mismatch');${needVault ? `if(app.vault.adapter.getBasePath()!==${JSON.stringify(session.vault)})throw Error('Smoke vault mismatch');` : ''}`;
}

/** No CLI, external endpoints, arbitrary target selection, or automatic mutation retries. */
export async function connectObsidian(session, { settings = false, targetId } = {}) {
  const main = settings ? await connectObsidian(session, { targetId }) : null;
  let socket;
  const pending = new Map();
  const diagnostics = [];
  let sequence = 0;
  function rejectPending() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Owned debugger closed; inspect before repeating mutations.')); }
    pending.clear();
  }
  try {
    const portFile = path.join(session.profile, 'DevToolsActivePort');
    await canonical(portFile);
    const port = debuggerPort(await readFile(portFile, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Could not discover owned debugger targets.');
    const target = debuggerTarget(await response.json(), port, { settings, vault: session.vault, targetId });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.addEventListener('close', rejectPending);
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); }
      catch { socket.close(); rejectPending(); return; }
      if (!message.id) {
        if (diagnostics.length < 100 && ['Runtime.exceptionThrown', 'Inspector.targetCrashed'].includes(message.method)) diagnostics.push(message);
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Owned debugger connection timeout.')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('Owned debugger connection failed.')); }, { once: true });
    });
    function request(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Owned debugger is not open.')); return; }
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; outcome may be unknown. Do not repeat a mutation automatically.`)); }, 12_000);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    }
    async function evaluate(expression, needVault = true) {
      if (main) await main.evaluate('true');
      const guard = settings ? `if(document.title!==${JSON.stringify(target.title)})throw Error('Owned Settings document changed');` : identityGuard(session, needVault);
      const result = await request('Runtime.evaluate', { expression: `(()=>{${guard}return (${expression});})()`, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 10_000 });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    }
    await evaluate('true', false);
    return {
      evaluate, diagnostics, targetId: target.id,
      async send(method, params) { await evaluate('true'); return request(method, params); },
      close() { socket.close(); rejectPending(); main?.close(); },
    };
  } catch (error) { socket?.close(); main?.close(); throw error; }
}

export async function settingsSurface(session, main) {
  const until = Date.now() + 10_000;
  do {
    await main.evaluate('true');
    const port = debuggerPort(await readFile(path.join(session.profile, 'DevToolsActivePort'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Could not inspect owned Settings targets.');
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error('Invalid Settings target list.');
    const native = targets.some(target => target.type === 'page' && target.url === 'about:blank' && target.title.startsWith(`Settings - ${path.basename(session.vault)} - Obsidian `));
    if (native) return connectObsidian(session, { settings: true, targetId: main.targetId });
    if (await main.evaluate('Boolean(document.querySelector(".task-manager-settings"))')) return { evaluate: expression => main.evaluate(expression), close() {} };
    await delay(100);
  } while (Date.now() < until);
  throw new Error('Owned Settings surface did not appear.');
}
