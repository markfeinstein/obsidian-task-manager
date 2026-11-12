import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/state-store';
import { DEFAULT_SETTINGS } from '../src/types';

test('StateStore migrates plaintext credentials to SecretStorage and clears data.json fields', async () => {
  let data: Record<string, unknown> = { futureKey: 'preserved', settings: { todoistApiKey: 'todo-secret', whisperApiKey: 'whisper-secret' } };
  const secrets = new Map<string, string>();
  const plugin = {
    app: { secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } } },
    loadData: async () => data,
    saveData: async (next: Record<string, unknown>) => { data = next; },
  };
  const store = new StateStore(plugin as never);

  const loaded = await store.loadSettings(DEFAULT_SETTINGS);
  assert.equal(loaded.todoistApiKey, 'todo-secret');
  assert.equal(loaded.whisperApiKey, 'whisper-secret');
  assert.equal(secrets.get('obsidian-task-manager-todoist-api-key'), 'todo-secret');
  assert.equal(secrets.get('obsidian-task-manager-whisper-api-key'), 'whisper-secret');
  const persisted = data.settings as Record<string, unknown>;
  assert.equal(persisted.todoistApiKey, '');
  assert.equal(persisted.whisperApiKey, '');
  assert.equal(data.futureKey, 'preserved');
});

test('StateStore.usesPlaintextSecretFallback reflects SecretStorage availability and active secrets', () => {
  const withoutStorage = new StateStore({ app: {}, loadData: async () => ({}), saveData: async () => {} } as never);
  assert.equal(withoutStorage.usesPlaintextSecretFallback({ ...DEFAULT_SETTINGS, todoistApiKey: 'plain-secret' }), true);
  assert.equal(withoutStorage.usesPlaintextSecretFallback({ ...DEFAULT_SETTINGS }), false);

  const secrets = new Map<string, string>();
  const withStorage = new StateStore({
    app: { secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } } },
    loadData: async () => ({}),
    saveData: async () => {},
  } as never);
  assert.equal(withStorage.usesPlaintextSecretFallback({ ...DEFAULT_SETTINGS, todoistApiKey: 'plain-secret' }), false);
});

test('StateStore removes retired embedded MCP credentials from data and SecretStorage', async () => {
  let data: Record<string, unknown> = { settings: { mcpServerEnabled: true, mcpServerPort: 7777, mcpServerToken: 'retired-secret' } };
  const secrets = new Map<string, string>([['obsidian-task-manager-mcp-token', 'retired-secret']]);
  const plugin = {
    app: { secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } } },
    loadData: async () => data,
    saveData: async (next: Record<string, unknown>) => { data = next; },
  };
  const store = new StateStore(plugin as never);

  const loaded = await store.loadSettings(DEFAULT_SETTINGS);
  const persisted = data.settings as Record<string, unknown>;

  assert.equal('mcpServerEnabled' in loaded, false);
  assert.equal('mcpServerToken' in persisted, false);
  assert.equal('mcpServerPort' in persisted, false);
  assert.equal(secrets.get('obsidian-task-manager-mcp-token'), '');
});

test('StateStore saves and hydrates credentials through SecretStorage references', async () => {
  let data: Record<string, unknown> = {};
  const secrets = new Map<string, string>();
  const plugin = {
    app: { secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } } },
    loadData: async () => data,
    saveData: async (next: Record<string, unknown>) => { data = next; },
  };
  const store = new StateStore(plugin as never);
  await store.saveSettings({ ...DEFAULT_SETTINGS, caldavPassword: 'calendar-secret', msToDoToken: 'graph-secret' });

  const persisted = data.settings as Record<string, unknown>;
  assert.equal(persisted.caldavPassword, '');
  assert.equal(persisted.msToDoToken, '');
  const loaded = await store.loadSettings(DEFAULT_SETTINGS);
  assert.equal(loaded.caldavPassword, 'calendar-secret');
  assert.equal(loaded.msToDoToken, 'graph-secret');
});

test('StateStore scrubs plaintext collisions while SecretStorage value wins', async () => {
  for (const plaintext of ['stored-secret', 'different-stale-secret']) {
    let data: Record<string, unknown> = { futureKey: 'preserved', settings: { todoistApiKey: plaintext } };
    const secrets = new Map<string, string>([['obsidian-task-manager-todoist-api-key', 'stored-secret']]);
    let saves = 0;
    const store = new StateStore({
      app: { secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } } },
      loadData: async () => data,
      saveData: async (next: Record<string, unknown>) => { saves += 1; data = next; },
    } as never);

    const loaded = await store.loadSettings(DEFAULT_SETTINGS);
    assert.equal(loaded.todoistApiKey, 'stored-secret');
    assert.equal((data.settings as Record<string, unknown>).todoistApiKey, '');
    assert.equal(data.futureKey, 'preserved');
    assert.equal(saves, 1);
  }
});

test('StateStore rejects a failed plaintext scrub and retries on the next load', async () => {
  let data: Record<string, unknown> = { settings: { todoistApiKey: 'plaintext-secret' } };
  const secrets = new Map<string, string>([['obsidian-task-manager-todoist-api-key', 'stored-secret']]);
  let failSave = true;
  const store = new StateStore({
    app: { secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } } },
    loadData: async () => data,
    saveData: async (next: Record<string, unknown>) => {
      if (failSave) throw new Error('scrub failed');
      data = next;
    },
  } as never);

  await assert.rejects(store.loadSettings(DEFAULT_SETTINGS), /scrub failed/u);
  assert.equal((data.settings as Record<string, unknown>).todoistApiKey, 'plaintext-secret');
  failSave = false;
  const loaded = await store.loadSettings(DEFAULT_SETTINGS);
  assert.equal(loaded.todoistApiKey, 'stored-secret');
  assert.equal((data.settings as Record<string, unknown>).todoistApiKey, '');
});

test('StateStore refuses to persist active secrets when SecretStorage is unavailable', async () => {
  let data: Record<string, unknown> = {};
  const plugin = { loadData: async () => data, saveData: async (next: Record<string, unknown>) => { data = next; } };
  const store = new StateStore(plugin as never);
  const saved = await store.saveSettings({ ...DEFAULT_SETTINGS, todoistApiKey: 'fallback-secret' });
  assert.equal(saved, false);
  assert.equal(data.settings, undefined);
});
