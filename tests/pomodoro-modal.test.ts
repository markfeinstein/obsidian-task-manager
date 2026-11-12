import test from 'node:test';
import assert from 'node:assert/strict';
import { PomodoroModal, parseDurationMinutes } from '../src/modals/pomodoro-modal';
import { FakeDOMElement, createMockTask } from './test-utils';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHarness } from './dom-harness';

test('parseDurationMinutes supports compact hour+minute values without spaces', () => {
  assert.equal(parseDurationMinutes('1h30m'), 90);
});

test('parseDurationMinutes parses standard hour/minute strings and rejects invalid values', () => {
  assert.equal(parseDurationMinutes('2h 15m'), 135);
  assert.equal(parseDurationMinutes('45m'), 45);
  assert.equal(parseDurationMinutes('3h'), 180);
  assert.equal(parseDurationMinutes(''), null);
  assert.equal(parseDurationMinutes('soon'), null);
});

test('PomodoroModal renders localized controls and CSS-driven progress', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getAbstractFileByPath: () => null } };
  const modal = new PomodoroModal(app as never, DEFAULT_SETTINGS, createMockTask({ normalizedText: 'Focus task' }) as never, {} as never);
  modal.open();
  context.after(() => modal.close());

  assert.equal(modal.modalEl.getAttribute('aria-label'), '🍅 Pomodoro Timer');
  assert.match(modal.contentEl.textContent ?? '', /Pomodoro Timer/u);
  assert.match(modal.contentEl.textContent ?? '', /Focus task/u);
  assert.match(modal.contentEl.textContent ?? '', /Round 1 · 25m work \/ 5m break/u);
  assert.ok(Array.from(modal.contentEl.querySelectorAll('button')).some((button) => button.textContent === '▶ Start'));
  const fill = modal.contentEl.querySelector<HTMLElement>('.pomodoro-bar-fill');
  assert.equal(fill?.style.getPropertyValue('--task-manager-pomodoro-progress'), '0%');
});

test('PomodoroModal start and skip render pause/work-break notices', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const originalSetInterval = harness.window.setInterval;
  const originalClearInterval = harness.window.clearInterval;
  harness.window.setInterval = (() => 7) as unknown as typeof window.setInterval;
  harness.window.clearInterval = (() => undefined) as typeof window.clearInterval;
  context.after(() => { harness.window.setInterval = originalSetInterval; harness.window.clearInterval = originalClearInterval; });
  const modal = new PomodoroModal({ vault: { getAbstractFileByPath: () => null } } as never, DEFAULT_SETTINGS, createMockTask({ normalizedText: 'Focus task' }) as never, {} as never);
  modal.open();
  context.after(() => modal.close());

  Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '▶ Start')?.click();
  assert.ok(Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).some((button) => button.textContent === '⏸ Pause'));
  Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '⏭ Skip')?.click();
  assert.match(modal.contentEl.textContent ?? '', /Short Break|Long Break/u);
  Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '⏭ Skip')?.click();
  assert.match(modal.contentEl.textContent ?? '', /Work/u);
});

test('PomodoroModal logs actual time through localized notice path', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const file = { extension: 'md' };
  let processed = false;
  const app = { vault: { getAbstractFileByPath: () => file, process: async (_file: unknown, update: (content: string) => string) => { processed = true; update('- [ ] Focus task'); } } };
  const modal = new PomodoroModal(app as never, { ...DEFAULT_SETTINGS, pomodoroLogActualTime: true }, createMockTask({ filePath: 'Tasks.md', lineNumber: 1, normalizedText: 'Focus task' }) as never, {} as never);
  modal.open();
  context.after(() => modal.close());
  Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '⏭ Skip')?.click();
  await Promise.resolve();
  assert.equal(processed, true);
});

test('PomodoroModal onClose clears the interval id after stopping the timer', () => {
  const modal = new PomodoroModal({} as never, {} as never, { normalizedText: 'Task' } as never, {} as never);
  (modal as any).contentEl = new FakeDOMElement('div');
  (modal as any).intervalId = 42;

  const originalWindow = (globalThis as any).window;
  const cleared: number[] = [];
  (globalThis as any).window = {
    clearInterval: (id: number) => {
      cleared.push(id);
    },
  };

  try {
    modal.onClose();
    assert.deepEqual(cleared, [42]);
    assert.equal((modal as any).intervalId, null, 'closing should reset timer state so reopening shows Start instead of Pause');
  } finally {
    (globalThis as any).window = originalWindow;
  }
});
