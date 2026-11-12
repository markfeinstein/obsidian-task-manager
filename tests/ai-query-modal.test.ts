import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'obsidian';
import { AiQueryModal, serializeAiQueryBlock } from '../src/modals/ai-query-modal';
import type { TaskScanner } from '../src/task-scanner';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHarness } from './dom-harness';
import { AI_QUERY_PROMPT_MAX_BYTES } from '../src/input-budgets';

test('AI query serialization chooses a fence longer than provider backtick runs', () => {
  const block = serializeAiQueryBlock('description includes `````danger\nnot done', 'task-list');
  assert.match(block, /^``````task-list\n/u);
  assert.match(block, /\n``````\n$/u);
});

test('AI query modal refuses an oversized prompt before network access', async (context) => {
  const harness = installDomHarness();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  context.after(() => { globalThis.fetch = originalFetch; harness.cleanup(); });
  globalThis.fetch = async () => { fetches += 1; return new Response('{}'); };
  const app = { workspace: { getMostRecentLeaf: () => null } } as unknown as App;
  const modal = new AiQueryModal(app, { ...structuredClone(DEFAULT_SETTINGS), aiQueryProvider: 'ollama' }, {} as TaskScanner);
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  modal.onOpen();
  const input = contentEl.querySelector<HTMLTextAreaElement>('textarea');
  const generate = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Generate Query');
  assert.ok(input && generate);
  input.value = 'a'.repeat(AI_QUERY_PROMPT_MAX_BYTES + 1);
  generate.click();
  await Promise.resolve();
  assert.equal(fetches, 0);
  assert.match(contentEl.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? '', /exceeds/u);
});

test('AI query modal performs a bounded local request and cleans up', async (context) => {
  const harness = installDomHarness();
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; harness.cleanup(); });
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not done\nlimit 10' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  let inserted = '';
  const app = { workspace: { getMostRecentLeaf: () => ({ view: { editor: { replaceSelection: (value: string) => { inserted = value; } } } }) } } as unknown as App;
  const settings = { ...structuredClone(DEFAULT_SETTINGS), aiQueryProvider: 'ollama' as const, aiQueryLocalEndpoint: 'http://127.0.0.1:11434/v1/chat/completions' };
  const modal = new AiQueryModal(app, settings, {} as TaskScanner);
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();
  const input = contentEl.querySelector<HTMLTextAreaElement>('textarea');
  const generate = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Generate Query');
  assert.ok(input && generate);
  input.value = 'unfinished tasks';
  generate.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(contentEl.textContent ?? '', /not done/u);
  const insert = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Insert into note');
  assert.ok(insert);
  insert.click();
  assert.match(inserted, /```task-list\nnot done\nlimit 10\n```/u);
  modal.onClose();
  assert.equal(contentEl.children.length, 0);
});
