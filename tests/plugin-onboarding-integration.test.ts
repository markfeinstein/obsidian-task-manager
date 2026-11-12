import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { ONBOARDING_QUERY_SNIPPET, type OnboardingActionResult } from '../src/modals/onboarding-modal';
import { installDomHarness } from './dom-harness';

test('plugin Sidebar opener reuses an existing leaf and creates one when absent', async () => {
  let reveals = 0;
  let viewStates = 0;
  const existingLeaf = {};
  const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin;
  Object.assign(plugin, { app: { workspace: {
    getLeavesOfType: () => [existingLeaf],
    revealLeaf: async () => { reveals += 1; },
    getRightLeaf: () => null,
  } } as unknown as App });
  await plugin.openTaskPanel();
  assert.equal(reveals, 1);
  Object.assign(plugin.app.workspace, {
    getLeavesOfType: () => [],
    getRightLeaf: () => ({ setViewState: async () => { viewStates += 1; } }),
  });
  await plugin.openTaskPanel();
  assert.equal(viewStates, 1);
  assert.equal(reveals, 2);
});

test('plugin onboarding query action inserts, copies, and fails closed locally', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  let inserted = '';
  const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin;
  Object.assign(plugin, { app: { workspace: { activeEditor: { editor: { replaceSelection: (value: string) => { inserted = value; } } } } } as unknown as App });
  const invoke = () => (plugin as unknown as { insertOrCopyOnboardingQuery(): Promise<OnboardingActionResult> }).insertOrCopyOnboardingQuery();
  assert.equal(await invoke(), 'inserted');
  assert.equal(inserted, `${ONBOARDING_QUERY_SNIPPET}\n`);

  Object.assign(plugin.app.workspace, { activeEditor: undefined });
  let copied = '';
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  assert.equal(await invoke(), 'copied');
  assert.equal(copied, ONBOARDING_QUERY_SNIPPET);
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
  assert.equal(await invoke(), 'copy-failed');
});
