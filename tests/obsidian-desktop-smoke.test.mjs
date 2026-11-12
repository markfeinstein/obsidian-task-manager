import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { prepare, parseOptions, visibleCount, rowControl } from '../scripts/obsidian-desktop-smoke.mjs';
import { debuggerPort, debuggerTarget, identityGuard, validateSession } from '../scripts/obsidian-cdp.mjs';

const modulePath = path.resolve('scripts/obsidian-desktop-smoke.mjs');

test('desktop smoke runtime is opt-in and rejects ambiguous or unknown CLI options', () => {
  for (const args of [[], ['run'], ['launch', '--session', '/tmp/unknown'], ['quit', '--allow-runtime'], ['run', '--allow-runtime', '--session'], ['run', '--allow-runtime', '--session', '/tmp/x', '--force'], ['run', '--allow-runtime', '--session', '/tmp/x', '--session', '/tmp/y']]) assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(['run', '--allow-runtime', '--session', '/tmp/x']).allowRuntime, true);
  const result = spawnSync(process.execPath, [modulePath, 'run', '--session', '/tmp/does-not-exist'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit --allow-runtime/u);
});

test('desktop smoke counts the visible Reading view rather than hidden Live Preview duplicates', () => {
  const document = { querySelectorAll: () => [{ checkVisibility: () => false }, { checkVisibility: () => true }] };
  assert.equal(vm.runInNewContext(visibleCount('.task-manager-query-stats-bar'), { document }), 1);
});

