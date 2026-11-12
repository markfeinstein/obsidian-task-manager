import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'obsidian';
import type TaskManagerPlugin from '../src/main';
import { GoogleCalendarSetupWizardModal } from '../src/modals/google-calendar-setup-wizard';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHarness } from './dom-harness';

test('Google Calendar setup renders local mode and cleans up', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const plugin = { settings: { ...structuredClone(DEFAULT_SETTINGS) }, saveSettings: async () => undefined, openGoogleCalendarQuickCaptureModal: () => undefined } as TaskManagerPlugin;
  const modal = new GoogleCalendarSetupWizardModal({} as App, plugin);
  const content = harness.document.createElement('div');
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();
  assert.match(content.textContent ?? '', /Google Calendar setup/u);
  modal.onClose();
  assert.equal(content.children.length, 0);
});

test('Google Calendar setup exchanges PKCE with cancellation ownership', async (context) => {
  const harness = installDomHarness();
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; harness.cleanup(); });
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  const settings = { ...structuredClone(DEFAULT_SETTINGS), googleCalendarOAuthClientId: 'client' };
  const plugin = { settings, saveSettings: async () => undefined, openGoogleCalendarQuickCaptureModal: () => undefined } as TaskManagerPlugin;
  const modal = new GoogleCalendarSetupWizardModal({} as App, plugin);
  const content = harness.document.createElement('div');
  Object.assign(modal, { contentEl: content, pendingPkce: { authorizationUrl: 'https://accounts.google.com', codeVerifier: 'a'.repeat(50), state: 'state' }, codeInput: 'obsidian://callback?code=code&state=state' });
  await (modal as unknown as { exchangePkce(): Promise<void> }).exchangePkce();
  assert.equal(settings.googleCalendarAccessToken, 'access');
  assert.equal(settings.googleCalendarEnabled, true);
  modal.onClose();
});

test('Google Calendar setup preserves an existing refresh token when reauthorization omits one', async (context) => {
  const harness = installDomHarness();
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; harness.cleanup(); });
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  const settings = { ...structuredClone(DEFAULT_SETTINGS), googleCalendarOAuthClientId: 'client', googleCalendarRefreshToken: 'keep-refresh' };
  const plugin = { settings, saveSettings: async () => undefined, openGoogleCalendarQuickCaptureModal: () => undefined } as TaskManagerPlugin;
  const modal = new GoogleCalendarSetupWizardModal({} as App, plugin);
  Object.assign(modal, { contentEl: harness.document.createElement('div'), pendingPkce: { authorizationUrl: 'https://accounts.google.com', codeVerifier: 'a'.repeat(50), state: 'state' }, codeInput: 'obsidian://callback?code=code&state=state' });

  await (modal as unknown as { exchangePkce(): Promise<void> }).exchangePkce();

  assert.equal(settings.googleCalendarAccessToken, 'new-access');
  assert.equal(settings.googleCalendarRefreshToken, 'keep-refresh');
});
