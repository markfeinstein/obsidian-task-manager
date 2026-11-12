import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import { canvasToJSON, createCanvasFromTasks, tasksToCanvas, updateCanvasTaskCheckbox } from '../src/canvas-exporter';
import type { ParsedTask } from '../src/task-scanner';

function task(priority: string = 'high'): ParsedTask {
  return {
    key: 'Project.md:task',
    filePath: 'Project.md',
    lineNumber: 1,
    rawLine: '- [ ] Ship feature ⏫ 📅 2026-05-29 #work',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body: 'Ship feature',
    normalizedText: 'Ship feature',
    status: 'todo',
    tags: ['#work'],
    contexts: [],
    metadata: {
      dates: { due: '2026-05-29' },
      invalidDates: {},
      priority: priority as any,
      dependsOn: [],
      effort: '2h',
      id: 'ship-feature',
    },
  } as ParsedTask;
}

test('tasksToCanvas creates title and task nodes with edges', () => {
  const canvas = tasksToCanvas([task()], 'Task Manager');
  assert.equal(canvas.nodes.length, 2);
  assert.equal(canvas.edges.length, 1);
  assert.equal(canvas.nodes[0].id, 'title');
  assert.match(canvas.nodes[1].text ?? '', /Ship feature/u);
  assert.match(canvas.nodes[1].text ?? '', /Due: 2026-05-29/u);
});

test('tasksToCanvas applies priority colours', () => {
  const canvas = tasksToCanvas([task('highest')]);
  assert.equal(canvas.nodes[1].color, '#FF6B6B');
});

test('canvasToJSON returns valid canvas JSON', () => {
  const json = canvasToJSON(tasksToCanvas([task()]));
  const parsed = JSON.parse(json) as { nodes: unknown[]; edges: unknown[] };
  assert.equal(parsed.nodes.length, 2);
  assert.equal(parsed.edges.length, 1);
  const taskNode = parsed.nodes[1] as { text?: string; content?: string };
  assert.match(taskNode.text ?? '', /Ship feature/u);
  assert.equal(taskNode.content, undefined);
});

test('createCanvasFromTasks writes a canvas file through the vault API', async () => {
  const writes: Record<string, string> = {};
  class TestFile { constructor(public path: string) {} }
  const app = {
    vault: {
      getAbstractFileByPath: () => null,
      createFolder: async () => { throw new Error('createFolder should not be called for root file'); },
      create: async (path: string, content: string) => {
        writes[path] = content;
        return new TestFile(path);
      },
      modify: async () => { throw new Error('modify should not be called for new file'); },
    },
  } as any;

  const file = await createCanvasFromTasks(app, [task()], 'Tasks.canvas', 'Tasks');
  assert.equal(file.path, 'Tasks.canvas');
  assert.ok(writes['Tasks.canvas']);
  const parsed = JSON.parse(writes['Tasks.canvas']) as { nodes: Array<{ text?: string; content?: string }> };
  assert.equal(parsed.nodes.length, 2);
  assert.match(parsed.nodes[1].text ?? '', /Ship feature/u);
  assert.equal(parsed.nodes[1].content, undefined);
});

test('createCanvasFromTasks creates missing parent folders before writing nested canvas files', async () => {
  const writes: Record<string, string> = {};
  const folders: string[] = [];
  const existingPaths = new Set<string>();
  class TestFile { constructor(public path: string) {} }
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => existingPaths.has(path) ? new TestFile(path) : null,
      createFolder: async (path: string) => {
        folders.push(path);
        existingPaths.add(path);
      },
      create: async (path: string, content: string) => {
        writes[path] = content;
        existingPaths.add(path);
        return new TestFile(path);
      },
      modify: async () => { throw new Error('modify should not be called for new file'); },
    },
  } as any;

  const file = await createCanvasFromTasks(app, [task()], 'Exports/Boards/Tasks.canvas', 'Tasks');
  assert.equal(file.path, 'Exports/Boards/Tasks.canvas');
  assert.deepEqual(folders, ['Exports', 'Exports/Boards']);
  assert.ok(writes['Exports/Boards/Tasks.canvas']);
});

test('updateCanvasTaskCheckbox updates blockquoted checkbox lines', async () => {
  const file = new TFile() as TFile & { path: string };
  file.path = 'Board.canvas';
  let content = JSON.stringify({
    nodes: [{ id: 'node-a', type: 'text', text: '> - [ ] Quoted task' }],
    edges: [],
  });
  const app = {
    vault: {
      getAbstractFileByPath(path: string): TFile | null { return path === file.path ? file : null; },
      async process(_file: TFile, fn: (current: string) => string): Promise<void> {
        content = fn(content);
      },
    },
  };

  await updateCanvasTaskCheckbox(app as never, 'Board.canvas', 'node-a', 1, 'x', '> - [ ] Quoted task');

  const parsed = JSON.parse(content) as { nodes: Array<{ text: string }> };
  assert.equal(parsed.nodes[0].text, '> - [x] Quoted task');
});
