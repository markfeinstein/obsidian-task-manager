import { Modal, Notice, Setting, DropdownComponent } from 'obsidian';
import type { App } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import { buildPkceAuthorizationUrl, generatePkceVerifier } from '../oauth-pkce';
import { exchangeGoogleCalendarAuthorizationCode } from '../google-calendar-sync';
import { GOOGLE_CALENDAR_AUTH_ENDPOINT, GOOGLE_CALENDAR_DEFAULT_REDIRECT_URI, GOOGLE_CALENDAR_SCOPE } from '../google-calendar-sync';
import { t } from '../i18n';

export interface GoogleCalendarSetupHost {
  settings: TaskManagerSettings;
  saveSettings(): Promise<void>;
  openGoogleCalendarQuickCaptureModal(): void;
}

export class GoogleCalendarSetupWizardModal extends Modal {
  private mode: 'local' | 'oauth' = 'local';
  private pendingPkce: { authorizationUrl: string; codeVerifier: string; state: string } | null = null;
  private codeInput = '';
  private requestController: AbortController | null = null;

  constructor(
    app: App,
    private readonly plugin: GoogleCalendarSetupHost,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Google Calendar setup' });
    contentEl.createEl('p', { text: 'Pick a simple setup path. You can keep capture local-only or enable Google Calendar sync with OAuth.' });

    const status = this.googleCalendarStatusText();
    contentEl.createEl('div', { cls: 'task-manager-sync-card__badge', text: status });

    new Setting(contentEl)
      .setName('Setup mode')
      .setDesc('Local only keeps the quick-add path simple. Google Calendar sync enables OAuth-backed writeback.')
      .addDropdown((dropdown) => this.configureModeDropdown(dropdown));

    if (this.mode === 'local') {
      contentEl.createEl('div', { cls: 'task-manager-sync-card', text: t('googleCalendar.setup.localModeDescription') });
      new Setting(contentEl)
        .addButton((btn) => btn.setButtonText('Close').onClick(() => this.close()))
        .addButton((btn) => btn.setCta().setButtonText('Open quick add').onClick(() => { this.close(); this.plugin.openGoogleCalendarQuickCaptureModal(); }));
      return;
    }

    contentEl.createEl('div', { cls: 'task-manager-sync-card', text: 'OAuth mode: start PKCE, paste the callback code, then save tokens into settings.' });
    new Setting(contentEl)
      .setName('Google Calendar client ID')
      .setDesc('Required for PKCE or refresh-token flow.')
      .addText((text) => text.setPlaceholder('client-id.apps.googleusercontent.com').setValue(this.plugin.settings.googleCalendarOAuthClientId).onChange(async (value) => {
        this.plugin.settings.googleCalendarOAuthClientId = value.trim();
        await this.plugin.saveSettings();
      }));
    new Setting(contentEl)
      .setName('Google Calendar access token')
      .setDesc('Bearer token with calendar.events scope.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('ya29...').setValue(this.plugin.settings.googleCalendarAccessToken).onChange(async (value) => {
          this.plugin.settings.googleCalendarAccessToken = value.trim();
          await this.plugin.saveSettings();
        });
      });
    new Setting(contentEl)
      .setName('Google Calendar refresh token')
      .setDesc('Used to refresh expired access tokens.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('1//...').setValue(this.plugin.settings.googleCalendarRefreshToken).onChange(async (value) => {
          this.plugin.settings.googleCalendarRefreshToken = value.trim();
          await this.plugin.saveSettings();
        });
      });

    if (this.pendingPkce) {
      contentEl.createEl('div', { cls: 'task-manager-sync-card', text: 'PKCE started. Open the browser window, finish Google login, then paste the redirected callback URL below.' });
      new Setting(contentEl)
        .setName('Authorization callback URL')
        .setDesc(`Verifier is saved for this session. ${this.pendingPkce.codeVerifier.slice(0, 12)}…`)
        .addText((text) => text.setPlaceholder('Paste the redirected callback URL').setValue(this.codeInput).onChange((value) => {
          this.codeInput = value;
        }));
      new Setting(contentEl)
        .addButton((btn) => btn.setCta().setButtonText('Exchange code and save').onClick(() => { void this.exchangePkce(); }))
        .addButton((btn) => btn.setButtonText('Paste clipboard').onClick(() => { void this.pasteClipboard(); }))
        .addButton((btn) => btn.setButtonText('Clear').onClick(() => { this.pendingPkce = null; this.codeInput = ''; this.render(); }));
    }

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText(this.pendingPkce ? 'Restart PKCE login' : 'Start PKCE login').setCta().onClick(() => { void this.startPkce(); }))
      .addButton((btn) => btn.setButtonText('Close').onClick(() => this.close()));
  }

  private googleCalendarStatusText(): string {
    if (!this.plugin.settings.googleCalendarEnabled) return 'Google Calendar: disabled';
    if (this.plugin.settings.googleCalendarAccessToken.trim()) {
      return this.plugin.settings.googleCalendarDryRun ? 'Google Calendar: ready, dry run on' : 'Google Calendar: ready';
    }
    if (this.plugin.settings.googleCalendarRefreshToken.trim()) return 'Google Calendar: refresh token saved';
    return 'Google Calendar: needs OAuth';
  }

  private configureModeDropdown(dropdown: DropdownComponent): void {
    dropdown.addOption('local', 'Local only');
    dropdown.addOption('oauth', 'Google Calendar sync');
    dropdown.setValue(this.mode).onChange((value) => {
      this.mode = value === 'oauth' ? 'oauth' : 'local';
      this.render();
    });
  }

  private async startPkce(): Promise<void> {
    const clientId = this.plugin.settings.googleCalendarOAuthClientId.trim();
    if (!clientId) {
      new Notice('Google Calendar client ID is required');
      return;
    }
    try {
      const state = generatePkceVerifier(32);
      const pkce = await buildPkceAuthorizationUrl({
        authorizationEndpoint: GOOGLE_CALENDAR_AUTH_ENDPOINT,
        clientId,
        redirectUri: GOOGLE_CALENDAR_DEFAULT_REDIRECT_URI,
        scope: GOOGLE_CALENDAR_SCOPE,
        state,
        extraParams: { access_type: 'offline', prompt: 'consent' },
      });
      window.open(pkce.authorizationUrl, '_blank', 'noopener');
      this.pendingPkce = { authorizationUrl: pkce.authorizationUrl, codeVerifier: pkce.codeVerifier, state: pkce.state ?? state };
      this.codeInput = '';
      this.render();
      new Notice('Google Calendar PKCE started. Complete the browser sign-in, then paste the code here.');
    } catch (error) {
      new Notice(`Google Calendar PKCE failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async exchangePkce(): Promise<void> {
    const clientId = this.plugin.settings.googleCalendarOAuthClientId.trim();
    const pending = this.pendingPkce;
    const codeInput = this.codeInput.trim();
    if (!clientId || !pending || !codeInput) {
      new Notice('Google Calendar PKCE is not ready');
      return;
    }
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    try {
      const token = await exchangeGoogleCalendarAuthorizationCode({
        clientId,
        codeOrCallbackUrl: codeInput,
        codeVerifier: pending.codeVerifier,
        expectedState: pending.state,
        signal: controller.signal,
      });
      this.plugin.settings.googleCalendarAccessToken = token.accessToken;
      if (token.refreshToken) this.plugin.settings.googleCalendarRefreshToken = token.refreshToken;
      this.plugin.settings.googleCalendarTokenExpiresAt = token.expiresAt ?? '';
      this.plugin.settings.googleCalendarEnabled = true;
      await this.plugin.saveSettings();
      this.pendingPkce = null;
      this.codeInput = '';
      this.close();
      new Notice('Google Calendar OAuth saved.');
    } catch (error) {
      if (!controller.signal.aborted) new Notice(`Google Calendar OAuth exchange failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.requestController === controller) this.requestController = null;
    }
  }

  onClose(): void {
    this.requestController?.abort();
    this.requestController = null;
    this.contentEl.empty();
  }

  private async pasteClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      this.codeInput = text.trim();
      this.render();
    } catch (error) {
      new Notice(`Clipboard paste failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
