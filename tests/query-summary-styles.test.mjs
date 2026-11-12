import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const css = readFileSync('styles/00-foundation.css', 'utf8');
const chipRules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/gu)]
  .filter(([, selector]) => /\.task-manager-query-(?:summary|stats)-chip/u.test(selector))
  .map(([rule]) => rule).join('\n');

function fixture(context) {
  const dom = new JSDOM('<main></main>');
  context.after(() => dom.window.close());
  const style = dom.window.document.createElement('style');
  style.textContent = chipRules;
  dom.window.document.head.append(style);
  function declarations(classes) {
    const element = dom.window.document.createElement('span');
    element.className = classes;
    const result = {};
    // These component selectors have equal specificity; inspect their source-order cascade.
    // This is a source guard, not a substitute for real-host resolved contrast measurements.
    for (const rule of style.sheet.cssRules) {
      if (!element.matches(rule.selectorText)) continue;
      for (const property of ['background', 'color']) {
        const value = rule.style.getPropertyValue(property);
        if (value) result[property] = value;
      }
    }
    return result;
  }
  return { declarations, rules: [...style.sheet.cssRules] };
}

test('overdue summary and footer chips use readable text on an explicit host-background tint', (context) => {
  const { declarations } = fixture(context);
  for (const kind of ['summary', 'stats']) {
    const prefix = `task-manager-query-${kind}-chip`;
    const effective = declarations(`${prefix} ${prefix}--overdue`);
    assert.equal(effective.color, 'var(--text-normal)', kind);
    assert.match(effective.background, /^color-mix\(in srgb,/u, kind);
    assert.match(effective.background, /var\(--background-secondary\)/u, kind);
    assert.match(effective.background, /--text-error/u, kind);
    assert.doesNotMatch(effective.background, /--background-modifier-error/u, kind);
  }
});

test('the overdue correction preserves ordinary chips and stays component-scoped', (context) => {
  const { declarations, rules } = fixture(context);
  assert.equal(declarations('task-manager-query-summary-chip').color, 'var(--text-muted)');
  assert.equal(declarations('task-manager-query-summary-chip task-manager-query-summary-chip--total').color, 'var(--text-normal)');
  assert.equal(declarations('task-manager-query-stats-chip').background, 'var(--background-modifier-border)');
  assert.deepEqual(declarations('unrelated-chip'), {});
  for (const rule of rules) {
    for (const selector of rule.selectorText.split(',')) {
      assert.match(selector.trim(), /^\.task-manager-query-(?:summary|stats)-chip(?:--[a-z]+)?$/u);
    }
  }
});
