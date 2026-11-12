import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAppearanceCss, contrastingTextColor, normalizeColorOverrides, taskDensityClass } from '../src/appearance';
import { DEFAULT_SETTINGS, normalizeTaskManagerSettings, type TaskManagerSettings } from '../src/types';

test('appearance css includes font size and priority override', () => {
  const css = buildAppearanceCss({
    ...DEFAULT_SETTINGS,
    taskFontSize: 'large',
    taskDensity: 'comfortable',
    priorityColorOverrides: { high: '#ff0000' },
    statusColorOverrides: {},
    showPriorityPills: true,
    showStatusIcons: true,
  });
  assert.match(css, /--task-manager-task-font-size: 1\.1em/);
  assert.match(css, /--task-manager-query-padding-block: 4px/);
  assert.match(css, /--task-priority-high-bg: #ff0000/);
  // Text color must NOT be the same as background (#000000 for red, not #ff0000).
  assert.match(css, /--task-priority-high-text: #000000/);
  assert.doesNotMatch(css, /--task-priority-high-text: #ff0000/);
  assert.match(css, /--task-priority-high-border: #ff0000/);
});

 test('appearance hide priority pills targets only priority pill metadata', () => {
  const css = buildAppearanceCss({
    ...DEFAULT_SETTINGS,
    taskFontSize: 'normal',
    taskDensity: 'compact',
    priorityColorOverrides: {},
    statusColorOverrides: {},
    showPriorityPills: false,
    showStatusIcons: true,
  });
  assert.match(css, /\.task-manager-query \.task-manager-priority-pill/);
  assert.doesNotMatch(css, /\.task-manager-query \.task-priority-high,/);
});

test('appearance normalization drops invalid color overrides', () => {
  assert.deepEqual(normalizeColorOverrides({ high: '#00ff00', low: 'red', empty: '' }), { high: '#00ff00' });
});

test('appearance css trims accepted color overrides before emitting variables', () => {
  const css = buildAppearanceCss({
    ...DEFAULT_SETTINGS,
    taskFontSize: 'normal',
    taskDensity: 'comfortable',
    priorityColorOverrides: { high: '  #00ff00  ' },
    statusColorOverrides: { done: '  #123456  ' },
    showPriorityPills: true,
    showStatusIcons: true,
  });
  assert.match(css, /--task-priority-high-bg: #00ff00;/);
  assert.match(css, /--task-status-done: #123456;/);
  assert.doesNotMatch(css, /--task-priority-high-bg:   #00ff00  ;/);
  assert.doesNotMatch(css, /--task-status-done:   #123456  ;/);
});

test('settings normalization validates appearance fields', () => {
  const settings = normalizeTaskManagerSettings({
    taskFontSize: 'huge' as unknown as TaskManagerSettings['taskFontSize'],
    taskDensity: 'compact',
    priorityColorOverrides: { high: '#123456', low: 'bad' },
    showPriorityPills: false,
  });
  assert.equal(settings.taskFontSize, 'normal');
  assert.equal(settings.taskDensity, 'compact');
  assert.deepEqual(settings.priorityColorOverrides, { high: '#123456' });
  assert.equal(settings.showPriorityPills, false);
});

test('contrastingTextColor: white text on dark backgrounds, black on light', () => {
  assert.equal(contrastingTextColor('#000000'), '#ffffff'); // black bg → white text
  assert.equal(contrastingTextColor('#ffffff'), '#000000'); // white bg → black text
  assert.equal(contrastingTextColor('#ff0000'), '#000000'); // red (L=0.2126) → black text
  assert.equal(contrastingTextColor('#0000ff'), '#ffffff'); // blue (L=0.0722) → white text
  assert.equal(contrastingTextColor('#ffff00'), '#000000'); // yellow (high luminance) → black text
});

test('taskDensityClass maps setting values', () => {
  assert.equal(taskDensityClass('compact'), 'task-manager-density-compact');
  assert.equal(taskDensityClass('comfortable'), 'task-manager-density-comfortable');
  assert.equal(taskDensityClass('spacious'), 'task-manager-density-spacious');
});
