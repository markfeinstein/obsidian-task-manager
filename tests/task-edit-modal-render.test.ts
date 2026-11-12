import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile, type App } from 'obsidian';
import { TaskEditModal } from '../src/modals/task-edit-modal';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHarness } from './dom-harness';

test('task edit modal renders, scopes locale, submits, and cleans up', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = {
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getFileCache: () => undefined },
  } as unknown as App;
  let submitted = '';
  const modal = new TaskEditModal(app, structuredClone(DEFAULT_SETTINGS), '- [ ] Ship release 📅 2026-07-20 #work', (line) => { submitted = line; });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();
  assert.equal(modal.contentEl.getAttribute('lang'), 'en');
  assert.equal(modal.modalEl.getAttribute('role'), 'dialog');
  assert.ok(modal.contentEl.querySelectorAll('input, textarea, select, button').length > 0);
  const description = modal.contentEl.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(description);
  description.value = 'Ship reviewed release';
  const save = Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /apply|save|update|create/iu.test(button.textContent ?? ''));
  assert.ok(save);
  save.click();
  assert.match(submitted, /Ship reviewed release/u);
  modal.onClose();
  assert.equal(modal.contentEl.children.length, 0);
});

test('task edit modal covers hidden auto-revealed fields and autocomplete keyboard paths', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const note = { path: 'Projects/Plan.md', basename: 'Plan', extension: 'md' };
  const app = {
    vault: { getMarkdownFiles: () => [note], getAbstractFileByPath: () => null },
    metadataCache: { getFileCache: () => ({ tags: [{ tag: '#work' }] }) },
  } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  for (const key of Object.keys(settings.modalFields) as Array<keyof typeof settings.modalFields>) settings.modalFields[key] = false;
  const modal = new TaskEditModal(app, settings, '', () => undefined, undefined, {
    description: 'Plan work', checkbox: 'x', priority: 'high', due: '2026-07-20', scheduled: '2026-07-19', start: '2026-07-18',
    created: '2026-07-01', done: '2026-07-21', cancelled: '2026-07-22', recurrence: 'every week', id: 'task-id',
    dependsOn: 'dep', effort: '2h', actual: '1h', followUp: '2026-07-25', onCompletion: 'archive', reminder: '2026-07-20', time: '09:00',
  });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  const internals = modal as unknown as { shouldShowField(key: string, hasValue: boolean): boolean };
  assert.equal(internals.shouldShowField('dueDate', false), false);
  assert.equal(internals.shouldShowField('dueDate', true), true);
  modal.onOpen();
  assert.ok(contentEl.querySelectorAll('.task-manager-auto-reveal-indicator').length > 0);
  const showAll = contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]') as (HTMLInputElement & { _onChange?: (value: boolean) => void });
  showAll?._onChange?.(true);
  const description = contentEl.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(description);
  description.value = 'No suggestion trigger';
  description.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  description.value = 'See [[Pl';
  description.selectionStart = description.selectionEnd = description.value.length;
  description.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  assert.ok(contentEl.querySelector('.tm-ac-dropdown'));
  description.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(contentEl.querySelector('.tm-ac-dropdown'), null);
  description.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  description.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  description.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  description.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.match(description.value, /\[\[Plan\]\]/u);
  description.value = 'Tag #missing';
  description.selectionStart = description.selectionEnd = description.value.length;
  description.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  assert.equal(contentEl.querySelector('.tm-ac-dropdown'), null);
  description.value = 'Tag #wo';
  description.selectionStart = description.selectionEnd = description.value.length;
  description.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  contentEl.querySelector<HTMLElement>('.tm-ac-item')?.dispatchEvent(new harness.window.MouseEvent('mouseenter', { bubbles: true }));
  contentEl.querySelector<HTMLElement>('.tm-ac-item')?.click();
  assert.match(description.value, /#work/u);
  modal.onClose();
});

