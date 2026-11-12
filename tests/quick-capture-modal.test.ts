import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleCalendarQuickCaptureModal, QuickAddTaskModal, QuickCaptureModal } from '../src/modals/quick-capture-modal';
import { DEFAULT_SETTINGS } from '../src/types';
import { FakeDOMElement } from './test-utils';
import { installDomHarness } from './dom-harness';

test('QuickAddTaskModal rejects input that only contains metadata tokens', () => {
  const modal = new QuickAddTaskModal({} as never, DEFAULT_SETTINGS, () => {});

  assert.equal((modal as any).parseToTaskLine('#work tomorrow'), '');
  assert.equal((modal as any).parseToTaskLine('tomorrow #work high priority'), '');
});

test('QuickAddTaskModal preview stays empty until a real description is provided', () => {
  const modal = new QuickAddTaskModal({} as never, DEFAULT_SETTINGS, () => {});
  const previewEl = new FakeDOMElement('div');
  (modal as any).previewEl = previewEl as unknown as HTMLElement;

  (modal as any).updatePreview('#work tomorrow');
  assert.equal(previewEl.text, '(enter task text above)');

  (modal as any).updatePreview('Write docs tomorrow #work');
  assert.match(previewEl.getInnerText(), /Write docs/u);
});

test('QuickAddTaskModal exposes a labelled polite atomic parsed preview', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const modal = new QuickAddTaskModal({} as never, DEFAULT_SETTINGS, () => undefined);
  modal.open();
  context.after(() => modal.close());
  const preview = modal.contentEl.querySelector<HTMLElement>('.task-manager-quick-add-preview');
  const input = modal.contentEl.querySelector<HTMLInputElement>('.task-manager-quick-add-input');
  assert.ok(preview && input);
  const headingId = preview.getAttribute('aria-labelledby');
  assert.equal(preview.getAttribute('role'), 'region');
  assert.equal(preview.getAttribute('aria-live'), 'polite');
  assert.equal(preview.getAttribute('aria-atomic'), 'true');
  assert.equal(headingId ? modal.contentEl.querySelector(`#${headingId}`)?.textContent : '', 'Parsed task preview');
  input.value = 'Write docs tomorrow #work';
  input.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  await new Promise<void>((resolve) => { setTimeout(resolve, 140); });
  assert.match(preview.textContent ?? '', /Write docs/u);
});

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

test('async quick-capture variants are single-flight until persistence settles', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const cases = [
    {
      create: (capture: (line: string) => Promise<void>) => new QuickCaptureModal({} as never, DEFAULT_SETTINGS, capture),
      input: '.modal-content input',
      value: 'Write release notes',
      submit: 'Capture',
    },
    {
      create: (capture: (line: string) => Promise<void>) => new GoogleCalendarQuickCaptureModal({} as never, DEFAULT_SETTINGS, capture),
      input: '.task-manager-quick-add-input',
      value: 'tomorrow review release',
      submit: 'Add task',
    },
  ];

  for (const entry of cases) {
    const pending = deferred();
    const captured: string[] = [];
    const modal = entry.create(async (line) => { captured.push(line); await pending.promise; });
    modal.open();
    const input = modal.modalEl.querySelector<HTMLInputElement>(entry.input);
    assert.ok(input);
    input.value = entry.value;
    (input as HTMLInputElement & { _onChange?: (value: string) => void })._onChange?.(entry.value);
    const buttons = Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>('button'));
    const submit = buttons.find((button) => button.textContent === entry.submit);
    const cancel = buttons.find((button) => button.textContent === 'Cancel');
    assert.ok(submit);
    assert.ok(cancel);
    submit.click();
    submit.click();
    modal.contentEl.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    assert.equal(captured.length, 1, entry.submit);
    assert.equal(modal.contentEl.getAttribute('aria-busy'), 'true');
    assert.equal(submit.disabled, true);
    assert.equal(cancel.disabled, true);
    pending.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((modal as unknown as { _open: boolean })._open, false);
  }
});

test('QuickCaptureModal marks and focuses an empty description inline', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const captured: string[] = [];
  const modal = new QuickCaptureModal({} as never, DEFAULT_SETTINGS, async (line) => { captured.push(line); });
  modal.open();
  const description = modal.contentEl.querySelector<HTMLInputElement>('input');
  const submit = Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Capture');
  const status = modal.contentEl.querySelector<HTMLElement>('.task-manager-quick-capture-status');
  assert.ok(description && submit && status);

  submit.click();
  await Promise.resolve();

  assert.deepEqual(captured, []);
  assert.equal(description.getAttribute('aria-invalid'), 'true');
  assert.equal(description.getAttribute('aria-errormessage'), status.id);
  assert.equal(harness.document.activeElement, description);
  assert.match(status.textContent ?? '', /Description/u);

  (description as HTMLInputElement & { _onChange?: (value: string) => void })._onChange?.('Ship release');
  assert.equal(description.getAttribute('aria-invalid'), null);
});

