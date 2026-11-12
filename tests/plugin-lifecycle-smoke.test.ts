import assert from 'node:assert/strict';
import test from 'node:test';
import type { App, PluginManifest, TFile } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { installDomHarness } from './dom-harness';
import { MockVault } from './test-utils';

function eventSource(): { on: (_name: string, _callback: (...args: unknown[]) => unknown) => { off: () => void } } {
  return { on: () => ({ off: () => undefined }) };
}

void test('plugin lifecycle smoke: onload registers surfaces and onunload releases resources', async (context) => {
  const harness = installDomHarness();
  const vault = Object.assign(new MockVault(), {
    configDir: '.obsidian',
    adapter: { exists: async () => false, read: async () => '', write: async () => undefined },
    getMarkdownFiles: (): TFile[] => [],
    getFiles: (): TFile[] => [],
  });
  const workspaceEvents = eventSource();
  const metadataEvents = eventSource();
  const app = {
    vault,
    workspace: {
      ...workspaceEvents,
      getActiveFile: () => null,
      getLeavesOfType: () => [],
      getLeaf: () => ({ openFile: async () => undefined }),
      onLayoutReady: (callback: () => void) => callback(),
      trigger: () => undefined,
    },
    metadataCache: {
      ...metadataEvents,
      getFileCache: () => null,
      getCache: () => null,
      getFirstLinkpathDest: () => null,
    },
    fileManager: { processFrontMatter: async () => undefined },
    keymap: { pushScope: () => undefined, popScope: () => undefined },
    secretStorage: { getSecret: async () => null, setSecret: async () => undefined },
  } as unknown as App;
  const manifest: PluginManifest = {
    id: 'task-manager', name: 'Task Manager', version: '1.0.0', minAppVersion: '1.5.0', description: 'Tasks', author: 'Maintainer',
  };
  const plugin = new TaskManagerPlugin(app, manifest);
  let unloaded = false;
  context.after(() => {
    if (!unloaded) (plugin as unknown as { unloadForTest: () => void }).unloadForTest();
  });
  context.after(harness.cleanup);

  await plugin.onload();

  const registered = plugin as unknown as {
    _commands: Array<{ id: string; callback?: () => void }>;
    _registered: unknown[];
    _settingTab?: unknown;
    _view?: unknown;
    activeOnboarding: { close(): void } | null;
    onboardingAutoOpenAttempted: boolean;
    maybeOpenOnboarding(): void;
    unloadForTest: () => void;
  };
  assert.ok(registered._commands.length > 0, 'plugin should register commands');
  assert.ok(registered._settingTab, 'plugin should register settings');
  assert.ok(registered._view, 'plugin should register views');
  assert.ok(registered.activeOnboarding, 'a genuinely unseen profile should open onboarding after layout readiness');
  const firstOnboarding = registered.activeOnboarding;
  firstOnboarding.close();
  assert.equal(registered.activeOnboarding, null);
  registered.maybeOpenOnboarding();
  assert.equal(registered.activeOnboarding, null, 'automatic onboarding is attempted at most once per plugin load');
  const gettingStarted = registered._commands.find((command) => command.id === 'open-getting-started');
  assert.ok(gettingStarted?.callback, 'permanent getting-started command should be registered');
  gettingStarted.callback();
  assert.ok(registered.activeOnboarding, 'the command should reopen onboarding regardless of the automatic attempt');
  assert.notEqual(registered.activeOnboarding, firstOnboarding);
  registered.unloadForTest();
  unloaded = true;
  assert.equal(registered._registered.length, 0, 'plugin unload should release registered resources');
});