test('task edit modal resolves file-default branches and template tokens', () => {
  const file = Object.assign(Object.create(TFile.prototype) as TFile, {
    path: 'Projects/Plan.md', basename: 'Plan', name: 'Plan.md', extension: 'md', parent: { name: 'Projects' },
  });
  let resolvedFile: unknown = file;
  let frontmatter: Record<string, unknown> | undefined = { task_due: '{{date}}', task_scheduled: '2026-07-20', task_priority: 'HIGH', task_tags: ['#work', '{{filename}}', '{{folder}}', '{{path}}'] };
  const app = { vault: { getAbstractFileByPath: () => resolvedFile }, metadataCache: { getFileCache: () => frontmatter ? ({ frontmatter }) : undefined } } as unknown as App;
  const settings = { ...structuredClone(DEFAULT_SETTINGS), fileDefaultsEnabled: true };
  const modal = new TaskEditModal(app, settings, '', () => undefined, undefined, {}, file.path);
  const internals = modal as unknown as { loadFileDefaults(path: string): Record<string, unknown>; applyAccessKey(el: HTMLElement, key?: string): void };
  const defaults = internals.loadFileDefaults(file.path);
  assert.equal(defaults.priority, 'high');
  assert.equal(defaults.scheduled, '2026-07-20');
  assert.deepEqual(defaults.tags, ['work', 'Plan', 'Projects', 'Projects/Plan.md']);
  frontmatter = { task_due: 20260720, task_priority: 'urgent', task_tags: 'one, #two' };
  const alternate = internals.loadFileDefaults(file.path);
  assert.equal(alternate.due, '20260720');
  assert.equal(alternate.priority, undefined);
  assert.deepEqual(alternate.tags, ['one', 'two']);
  frontmatter = undefined;
  assert.deepEqual(internals.loadFileDefaults(file.path), {});
  resolvedFile = {};
  assert.deepEqual(internals.loadFileDefaults(file.path), {});
  resolvedFile = file;
  settings.fileDefaultsEnabled = false;
  assert.deepEqual(internals.loadFileDefaults(file.path), {});
  settings.fileDefaultsEnabled = true;
  const element = { accessKey: '' } as HTMLElement;
  settings.provideAccessKeys = true;
  internals.applyAccessKey(element, 'x');
  assert.equal(element.accessKey, 'x');
  settings.provideAccessKeys = false;
  internals.applyAccessKey(element, 'y');
  assert.equal(element.accessKey, 'x');
});

test('task edit modal show-all mode exercises empty, valid, and invalid field branches', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  for (const key of Object.keys(settings.modalFields) as Array<keyof typeof settings.modalFields>) settings.modalFields[key] = false;
  const modal = new TaskEditModal(app, settings, '', () => undefined);
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl, showAllFields: true });
  harness.document.body.appendChild(modalEl);
  const internals = modal as unknown as { shouldShowField(key: string, hasValue: boolean): boolean };
  assert.equal(internals.shouldShowField('dueDate', false), true);
  modal.onOpen();
  const fieldsButton = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /Fields/u.test(button.textContent ?? ''));
  fieldsButton?.click();
  const child = harness.document.querySelector<HTMLElement>('.task-manager-visible-fields-modal');
  assert.ok(child);
  for (const toggle of Array.from(child.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) as Array<HTMLInputElement & { _onChange?: (value: boolean) => void }>) {
    toggle._onChange?.(true);
    toggle._onChange?.(false);
  }
  Array.from(child.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')?.click();
  for (const input of Array.from(contentEl.querySelectorAll<HTMLInputElement>('input'))) {
    if (input.type === 'checkbox') input.checked = !input.checked;
    else input.value = input.type === 'date' ? '2026-07-20' : '2';
    input.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    input.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    input.dispatchEvent(new harness.window.Event('blur', { bubbles: true }));
  }
  const textInputs = Array.from(contentEl.querySelectorAll<HTMLInputElement>('input:not([type="date"]):not([type="checkbox"])'));
  for (const [index, input] of textInputs.slice(0, 3).entries()) {
    input.value = index === 0 ? 'tomorrow' : index === 1 ? '2026-02-30' : '';
    input.dispatchEvent(new harness.window.Event('blur', { bubbles: true }));
    input.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  }
  for (const select of Array.from(contentEl.querySelectorAll<HTMLSelectElement>('select'))) {
    if (select.options.length > 1) select.selectedIndex = 1;
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  }
  contentEl.querySelector<HTMLButtonElement>('.task-manager-recurrence-pattern-button')?.click();
  const description = contentEl.querySelector<HTMLTextAreaElement>('textarea');
  if (description) description.value = '';
  const apply = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /apply/iu.test(button.textContent ?? ''));
  apply?.click();
  modal.onClose();
});