test('QuickCaptureModal blocks invalid due text and previews normalized dates', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const captured: string[] = [];
  const modal = new QuickCaptureModal({} as never, DEFAULT_SETTINGS, async (line) => { captured.push(line); });
  modal.open();
  const inputs = Array.from(modal.contentEl.querySelectorAll<HTMLInputElement>('input'));
  const [description, due] = inputs;
  const submit = Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Capture');
  const feedback = modal.contentEl.querySelector<HTMLElement>('.task-manager-quick-capture-due-feedback');
  assert.ok(description && due && submit && feedback);
  (description as HTMLInputElement & { _onChange?: (value: string) => void })._onChange?.('Ship release');
  description.value = 'Ship release';
  (due as HTMLInputElement & { _onChange?: (value: string) => void })._onChange?.('next Funday');
  submit.click();
  await Promise.resolve();
  assert.deepEqual(captured, []);
  assert.equal(due.getAttribute('aria-invalid'), 'true');
  assert.equal(harness.document.activeElement, due);
  assert.match(feedback.textContent ?? '', /supported date/u);

  (due as HTMLInputElement & { _onChange?: (value: string) => void })._onChange?.('tomorrow');
  assert.equal(due.getAttribute('aria-invalid'), null);
  assert.match(feedback.textContent ?? '', /saved as \d{4}-\d{2}-\d{2}/u);
  submit.click();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(captured.length, 1);
  assert.match(captured[0], /📅 \d{4}-\d{2}-\d{2}/u);
});

test('QuickCaptureModal keeps its single-flight lock across close and reopen', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const first = deferred();
  let calls = 0;
  const modal = new QuickCaptureModal({} as never, DEFAULT_SETTINGS, async () => {
    calls += 1;
    if (calls === 1) await first.promise;
  });
  modal.open();
  const firstInput = modal.modalEl.querySelector<HTMLInputElement>('input');
  assert.ok(firstInput);
  firstInput.value = 'First capture';
  (firstInput as HTMLInputElement & { _onChange?: (value: string) => void })._onChange?.(firstInput.value);
  Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Capture')?.click();
  await Promise.resolve();
  assert.equal(calls, 1);

  modal.close();
  modal.open();
  const reopenedInput = modal.modalEl.querySelector<HTMLInputElement>('input');
  const reopenedSubmit = Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.startsWith('Capture'));
  assert.ok(reopenedInput && reopenedSubmit);
  reopenedInput.value = 'Second capture';
  (reopenedInput as HTMLInputElement & { _onChange?: (value: string) => void })._onChange?.(reopenedInput.value);
  assert.equal(reopenedSubmit.disabled, true, 'reopening cannot clear an in-flight capture lock');
  reopenedSubmit.click();
  assert.equal(calls, 1);

  first.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((modal as unknown as { _open: boolean })._open, true, 'the old completion must not close the reopened modal');
  assert.equal(reopenedSubmit.disabled, false);
  reopenedSubmit.click();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

test('QuickCaptureModal preserves its draft and exposes a retry after persistence failure', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const modal = new QuickCaptureModal({} as never, DEFAULT_SETTINGS, async () => {
    calls += 1;
    await (calls === 1 ? first.promise : second.promise);
  });
  modal.open();
  const input = modal.modalEl.querySelector<HTMLInputElement>('input');
  assert.ok(input);
  input.value = 'Keep this draft';
  (input as HTMLInputElement & { _onChange?: (value: string) => void })._onChange?.(input.value);
  const submit = Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Capture');
  assert.ok(submit);
  submit.click();
  first.reject(new Error('vault unavailable'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((modal as unknown as { _open: boolean })._open, true);
  assert.equal(input.value, 'Keep this draft');
  assert.equal(modal.contentEl.getAttribute('aria-busy'), null);
  assert.match(modal.contentEl.querySelector('.task-manager-quick-capture-status')?.textContent ?? '', /vault unavailable/u);
  assert.equal(harness.document.activeElement, submit);
  submit.click();
  second.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal((modal as unknown as { _open: boolean })._open, false);
});
