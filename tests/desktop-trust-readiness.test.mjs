import test from 'node:test';
import assert from 'node:assert/strict';
import { trustGeneratedPlugin } from '../scripts/obsidian-desktop-smoke.mjs';

function controllerFixture({ ready = false, ambiguous = false, clickFails = false } = {}) {
  const trace = []; let reads = 0; let clicks = 0;
  const client = {
    async evaluate(expression) {
      if (expression.includes('remote.getCurrentWindow().focus()')) { trace.push('focus'); return true; }
      if (expression === 'activeDocument===document') { trace.push('native-document'); return true; }
      if (expression.includes('trustPrompt:')) {
        trace.push('read-trust'); reads++;
        return { ready, trustPrompt: ambiguous ? 2 : ready || reads === 1 ? 0 : 1 };
      }
      if (expression.includes('buttons[0].click()')) {
        trace.push('trust-once'); clicks++;
        if (clickFails) throw new Error('Unknown click outcome');
        ready = true; return true;
      }
      if (expression.includes('isTaskIndexReady()')) return ready;
      if (expression === '[...app.plugins.enabledPlugins]') return ['task-manager'];
      throw new Error('Unhandled controller evaluation');
    },
    async send(method) { trace.push(method); },
  };
  return { client, trace, clicks: () => clicks };
}
const session = { vault: '/synthetic/Task Manager Smoke' };

test('trust setup waits through asynchronous prompt readiness and focuses the native document first', async () => {
  const f = controllerFixture();
  assert.deepEqual(await trustGeneratedPlugin(f.client, session), { enabled: ['task-manager'] });
  assert.equal(f.clicks(), 1);
  assert.ok(f.trace.indexOf('native-document') < f.trace.indexOf('trust-once'));
  assert.equal(f.trace.filter(e => e === 'read-trust').length, 2);
  assert.equal(f.trace.filter(e => e === 'focus').length, 2);
});

test('already-ready generated plugin does not repeat the trust mutation', async () => {
  const f = controllerFixture({ ready: true });
  await trustGeneratedPlugin(f.client, session); assert.equal(f.clicks(), 0);
});

test('unknown trust-click outcomes are not automatically replayed', async () => {
  const f = controllerFixture({ clickFails: true });
  await assert.rejects(trustGeneratedPlugin(f.client, session), /Unknown click outcome/u);
  assert.equal(f.clicks(), 1);
});

test('ambiguous trust controls fail before any activation', async () => {
  const f = controllerFixture({ ambiguous: true });
  await assert.rejects(trustGeneratedPlugin(f.client, session), /Ambiguous/u);
  assert.equal(f.clicks(), 0);
});
