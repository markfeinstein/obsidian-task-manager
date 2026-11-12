import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const css = readFileSync('styles/80-dashboard.css', 'utf8');
const densityStart = css.indexOf('/* Density */');
assert.ok(densityStart > 0, 'dashboard defaults must precede density overrides');

function fixture(context) {
  const dom = new JSDOM('<main class="tm-dash"></main><section class="modal tm-dash-widget-picker-modal"></section><section class="modal tm-dash-template-picker-modal"></section><section class="modal unrelated-modal"></section>');
  context.after(() => dom.window.close());
  const style = dom.window.document.createElement('style');
  style.textContent = css.slice(0, densityStart);
  dom.window.document.head.append(style);
  return { window: dom.window, rule: style.sheet.cssRules[0] };
}

test('dashboard picker modals have token defaults outside the dashboard subtree', (context) => {
  const { window } = fixture(context);
  for (const selector of ['.tm-dash-widget-picker-modal', '.tm-dash-template-picker-modal']) {
    const modal = window.document.querySelector(selector);
    assert.equal(modal.closest('.tm-dash'), null);
    const computed = window.getComputedStyle(modal);
    for (const token of ['--tm-s4', '--tm-s8', '--tm-font-xs', '--tm-preview-rail', '--tm-radius-card', '--tm-dash-card-bg']) {
      assert.notEqual(computed.getPropertyValue(token), '', `${selector} must define ${token}`);
    }
  }
});

test('shared dashboard defaults contain only custom properties and do not leak to unrelated modals', (context) => {
  const { window, rule } = fixture(context);
  assert.ok(rule.style.length > 0);
  for (const property of Array.from(rule.style)) {
    assert.ok(property.startsWith('--tm-'), `layout property ${property} must not enter the shared token rule`);
  }
  const unrelated = window.document.querySelector('.unrelated-modal');
  assert.equal(unrelated.matches(rule.selectorText), false);
  assert.equal(window.getComputedStyle(unrelated).getPropertyValue('--tm-s4'), '');
});

test('dashboard flex layout stays on the dashboard rather than its picker modals', (context) => {
  const { window } = fixture(context);
  const dashboard = window.document.querySelector('.tm-dash');
  assert.equal(window.getComputedStyle(dashboard).display, 'flex');
  assert.equal(window.getComputedStyle(dashboard).height, '100%');
  for (const modal of window.document.querySelectorAll('.modal')) {
    assert.notEqual(window.getComputedStyle(modal).display, 'flex');
    assert.notEqual(window.getComputedStyle(modal).height, '100%');
  }
});

test('picker controls override native nowrap and search padding without changing unrelated controls', (context) => {
  const { window } = new JSDOM('<section class="tm-dash-widget-picker"><button class="tm-dash-widget-option">Widget description</button><input type="search" class="tm-dash-widget-picker-input"></section><button class="unrelated">Other</button><input type="search" class="unrelated">');
  context.after(() => window.close());
  const rules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/gu)]
    .filter(([, selector]) => selector.includes('.tm-dash-widget-picker-input') || selector.trim() === '.tm-dash-widget-option')
    .map(([rule]) => rule);
  assert.equal(rules.length, 2);
  // JSDOM does not fully model selector specificity; require the scoped override too.
  assert.match(rules.find(rule => rule.includes('.tm-dash-widget-picker-input')), /\.tm-dash-widget-picker\s+\.tm-dash-widget-picker-input\s*\{/u);
  const style = window.document.createElement('style');
  style.textContent = `button { white-space: nowrap; } input[type="search"] { padding-left: 8px; } ${rules.join('\n')}`;
  window.document.head.append(style);
  assert.equal(window.getComputedStyle(window.document.querySelector('.tm-dash-widget-option')).whiteSpace, 'normal');
  assert.equal(window.getComputedStyle(window.document.querySelector('.tm-dash-widget-picker-input')).paddingLeft, '40px');
  assert.equal(window.getComputedStyle(window.document.querySelector('button.unrelated')).whiteSpace, 'nowrap');
  assert.equal(window.getComputedStyle(window.document.querySelector('input.unrelated')).paddingLeft, '8px');
});
