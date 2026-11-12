import assert from 'node:assert/strict';
import test from 'node:test';
import TaskManagerPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/types';
import { APPLE_REMINDERS_CLIPBOARD_MAX_BYTES } from '../src/input-budgets';

void test('Apple Reminders clipboard import parses JSON and delegates to the guarded importer', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { readText: async () => '{"protocol":"task-manager.apple-reminders.webhook.v1","reminders":[]}' } },
  });
  const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin;
  plugin.settings = {
    ...DEFAULT_SETTINGS,
    appleRemindersEnabled: true,
    appleRemindersWebhookEnabled: true,
    appleRemindersDryRun: true,
  };
  let captured: unknown;
  (plugin as unknown as { importAppleRemindersWebhookPayload: (payload: unknown) => Promise<{ imported: number; accepted: boolean }> }).importAppleRemindersWebhookPayload = async (payload) => {
    captured = payload;
    return { imported: 0, accepted: true };
  };

  try {
    await (plugin as unknown as { importAppleRemindersFromClipboard: () => Promise<void> }).importAppleRemindersFromClipboard();
    assert.deepEqual(captured, { protocol: 'task-manager.apple-reminders.webhook.v1', reminders: [] });
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

void test('Apple Reminders clipboard import rejects oversized text before JSON parsing', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalParse = JSON.parse;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { readText: async () => 'x'.repeat(APPLE_REMINDERS_CLIPBOARD_MAX_BYTES + 1) } },
  });
  let parsed = false;
  JSON.parse = ((value: string) => { parsed = true; return originalParse(value); }) as typeof JSON.parse;
  const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin;
  plugin.settings = { ...DEFAULT_SETTINGS, appleRemindersEnabled: true };
  let imported = false;
  (plugin as unknown as { importAppleRemindersWebhookPayload: () => Promise<{ imported: number; accepted: boolean }> }).importAppleRemindersWebhookPayload = async () => {
    imported = true;
    return { imported: 0, accepted: true };
  };
  try {
    await (plugin as unknown as { importAppleRemindersFromClipboard: () => Promise<void> }).importAppleRemindersFromClipboard();
    assert.equal(parsed, false);
    assert.equal(imported, false);
  } finally {
    JSON.parse = originalParse;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
