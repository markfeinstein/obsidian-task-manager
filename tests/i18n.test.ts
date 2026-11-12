import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAvailableLocales,
  getCoreTranslationCoverage,
  getLocale,
  getLocaleMetadata,
  isLocaleCoreComplete,
  LOCALIZED_CORE_KEYS,
  pseudoLocalize,
  setLocale,
  setTestLocale,
  t,
} from '../src/i18n';
import { applyLocaleScope, TASK_MANAGER_LOCALE_ATTRIBUTE } from '../src/locale-scope';
import { resolveFloatingPosition } from '../src/floating-position';
import { installDomHarness } from './dom-harness';

void test('i18n: only 100% core-complete catalogues are selectable', () => {
  const locales = getAvailableLocales();
  assert.deepEqual(locales, ['en']);
  assert.ok(LOCALIZED_CORE_KEYS.size >= 80);
  for (const locale of locales) {
    assert.equal(isLocaleCoreComplete(locale), true);
    assert.equal(getCoreTranslationCoverage(locale), 100);
  }
  assert.equal(isLocaleCoreComplete('de'), false, 'partial catalogues remain available to translators but not users');
});

void test('i18n: unavailable exact, region, and prefix requests fail closed to English', () => {
  for (const locale of ['de', 'pt-BR', 'pt-br', 'PT-BR', 'pt', 'zh-TW', 'xx-YY']) {
    setLocale(locale);
    assert.equal(getLocale(), 'en', locale);
  }
  setLocale('en');
  assert.equal(getLocale(), 'en');
});

void test('i18n: pseudo-localization expands text and preserves placeholders', () => {
  const original = 'Save {{count}} tasks';
  const pseudo = pseudoLocalize(original);
  assert.ok(pseudo.length >= original.length * 1.3);
  assert.match(pseudo, /\{\{count\}\}/u);
  assert.match(pseudo, /［!!/u);
  setTestLocale('expanded');
  assert.match(t('weeklyReview.progress', { current: 1, total: 3 }), /1/u);
  setTestLocale(null);
  assert.equal(t('pomodoro.roundInfo', { round: 2, work: 25, break: 5 }), 'Round 2 · 25m work / 5m break');
});

void test('i18n: locale scope updates plugin roots without mutating the host root', (context) => {
  const harness = installDomHarness();
  context.after(() => { setTestLocale(null); harness.cleanup(); });
  const hostDirection = harness.document.documentElement.getAttribute('dir');
  const root = harness.document.createElement('section');
  harness.document.body.appendChild(root);
  const dispose = applyLocaleScope(root);
  context.after(dispose);
  assert.equal(root.getAttribute('lang'), 'en');
  assert.equal(root.getAttribute('dir'), 'ltr');
  setTestLocale('rtl');
  assert.deepEqual(getLocaleMetadata(), { tag: 'qps-rtl', direction: 'rtl' });
  assert.equal(root.getAttribute('lang'), 'qps-rtl');
  assert.equal(root.getAttribute('dir'), 'rtl');
  assert.equal(root.getAttribute(TASK_MANAGER_LOCALE_ATTRIBUTE), 'qps-rtl');
  assert.equal(harness.document.documentElement.getAttribute('dir'), hostDirection);
});

void test('floating placement flips and clamps on inline and block overflow', () => {
  const viewport = { left: 0, top: 0, width: 100, height: 100 };
  assert.deepEqual(resolveFloatingPosition(
    { left: 90, top: 85, width: 10, height: 10 },
    { width: 30, height: 20 }, viewport, 'ltr', 4,
  ), { inlineStart: 70, blockStart: 61, inlineSide: 'end', blockSide: 'before' });
  assert.deepEqual(resolveFloatingPosition(
    { left: -5, top: -5, width: 10, height: 10 },
    { width: 120, height: 120 }, viewport, 'rtl', 4,
  ), { inlineStart: 0, blockStart: 0, inlineSide: 'start', blockSide: 'after' });
});