test('task edit keeps one shell and draft while optional fields rerender', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  const modal = new TaskEditModal(app, settings, '- [ ] Keep me 📅 2026-07-20', () => undefined);
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();
  const form = contentEl.querySelector('form');
  const description = contentEl.querySelector<HTMLTextAreaElement>('textarea');
  const status = contentEl.querySelector<HTMLSelectElement>('select.task-manager-modal-status');
  const fields = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /Fields/u.test(button.textContent ?? ''));
  const footer = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /apply/iu.test(button.textContent ?? ''))?.parentElement;
  const showAll = contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement & { _onChange?: (value: boolean) => void };
  assert.ok(form && description && status && fields && footer && showAll);
  description.value = 'Latest description';
  description.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  showAll.focus();
  for (let index = 0; index < 5; index += 1) showAll._onChange?.(index % 2 === 0);
  assert.equal(contentEl.querySelector('form'), form);
  assert.equal(contentEl.querySelector('textarea'), description);
  assert.equal(contentEl.querySelector('select.task-manager-modal-status'), status);
  assert.equal(Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /Fields/u.test(button.textContent ?? '')), fields);
  assert.equal(Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /apply/iu.test(button.textContent ?? ''))?.parentElement, footer);
  assert.equal(harness.document.activeElement, showAll);
  assert.equal(description.value, 'Latest description');
  modal.onClose();
});

test('task edit uses one submit path, blocks duplicate submit, and removes listeners on close', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  let submits = 0;
  let output = '';
  const modal = new TaskEditModal(app, structuredClone(DEFAULT_SETTINGS), '- [ ] Original', (line) => { submits += 1; output = line; });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();
  const form = contentEl.querySelector<HTMLFormElement>('form');
  const description = contentEl.querySelector<HTMLTextAreaElement>('textarea');
  const status = contentEl.querySelector<HTMLSelectElement>('select.task-manager-modal-status');
  assert.ok(form && description && status);
  description.value = 'Newest value';
  description.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  description.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(submits, 0, 'Enter in Description remains a newline path');
  status.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  status.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(submits, 1);
  assert.match(output, /Newest value/u);
  form.dispatchEvent(new harness.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(submits, 1, 'retained nodes cannot submit after close');
});

test('task edit awaits persistence, blocks dismissal in flight, and preserves the draft after failure', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  let rejectSubmission: ((error: Error) => void) | undefined;
  let waitForFailure = true;
  let attempts = 0;
  let cancels = 0;
  const modal = new TaskEditModal(app, structuredClone(DEFAULT_SETTINGS), '- [ ] Original', async () => {
    attempts += 1;
    if (!waitForFailure) return;
    await new Promise<void>((_resolve, reject) => { rejectSubmission = reject; });
  }, () => { cancels += 1; });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();
  const form = contentEl.querySelector<HTMLFormElement>('form');
  const description = contentEl.querySelector<HTMLTextAreaElement>('textarea');
  const apply = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /apply/iu.test(button.textContent ?? ''));
  const cancel = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /cancel/iu.test(button.textContent ?? ''));
  assert.ok(form && description && apply && cancel);
  description.value = 'Preserve this draft';
  description.dispatchEvent(new harness.window.Event('input', { bubbles: true }));

  apply.click();
  assert.equal(attempts, 1);
  assert.equal(form.getAttribute('aria-busy'), 'true');
  assert.equal(apply.disabled, true);
  assert.equal(cancel.disabled, true);
  modal.close();
  assert.ok(contentEl.querySelector('form'), 'normal dismissal must be blocked while persistence is pending');
  assert.equal(cancels, 0);

  rejectSubmission?.(new Error('simulated write failure'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const error = contentEl.querySelector<HTMLElement>('.task-manager-task-edit-error');
  assert.ok(error);
  assert.match(error.textContent ?? '', /simulated write failure/u);
  assert.equal(error.hidden, false);
  assert.equal(harness.document.activeElement, error);
  assert.equal(description.value, 'Preserve this draft');
  assert.equal(form.hasAttribute('aria-busy'), false);
  assert.equal(apply.disabled, false);
  assert.equal(cancel.disabled, false);
  assert.equal(cancels, 0);

  waitForFailure = false;
  apply.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2);
  assert.equal(contentEl.children.length, 0, 'the modal closes only after persistence succeeds');
  assert.equal(cancels, 0, 'successful submission must not report cancellation');
});