test('desktop smoke establishes real row hover before locating a hover-only edit control', async () => {
  const events = [];
  const client = {
    async evaluate() { events.push('locate'); return { x: 100, y: 100 }; },
    async send(_method, params) { events.push(params.type); },
  };
  await rowControl(client, 'Synthetic task', '.task-manager-query-edit');
  assert.deepEqual(events, ['locate', 'mouseMoved', 'locate', 'mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('desktop debugger accepts only a strict finite loopback port', () => {
  assert.equal(debuggerPort('43123\n/devtools/browser/test\n'), 43123);
  for (const text of ['', '0', '80', '65536', '1234.5', ' 12345', 'NaN', '1234e1']) assert.throws(() => debuggerPort(text));
});

test('desktop debugger requires a unique owned target and exact credential-free websocket origin', () => {
  const target = { id: 'main', type: 'page', url: 'app://obsidian.md/index.html', title: 'Task Manager Smoke', webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/page/main' };
  assert.equal(debuggerTarget([target], 43123).id, 'main');
  assert.throws(() => debuggerTarget([target, target], 43123));
  assert.throws(() => debuggerTarget([], 43123));
  for (const endpoint of ['ws://localhost:43123/devtools/page/main', 'ws://127.0.0.2:43123/devtools/page/main', 'wss://127.0.0.1:43123/devtools/page/main', 'ws://127.0.0.1:43124/devtools/page/main', 'ws://user:pass@127.0.0.1:43123/devtools/page/main', 'ws://127.0.0.1:43123/other', 'ws://127.0.0.1:43123/devtools/page/main?token=x']) assert.throws(() => debuggerTarget([{ ...target, webSocketDebuggerUrl: endpoint }], 43123));
  assert.throws(() => debuggerTarget([{ ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/page/other' }], 43123));
  const settings = { ...target, id: 'settings', webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/page/settings', url: 'about:blank', title: 'Settings - Task Manager Smoke - Obsidian 1.15.0' };
  assert.equal(debuggerTarget([target, settings], 43123, { settings: true, vault: '/owned/Task Manager Smoke' }).id, 'settings');
  assert.throws(() => debuggerTarget([settings], 43123, { settings: true, vault: '/other/Personal' }));
});

test('every main evaluation guard checks profile executable PID and vault before its body', () => {
  const session = { profile: '/owned/Profile', binary: '/owned/Obsidian', vault: '/owned/Vault', pid: 12345 };
  const evaluate = (overrides = {}, needVault = true) => {
    const actual = { ...session, ...overrides };
    const remote = { process: { pid: actual.pid }, app: { getPath: key => key === 'userData' ? actual.profile : actual.binary } };
    return vm.runInNewContext(`(()=>{${identityGuard(session, needVault)}return true;})()`, { require: () => remote, app: { vault: { adapter: { getBasePath: () => actual.vault } } } });
  };
  assert.equal(evaluate(), true);
  for (const override of [{ profile: '/personal/Profile' }, { binary: '/different/Obsidian' }, { pid: 99999 }, { vault: '/personal/Vault' }]) assert.throws(() => evaluate(override), /mismatch/u);
  assert.equal(evaluate({ vault: '/not-ready' }, false), true);
  assert.throws(() => identityGuard({ ...session, pid: undefined }));
});

test('desktop smoke provenance retains two bounded 18-stage cases without a GA claim', async () => {
  const evidence = JSON.parse(await fs.readFile(new URL('./fixtures/desktop-evidence/desktop-smoke-evidence-2026-11-10.json', import.meta.url), 'utf8'));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.independentAcceptance, false);
  assert.equal(evidence.gaAccepted, false);
  assert.match(evidence.sourceContentIdentity, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(evidence.pluginHashes).sort(), ['main.js', 'manifest.json', 'styles.css', 'versions.json']);
  assert.deepEqual(evidence.cases.map(host => host.version), ['1.11.4', '1.15.0']);
  for (const host of evidence.cases) {
    assert.equal(host.status, 'passed');
    assert.equal(host.stages.length, 18);
    assert.ok(host.stages.every(stage => stage.status === 'passed'));
    assert.ok(Date.parse(host.completedAt) >= Date.parse(host.startedAt));
    assert.match(host.reportSha256, /^[a-f0-9]{64}$/u);
    assert.equal(host.ownedProcessStopped, true);
    assert.equal(host.viewport.mobile, false);
    assert.equal(host.artifacts[0].file, 'bases-rendered.png');
    assert.match(host.artifacts[0].sha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(evidence.retainedPartialCases.length, 3);
  assert.ok(evidence.retainedPartialCases.every(host => host.status === 'partial'));
});

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'task-manager-cdp-test-'));
  context.after(() => fs.rm(root, { recursive: true }));
  const app = path.join(root, 'Obsidian.app');
  const executable = path.join(app, 'Contents/MacOS');
  await fs.mkdir(executable, { recursive: true });
  await fs.writeFile(path.join(executable, 'Obsidian'), 'Non-executable unit fixture; never launch.');
  const prepared = await prepare({ app, version: '1.11.4', parent: root });
  return { file: prepared.session, session: JSON.parse(await fs.readFile(prepared.session, 'utf8')) };
}

test('prepared smoke fixture contains only the exact generated vault and four pinned artifacts', async context => {
  const { file, session } = await fixture(context);
  const validated = await validateSession(file, { initial: true });
  assert.equal(validated.nonce, session.nonce);
  assert.equal(validated.syntheticOnly, true);
  assert.deepEqual(Object.keys(validated.pluginHashes).sort(), ['main.js', 'manifest.json', 'styles.css', 'versions.json']);
  const registration = JSON.parse(await fs.readFile(path.join(session.profile, 'obsidian.json'), 'utf8'));
  assert.equal(registration.updateDisabled, true);
  assert.deepEqual(Object.values(registration.vaults).map(value => value.path), [session.vault]);
});

test('smoke session validation fails closed on changed artifacts enabled providers and symlinks', async context => {
  const { file, session } = await fixture(context);
  const inbox = path.join(session.vault, 'Inbox.md');
  const originalInbox = await fs.readFile(inbox, 'utf8');
  await fs.appendFile(inbox, 'Unexpected pre-existing work.\n');
  await assert.rejects(validateSession(file, { initial: true }), /Initial synthetic note changed/u);
  await fs.writeFile(inbox, originalInbox);
  const dataPath = path.join(session.vault, '.obsidian/plugins/task-manager/data.json');
  const original = await fs.readFile(dataPath, 'utf8');
  const data = JSON.parse(original); data.settings.aiQueryEnabled = true;
  await fs.writeFile(dataPath, JSON.stringify(data));
  await assert.rejects(validateSession(file), /Unsafe smoke feature/u);
  await fs.writeFile(dataPath, original);
  const outside = path.join(session.folder, 'outside.json');
  await fs.writeFile(outside, original); await fs.unlink(dataPath); await fs.symlink(outside, dataPath);
  await assert.rejects(validateSession(file), /Noncanonical/u);
  await fs.unlink(dataPath); await fs.writeFile(dataPath, original);
  await fs.appendFile(path.join(session.vault, '.obsidian/plugins/task-manager/main.js'), '\n// tampered\n');
  await assert.rejects(validateSession(file), /artifact changed/u);
});
