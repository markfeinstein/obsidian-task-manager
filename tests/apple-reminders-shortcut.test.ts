import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAppleRemindersShortcutUrl,
  DEFAULT_APPLE_REMINDERS_SHORTCUT_NAME,
} from '../src/apple-reminders-shortcut';
import { normalizeTaskManagerSettings } from '../src/types';

test('Apple Reminders Shortcut uses the documented default name', () => {
  assert.equal(DEFAULT_APPLE_REMINDERS_SHORTCUT_NAME, 'Export Reminders to Obsidian');
  assert.equal(
    buildAppleRemindersShortcutUrl('', ''),
    'shortcuts://run-shortcut?name=Export%20Reminders%20to%20Obsidian',
  );
  assert.equal(normalizeTaskManagerSettings({}).appleRemindersShortcutName, DEFAULT_APPLE_REMINDERS_SHORTCUT_NAME);
});

test('Apple Reminders Shortcut encodes custom Unicode and reserved characters independently', () => {
  const name = 'Rappels été & travail? #1';
  const list = 'Courses & maison?urgent=true';
  const url = buildAppleRemindersShortcutUrl(name, list);
  assert.equal(url, `shortcuts://run-shortcut?name=${encodeURIComponent(name)}&input=${encodeURIComponent(list)}`);
  assert.equal(url.split('&').length, 2, 'encoded values cannot inject query parameters');
});

test('Apple Reminders Shortcut name normalization rejects blank and multiline values', () => {
  for (const value of ['', '   ', 'Unsafe\nShortcut', 'Unsafe\rShortcut']) {
    assert.equal(normalizeTaskManagerSettings({ appleRemindersShortcutName: value }).appleRemindersShortcutName, DEFAULT_APPLE_REMINDERS_SHORTCUT_NAME);
  }
  assert.equal(normalizeTaskManagerSettings({ appleRemindersShortcutName: 'My Shortcut' }).appleRemindersShortcutName, 'My Shortcut');
});
