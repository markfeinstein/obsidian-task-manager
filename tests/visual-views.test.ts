import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceLeaf } from 'obsidian';
import { VisualTaskView } from '../src/visual-views';
import { installDomHarness } from './dom-harness';

test('standalone visual views disclose their global unfinished-task scope', async (context) => {
  const dom = installDomHarness();
  context.after(dom.cleanup);
  const rendered: string[] = [];
  const view = new VisualTaskView({ app: {} } as unknown as WorkspaceLeaf, 'table', () => ({
    render: async (query: string) => { rendered.push(query); },
  } as never));
  (view as unknown as { contentEl: HTMLElement }).contentEl = dom.document.createElement('div');
  await view.onOpen();
  assert.match((view as unknown as { contentEl: HTMLElement }).contentEl.textContent ?? '', /Global unfinished tasks/u);
  assert.deepEqual(rendered, ['not done\nview: table\nsort by smart']);
});
