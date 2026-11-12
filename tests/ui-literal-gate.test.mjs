import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUiLiterals } from '../scripts/check-ui-literals.mjs';

test('UI literal gate finds direct labels and ignores translated expressions', () => {
  const records = collectUiLiterals(`
    setting.setName('Direct setting');
    root.createEl('button', { text: 'Direct action' });
    button.setAttr('aria-label', 'Direct accessible name');
    new Notice('Direct notice');
    setting.setDesc(t('settings.description'));
    root.createEl('span', { text: t('action.run') });
  `);

  assert.deepEqual(records.map(({ context, text }) => ({ context, text })), [
    { context: 'createEl:text', text: 'Direct action' },
    { context: 'Notice', text: 'Direct notice' },
    { context: 'setAttr:aria-label', text: 'Direct accessible name' },
    { context: 'setName', text: 'Direct setting' },
  ]);
});
