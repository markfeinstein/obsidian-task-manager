import assert from 'node:assert/strict';
import test from 'node:test';
import { debounce, Modal, Plugin, SuggestModal, TFile, TFolder } from 'obsidian';
import type { App, PluginManifest } from 'obsidian';
import { FakeDOMElement, FakeFile, FakeFolder, MockVault } from './test-utils';

class LifecyclePlugin extends Plugin {
  addCleanup(cleanup: () => void): void {
    this.register(cleanup);
  }
}

class LifecycleSuggest extends SuggestModal<unknown> {
  opened = 0;
  getSuggestions(): unknown[] { return []; }
  renderSuggestion(): void {}
  onChooseSuggestion(): void {}
  onOpen(): void { this.opened += 1; }
}

void test('canonical files preserve Obsidian runtime identity', () => {
  assert.equal(new FakeFile('Tasks.md', 'Tasks.md') instanceof TFile, true);
  assert.equal(new FakeFolder('Projects', 'Projects') instanceof TFolder, true);
});

void test('mock vault emits create, modify, rename, and delete events with removable listeners', async () => {
  const vault = new MockVault();
  const events: string[] = [];
  const refs = [
    vault.on('create', () => events.push('create')),
    vault.on('modify', () => events.push('modify')),
    vault.on('rename', () => events.push('rename')),
    vault.on('delete', () => events.push('delete')),
  ];
  const file = await vault.create('Tasks.md', '- [ ] Test');
  await vault.modify(file, '- [x] Test');
  await vault.rename(file, 'Archive/Tasks.md');
  await vault.delete(file);
  assert.deepEqual(events, ['create', 'modify', 'rename', 'delete']);

  for (const ref of refs) ref.off();
  await vault.create('Second.md', '');
  assert.deepEqual(events, ['create', 'modify', 'rename', 'delete']);
});

void test('fake DOM preserves multiple listeners and supports removal', () => {
  const element = new FakeDOMElement('button');
  const calls: string[] = [];
  const first = () => calls.push('first');
  const second = () => calls.push('second');
  element.addEventListener('click', first);
  element.addEventListener('click', second);
  element.dispatchEvent({ type: 'click' });
  assert.deepEqual(calls, ['first', 'second']);
  element.removeEventListener('click', first);
  element.dispatchEvent({ type: 'click' });
  assert.deepEqual(calls, ['first', 'second', 'second']);
});

void test('plugin registration cleanup runs in reverse registration order', () => {
  const manifest: PluginManifest = {
    id: 'test-plugin', name: 'Test plugin', version: '1.0.0', minAppVersion: '1.0.0', description: '', author: '',
  };
  const plugin = new LifecyclePlugin({} as App, manifest);
  const calls: string[] = [];
  plugin.addCleanup(() => calls.push('first'));
  plugin.addCleanup(() => calls.push('second'));
  (plugin as unknown as { unloadForTest: () => void }).unloadForTest();
  assert.deepEqual(calls, ['second', 'first']);
});

void test('debounce coalesces, supports immediate run, and cancellation', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: number[] = [];
  const debounced = debounce((value: number) => calls.push(value), 10, true);
  debounced(1);
  debounced(2);
  context.mock.timers.tick(10);
  assert.deepEqual(calls, [2]);

  debounced(3);
  debounced.run();
  assert.deepEqual(calls, [2, 3]);
  debounced(4);
  debounced.cancel();
  context.mock.timers.tick(20);
  assert.deepEqual(calls, [2, 3]);
});

void test('modal and suggest-modal open invoke lifecycle hooks', () => {
  let modalOpened = 0;
  const modal = new Modal({} as App) as Modal & { onOpen: () => void };
  modal.onOpen = () => { modalOpened += 1; };
  modal.open();
  assert.equal(modalOpened, 1);

  const suggest = new LifecycleSuggest({} as App);
  suggest.open();
  assert.equal(suggest.opened, 1);
});
