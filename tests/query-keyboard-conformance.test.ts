import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueryRenderer } from '../src/query-renderer';
import { TaskScanner, type ParsedTask } from '../src/task-scanner';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHarness } from './dom-harness';

async function fixture(context: TestContext) {
  const dom = installDomHarness();
  context.after(dom.cleanup);
  // JSDOM has no layout/scroll engine; event dispatch and native DOM controls remain real.
  dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
  const app = {
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getFileCache: () => null, fileToLinktext: () => '' },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
  };
  const scanner = new TaskScanner(app as never);
  const tasks = ['- [ ] Keyboard first 📅 2030-01-01', '- [ ] Keyboard second']
    .map((line, index) => scanner.parseTaskLine(line, 'Tasks.md', index + 1))
    .filter((task): task is ParsedTask => task !== null);
  let edits = 0;
  let toggles = 0;
  let dates = 0;
  let opens = 0;
  const renderer = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS,
    undefined, undefined, () => { edits += 1; }, undefined, undefined, undefined, undefined, async () => tasks);
  const root = dom.document.createElement('section');
  dom.document.body.appendChild(root);
  await renderer.render('not done\nsort by description\nlimit 10', root, { sourcePath: 'Query.md' } as never);
  const list = root.querySelector<HTMLElement>('.task-manager-query-list');
  assert.ok(list);
  for (const [selector, activate] of [
    ['.task-manager-query-marker', () => { toggles += 1; }],
    ['.task-manager-query-metadata-date', () => { dates += 1; }],
    ['.tasks-backlink', () => { opens += 1; }],
  ] as const) {
    for (const control of root.querySelectorAll(selector)) control.addEventListener('click', event => {
      event.preventDefault(); event.stopImmediatePropagation(); activate();
    }, { capture: true });
  }
  const key = (value: string, options: KeyboardEventInit = {}) => list.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, ...options }));
  list.focus(); key('j');
  const rows = [...root.querySelectorAll<HTMLElement>('.task-manager-query-item')];
  return { dom, root, list, rows, key, counts: () => ({ edits, toggles, dates, opens }) };
}

test('plain-query E X Space D and O activate the actually rendered controls exactly once', async context => {
  const f = await fixture(context);
  assert.equal(f.dom.document.activeElement, f.rows[0]);
  f.key('e');
  assert.equal(f.counts().edits, 1);
  f.key('x'); f.key(' '); f.key('d'); f.key('o');
  assert.deepEqual(f.counts(), { edits: 1, toggles: 2, dates: 1, opens: 1 });
});

test('plain-query navigation ignores system chords repeat composition and inline typing', async context => {
  const f = await fixture(context);
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { altKey: true }]) {
    f.key('j', options);
    assert.equal(f.dom.document.activeElement, f.rows[0]);
  }
  const input = f.dom.document.createElement('input');
  f.list.appendChild(input); input.focus();
  f.key('e'); f.key('x');
  assert.deepEqual(f.counts(), { edits: 0, toggles: 0, dates: 0, opens: 0 });
});

test('plain-query arrow aliases move actual row focus before Space activates its marker', async context => {
  const f = await fixture(context);
  f.key('ArrowDown');
  assert.equal(f.dom.document.activeElement, f.rows[1]);
  f.key('ArrowUp');
  assert.equal(f.dom.document.activeElement, f.rows[0]);
  f.key(' ');
  assert.equal(f.counts().toggles, 1);
});
