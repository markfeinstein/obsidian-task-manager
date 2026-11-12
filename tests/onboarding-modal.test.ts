import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { App } from 'obsidian';
import {
  ONBOARDING_QUERY_SNIPPET,
  ONBOARDING_VERSION,
  OnboardingModal,
  shouldAutoOpenOnboarding,
  type OnboardingActions,
} from '../src/modals/onboarding-modal';
import { setTestLocale } from '../src/i18n';
import { installDomHarness } from './dom-harness';

const flush = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function appStub(): App {
  return {} as App;
}

function openInDocument(modal: OnboardingModal, document: Document): HTMLElement {
  const content = document.createElement('div');
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();
  document.body.appendChild(content);
  return content;
}

test('onboarding eligibility is limited to genuinely unseen profiles and one attempt per load', () => {
  assert.equal(ONBOARDING_VERSION, 1);
  assert.equal(shouldAutoOpenOnboarding(true, 0, false), true);
  assert.equal(shouldAutoOpenOnboarding(true, 0, true), false);
  assert.equal(shouldAutoOpenOnboarding(true, ONBOARDING_VERSION, false), false);
  assert.equal(shouldAutoOpenOnboarding(false, 0, false), false);
});

test('onboarding keeps a stable shell, focuses headings, and invokes only supplied local actions', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const calls: string[] = [];
  let persisted = 0;
  const actions: OnboardingActions = {
    createFirstTask: () => { calls.push('task'); },
    openTaskPanel: () => { calls.push('panel'); },
    insertOrCopyQuery: () => { calls.push('query'); return 'copied'; },
    persistSeen: () => { persisted += 1; },
  };
  const modal = new OnboardingModal(appStub(), actions);
  const content = openInDocument(modal, harness.document);

  const status = content.querySelector<HTMLElement>('.task-manager-onboarding-status');
  const heading = content.querySelector<HTMLElement>('.task-manager-onboarding-heading');
  const panel = content.querySelector<HTMLElement>('.task-manager-onboarding-panel');
  const navigation = content.querySelector<HTMLElement>('.task-manager-onboarding-navigation');
  assert.ok(status && heading && panel && navigation);
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.textContent, 'Step 1 of 3');
  assert.equal(heading.tabIndex, -1);

  panel.querySelector<HTMLButtonElement>('.task-manager-onboarding-action')?.click();
  await flush();
  assert.deepEqual(calls, ['task']);
  assert.equal(status.textContent, 'Local task capture opened.');

  let navButtons = Array.from(navigation.querySelectorAll<HTMLButtonElement>('button'));
  navButtons[1].click();
  await flush();
  assert.equal(content.querySelector('.task-manager-onboarding-status'), status);
  assert.equal(content.querySelector('.task-manager-onboarding-heading'), heading);
  assert.equal(content.querySelector('.task-manager-onboarding-panel'), panel);
  assert.equal(content.querySelector('.task-manager-onboarding-navigation'), navigation);
  assert.equal(status.textContent, 'Step 2 of 3');
  assert.equal(harness.document.activeElement, heading);
  panel.querySelector<HTMLButtonElement>('.task-manager-onboarding-action')?.click();
  await flush();
  assert.deepEqual(calls, ['task', 'panel']);

  navButtons = Array.from(navigation.querySelectorAll<HTMLButtonElement>('button'));
  navButtons[1].click();
  await flush();
  panel.querySelector<HTMLButtonElement>('.task-manager-onboarding-action')?.click();
  await flush();
  assert.deepEqual(calls, ['task', 'panel', 'query']);
  assert.equal(status.textContent, 'Task query copied to the clipboard.');
  assert.equal(persisted, 0);

  const allButtons = Array.from(content.querySelectorAll<HTMLButtonElement>('button'));
  assert.ok(allButtons.every((button) => button.type === 'button' && Boolean(button.textContent?.trim())));
  allButtons.find((button) => button.textContent === 'Remind me later')?.click();
  assert.equal(persisted, 0, 'remind later never persists completion');
});

test('onboarding dismissal and finish persist, while the query snippet stays local and safe', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  let persisted = 0;
  const actions: OnboardingActions = {
    createFirstTask: () => undefined,
    openTaskPanel: () => undefined,
    insertOrCopyQuery: () => 'inserted',
    persistSeen: () => { persisted += 1; },
  };
  const dismissed = new OnboardingModal(appStub(), actions);
  const dismissedContent = openInDocument(dismissed, harness.document);
  dismissedContent.querySelectorAll<HTMLButtonElement>('.task-manager-onboarding-dismissal button')[1].click();
  await flush();
  assert.equal(persisted, 1);

  const finished = new OnboardingModal(appStub(), actions);
  const finishedContent = openInDocument(finished, harness.document);
  const next = (): HTMLButtonElement => finishedContent.querySelectorAll<HTMLButtonElement>('.task-manager-onboarding-navigation button')[1];
  next().click();
  await flush();
  next().click();
  await flush();
  next().click();
  await flush();
  assert.equal(persisted, 2);
  assert.equal(ONBOARDING_QUERY_SNIPPET, '```task-list\nnot done\n```');
  const source = readFileSync('src/modals/onboarding-modal.ts', 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|requestUrl|XMLHttpRequest|WebSocket)\s*\(/u);
});

test('onboarding root supports test RTL and expanded pseudo-locales without changing control order', (context) => {
  const harness = installDomHarness();
  context.after(() => { setTestLocale(null); harness.cleanup(); });
  const actions: OnboardingActions = {
    createFirstTask: () => undefined,
    openTaskPanel: () => undefined,
    insertOrCopyQuery: () => 'inserted',
    persistSeen: () => undefined,
  };
  setTestLocale('rtl');
  const rtl = new OnboardingModal(appStub(), actions);
  const rtlContent = openInDocument(rtl, harness.document);
  assert.equal(rtlContent.getAttribute('dir'), 'rtl');
  assert.equal(rtlContent.getAttribute('lang'), 'qps-rtl');
  const rtlOrder = Array.from(rtlContent.querySelectorAll('button')).map((button) => button.className);
  rtl.close();

  setTestLocale('expanded');
  const expanded = new OnboardingModal(appStub(), actions);
  const expandedContent = openInDocument(expanded, harness.document);
  assert.equal(expandedContent.getAttribute('lang'), 'qps-ploc');
  assert.match(expandedContent.textContent ?? '', /［!!/u);
  assert.deepEqual(Array.from(expandedContent.querySelectorAll('button')).map((button) => button.className), rtlOrder);
});
