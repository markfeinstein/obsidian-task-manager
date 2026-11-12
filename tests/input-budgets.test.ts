import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAppleRemindersWebhook } from '../src/apple-reminders-sync';
import {
  APPLE_REMINDER_TITLE_MAX_BYTES,
  APPLE_REMINDERS_MAX_ITEMS,
  TASK_CAPTURE_URI_MAX_BYTES,
  utf8ByteLength,
} from '../src/input-budgets';
import { parseTaskURI } from '../src/mobile-uri-capture';

test('shared input budgets count UTF-8 bytes rather than UTF-16 code units', () => {
  assert.equal(utf8ByteLength('plain'), 5);
  assert.equal(utf8ByteLength('😀'), 4);
});

test('shared input budgets retain a portable UTF-8 fallback without TextEncoder', () => {
  const original = globalThis.TextEncoder;
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: undefined });
  try {
    assert.equal(utf8ByteLength('Aé中😀'), 10);
  } finally {
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: original });
  }
});

test('Apple Reminders refuses oversized counts and fields atomically', () => {
  const options = { enabled: true };
  const tooMany = Array.from({ length: APPLE_REMINDERS_MAX_ITEMS + 1 }, (_value, index) => ({ id: String(index), title: 'Task' }));
  assert.equal(handleAppleRemindersWebhook(tooMany, options).reason, 'resource-limit');
  const oversized = [{ id: 'one', title: '😀'.repeat(Math.floor(APPLE_REMINDER_TITLE_MAX_BYTES / 4) + 1) }];
  const result = handleAppleRemindersWebhook(oversized, options);
  assert.equal(result.reason, 'resource-limit');
  assert.deepEqual(result.lines, []);
});

test('mobile protocol capture rejects an oversized URI before parsing fields', () => {
  const uri = `obsidian://new-task?text=${'a'.repeat(TASK_CAPTURE_URI_MAX_BYTES)}`;
  assert.equal(parseTaskURI(uri), null);
});
