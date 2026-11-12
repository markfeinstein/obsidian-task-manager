import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'obsidian';
import { AiQueryModal } from '../src/modals/ai-query-modal';
import { DEFAULT_SETTINGS, defaultAiModelForProvider, normalizeTaskManagerSettings, type TaskManagerSettings } from '../src/types';
import type { TaskScanner } from '../src/task-scanner';
import { installDomHarness } from './dom-harness';
import { renderVoiceAndAiSection } from '../src/settings/voice-ai-section';
import type { SettingsHost } from '../src/settings-contract';

function modal(context: TestContext, settings: Partial<TaskManagerSettings>, fetch: typeof globalThis.fetch) {
  const harness = installDomHarness();
  const previous = globalThis.fetch;
  globalThis.fetch = fetch;
  const app = { workspace: { getMostRecentLeaf: () => null } } as unknown as App;
  const scanner = new Proxy({}, { get: () => { throw new Error('Query generation must not read the task index or scanner'); } }) as TaskScanner;
  const modal = new AiQueryModal(app, { ...structuredClone(DEFAULT_SETTINGS), aiQueryApiKey: 'synthetic-key', ...settings }, scanner);
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  modal.onOpen();
  context.after(() => { modal.onClose(); globalThis.fetch = previous; harness.cleanup(); });
  return {
    contentEl,
    generate: async () => {
      const input = contentEl.querySelector('textarea');
      const button = Array.from(contentEl.querySelectorAll('button')).find((button) => button.textContent === 'Generate Query');
      assert.ok(input && button);
      input.value = 'unfinished tasks';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

test('AI settings migrate both obsolete Anthropic default spellings but preserve custom models and default-off browser access', () => {
  for (const old of ['claude-haiku-3-5-20241022', 'claude-3-5-haiku-20241022', '']) {
    const settings = normalizeTaskManagerSettings({ aiQueryProvider: 'anthropic', aiQueryModel: old });
    assert.equal(settings.aiQueryModel, 'claude-haiku-4-5-20251001');
    assert.equal(settings.aiQueryAnthropicBrowserAccess, false);
  }
  assert.equal(normalizeTaskManagerSettings({ aiQueryProvider: 'anthropic', aiQueryModel: 'custom-evaluated-model' }).aiQueryModel, 'custom-evaluated-model');
  assert.equal(normalizeTaskManagerSettings({ aiQueryAnthropicBrowserAccess: 'true' as never }).aiQueryAnthropicBrowserAccess, false);
  assert.equal(normalizeTaskManagerSettings({ aiQueryAnthropicBrowserAccess: true }).aiQueryAnthropicBrowserAccess, true);
  assert.equal(DEFAULT_SETTINGS.aiQueryEnabled, false);
});

test('Anthropic settings expose an explicit browser opt-in and persist it only on user change', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  let saved = 0;
  const settings = { ...structuredClone(DEFAULT_SETTINGS), aiQueryEnabled: true, aiQueryProvider: 'anthropic' as const };
  const host = { settings, saveSettings: async () => { saved += 1; } } as unknown as SettingsHost;
  const root = harness.document.createElement('section');
  renderVoiceAndAiSection(root, host, () => undefined);
  const row = Array.from(root.querySelectorAll('.setting-item')).find((row) => row.querySelector('.setting-item-name')?.textContent === 'Allow direct Anthropic browser access');
  const toggle = row?.querySelector('input') as (HTMLInputElement & { _onChange?: (value: boolean) => Promise<void> }) | null;
  assert.ok(toggle?._onChange);
  assert.equal(settings.aiQueryAnthropicBrowserAccess, false);
  assert.equal(saved, 0);
  await toggle._onChange(true);
  assert.equal(settings.aiQueryAnthropicBrowserAccess, true);
  const keyRow = Array.from(root.querySelectorAll('.setting-item')).find((row) => row.querySelector('.setting-item-name')?.textContent === 'AI API key');
  const key = keyRow?.querySelector('input') as (HTMLInputElement & { _onChange?: (value: string) => Promise<void> }) | null;
  assert.ok(key?._onChange);
  await key._onChange(' synthetic ');
  assert.equal(settings.aiQueryApiKey, 'synthetic');
  assert.equal(saved, 2);
});

test('Anthropic generation refuses missing browser consent before network access', async (context) => {
  let requests = 0;
  const harness = modal(context, { aiQueryProvider: 'anthropic', aiQueryAnthropicBrowserAccess: false }, async () => { requests += 1; throw new Error('Must not fetch'); });
  await harness.generate();
  assert.equal(requests, 0);
  assert.match(harness.contentEl.querySelector('[role="alert"]')?.textContent ?? '', /browser access/u);
});

test('Anthropic modal entry point sends documented browser headers and only the question plus grammar, then validates text blocks', async (context) => {
  let payload: { model: string; system: string; messages: Array<{ role: string; content: string }> } | undefined;
  const harness = modal(context, { aiQueryProvider: 'anthropic', aiQueryModel: '', aiQueryAnthropicBrowserAccess: true }, async (input, init) => {
    assert.equal(String(input), 'https://api.anthropic.com/v1/messages');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('anthropic-dangerous-direct-browser-access'), 'true');
    assert.equal(headers.get('anthropic-version'), '2023-06-01');
    payload = JSON.parse(String(init?.body)) as typeof payload;
    return Response.json({ content: [{ type: 'thinking', thinking: 'not displayed' }, { type: 'text', text: 'not done\nlimit 10' }] });
  });
  await harness.generate();
  assert.ok(payload);
  assert.equal(payload.model, defaultAiModelForProvider('anthropic'));
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'unfinished tasks' }]);
  assert.match(payload.system, /Available filter keywords/u);
  assert.match(harness.contentEl.querySelector('pre')?.textContent ?? '', /not done\nlimit 10/u);
  assert.doesNotMatch(harness.contentEl.textContent ?? '', /not displayed/u);
});

test('OpenAI query requests explicitly disable stored completions', async (context) => {
  const harness = modal(context, { aiQueryProvider: 'openai' }, async (_input, init) => {
    assert.equal((JSON.parse(String(init?.body)) as { store: boolean }).store, false);
    assert.equal(new Headers(init?.headers).has('anthropic-dangerous-direct-browser-access'), false);
    return Response.json({ choices: [{ message: { content: 'not done' } }] });
  });
  await harness.generate();
  assert.ok(harness.contentEl.querySelector('pre'));
});

test('empty provider replies and missing API keys never turn into an unrestricted empty query', async (context) => {
  for (const kind of ['empty', 'missing-key'] as const) {
    await context.test(kind, async (subtest) => {
      let calls = 0;
      const harness = modal(subtest, { aiQueryProvider: 'openai', aiQueryApiKey: kind === 'missing-key' ? ' ' : 'synthetic-key' }, async () => { calls += 1; return Response.json({ choices: [] }); });
      await harness.generate();
      assert.equal(calls, kind === 'missing-key' ? 0 : 1);
      assert.ok(harness.contentEl.querySelector('[role="alert"]'));
      assert.equal(harness.contentEl.querySelector('pre'), null);
    });
  }
});