test('task edit preserves the draft when a synchronous caller refuses submission', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  const modal = new TaskEditModal(app, structuredClone(DEFAULT_SETTINGS), '- [ ] Original', () => {
    throw new Error('synchronous refusal');
  });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();
  const description = contentEl.querySelector<HTMLTextAreaElement>('textarea');
  const apply = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /apply/iu.test(button.textContent ?? ''));
  assert.ok(description && apply);
  description.value = 'Retained synchronous draft';
  description.dispatchEvent(new harness.window.Event('input', { bubbles: true }));

  apply.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(contentEl.querySelector('form'));
  assert.equal(description.value, 'Retained synchronous draft');
  assert.match(contentEl.querySelector('.task-manager-task-edit-error')?.textContent ?? '', /synchronous refusal/u);
  modal.onClose();
});

test('task edit reports generic dismissal as cancellation exactly once', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  let cancels = 0;
  const modal = new TaskEditModal(app, structuredClone(DEFAULT_SETTINGS), '- [ ] Original', () => undefined, () => { cancels += 1; });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();

  modal.close();
  assert.equal(cancels, 1, 'Escape/X-style close must settle the cancellation callback');
  modal.onClose();
  assert.equal(cancels, 1, 'repeated host cleanup must not settle cancellation twice');
});

test('task edit validation focuses the current field and later valid submit succeeds once', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  let submits = 0;
  const modal = new TaskEditModal(app, settings, '- [ ] Recurring', () => { submits += 1; });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl, showAllFields: true });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();
  const recurrence = contentEl.querySelector<HTMLInputElement>('[data-field-key="recurrence"]');
  const due = contentEl.querySelector<HTMLInputElement>('[data-field-key="due"]');
  assert.ok(recurrence && due);
  recurrence.value = 'every week';
  recurrence.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  recurrence.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(submits, 0);
  assert.equal(harness.document.activeElement, recurrence);
  due.value = '2026-07-20';
  due.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  recurrence.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(submits, 1);
});

test('task edit blocks parser-invisible metadata in its associated alert region', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  let submits = 0;
  const modal = new TaskEditModal(app, structuredClone(DEFAULT_SETTINGS), '- [ ] Validate me', () => { submits += 1; });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl, showAllFields: true });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();
  const id = contentEl.querySelector<HTMLInputElement>('[data-field-key="id"]');
  const apply = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /apply/iu.test(button.textContent ?? ''));
  assert.ok(id && apply);
  id.value = 'not parser visible';
  id.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  apply.click();
  assert.equal(submits, 0);
  assert.equal(id.getAttribute('aria-invalid'), 'true');
  const errorId = id.getAttribute('aria-errormessage');
  assert.match(errorId ? contentEl.querySelector<HTMLElement>(`#${errorId}`)?.textContent ?? '' : '', /task ID/u);
  assert.equal(harness.document.activeElement, id);
});

test('task edit omits nonfunctional recurrence scope controls and preserves the series ID on submit', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  let submitted = '';
  const modal = new TaskEditModal(app, structuredClone(DEFAULT_SETTINGS), '- [ ] Repeat 🔁 every week 📅 2026-07-20 [recurrenceSeriesId:: abc123]', (line) => { submitted = line; });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(modal, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  modal.onOpen();
  assert.equal(contentEl.querySelector('.task-manager-edit-scope'), null);
  assert.equal(Array.from(contentEl.querySelectorAll<HTMLInputElement>('input[type="radio"]')).some((radio) => radio.name === 'edit-scope'), false);
  const apply = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /apply/iu.test(button.textContent ?? ''));
  assert.ok(apply);
  apply.click();
  assert.match(submitted, /\[recurrenceSeriesId:: abc123\]/u);
});
