import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKanbanMarkdown, parseKanbanMarkdown } from '../src/kanban-board';

test('parseKanbanMarkdown supports collapsed kanban-plugin frontmatter marker', () => {
  const board = parseKanbanMarkdown([
    '---kanban-plugin: basic---',
    '## Todo',
    '- [ ] Capture inbox',
    '',
    '## Done',
    '- [x] Ship release',
  ].join('\n'));

  assert.equal(board.metadata?.['kanban-plugin'], 'basic');
  assert.equal(board.columns.length, 2);
  assert.equal(board.columns[0].title, 'Todo');
  assert.equal(board.columns[0].cards[0].title, 'Capture inbox');
  assert.equal(board.columns[0].cards[0].status, ' ');
  assert.equal(board.columns[1].title, 'Done');
  assert.equal(board.columns[1].cards[0].title, 'Ship release');
  assert.equal(board.columns[1].cards[0].status, 'x');
});

test('parseKanbanMarkdown ignores body-only collapsed kanban-plugin markers', () => {
  const board = parseKanbanMarkdown([
    '# Notes',
    '',
    '---kanban-plugin: basic---',
    '',
    '## Todo',
    '- [ ] Capture inbox',
  ].join('\n'));

  assert.deepEqual(board.metadata, {});
  assert.equal(board.columns.length, 1);
  assert.equal(board.columns[0].title, 'Todo');
  assert.equal(board.columns[0].cards[0].title, 'Capture inbox');
});

test('parseKanbanMarkdown ignores body-only kanban-plugin text after frontmatter', () => {
  const board = parseKanbanMarkdown([
    '---',
    'title: Notes',
    '---',
    '',
    'Body mentions kanban-plugin: basic but is not board metadata.',
    '',
    '## Todo',
    '- [ ] Capture inbox',
  ].join('\n'));

  assert.deepEqual(board.metadata, {});
  assert.equal(board.columns.length, 1);
  assert.equal(board.columns[0].title, 'Todo');
  assert.equal(board.columns[0].cards[0].title, 'Capture inbox');
});

test('parseKanbanMarkdown ignores kanban-plugin text inside frontmatter values', () => {
  const board = parseKanbanMarkdown([
    '---',
    'description: "mentions kanban-plugin: basic"',
    '---',
    '',
    '## Todo',
    '- [ ] Capture inbox',
  ].join('\n'));

  assert.deepEqual(board.metadata, {});
  assert.equal(board.columns.length, 1);
  assert.equal(board.columns[0].title, 'Todo');
  assert.equal(board.columns[0].cards[0].title, 'Capture inbox');
});

test('parseKanbanMarkdown supports multi-character checkbox states', () => {
  const board = parseKanbanMarkdown([
    '## Todo',
    '- [TODO] Fix bug',
  ].join('\n'));

  assert.equal(board.columns[0].cards[0].status, 'TODO');
  assert.equal(board.columns[0].cards[0].title, 'Fix bug');
});

test('generateKanbanMarkdown quotes frontmatter scalar values safely', () => {
  const markdown = generateKanbanMarkdown({
    title: 'Board',
    metadata: {
      owner: 'Team: Platform #1',
      notes: 'Line one\nLine two',
      archived: false,
    },
    columns: [
      { id: 'todo', title: 'Todo', cards: [{ id: 'c1', title: 'Fix bug', status: ' ' }] },
    ],
  });

  assert.match(markdown, /^owner: "Team: Platform #1"$/mu);
  assert.match(markdown, /^notes: "Line one\\nLine two"$/mu);
  assert.match(markdown, /^archived: false$/mu);

  const parsed = parseKanbanMarkdown(markdown);
  assert.equal(parsed.metadata?.owner, 'Team: Platform #1');
  assert.equal(parsed.metadata?.notes, 'Line one\nLine two');
  assert.equal(parsed.metadata?.archived, false);
  assert.equal(parsed.columns[0].cards[0].title, 'Fix bug');
});
