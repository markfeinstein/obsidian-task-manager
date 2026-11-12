import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import { exchangeGoogleTasksAuthorizationCode } from '../google-tasks-sync';

export interface GoogleTasksOAuthHost {
  settings: TaskManagerSettings;
  saveSettings(): Promise<void>;
}

export interface GoogleTasksPkceSession {
  codeVerifier: string;
  state?: string;
}

export class GoogleTasksOAuthModal extends Modal {
  private codeInput = '';
  private requestController: AbortController | null = null;

  constructor(
    app: App,
    private readonly plugin: GoogleTasksOAuthHost,
    private readonly pkce: GoogleTasksPkceSession,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Google Tasks OAuth' });
    contentEl.createEl('p', { text: 'Finish Google sign-in, then paste the redirected callback URL here to save refreshable tokens.' });
    new Setting(contentEl)
      .setName('Authorization callback URL')
      .setDesc(`Verifier is saved for this session. ${this.pkce.codeVerifier.slice(0, 12)}...`)
      .addText((text) => text.setPlaceholder('Paste callback URL').setValue(this.codeInput).onChange((value) => {
        this.codeInput = value;
      }));
    new Setting(contentEl)
      .addButton((btn) => btn.setCta().setButtonText('Exchange code and save').onClick(() => { void this.exchangePkce(); }))
      .addButton((btn) => btn.setButtonText('Paste clipboard').onClick(() => { void this.pasteClipboard(); }))
      .addButton((btn) => btn.setButtonText('Close').onClick(() => this.close()));
  }

  private async exchangePkce(): Promise<void> {
    const clientId = this.plugin.settings.googleTasksOAuthClientId.trim();
    const codeInput = this.codeInput.trim();
    if (!clientId || !codeInput) {
      new Notice('Google Tasks OAuth is not ready');
      return;
    }
    if (this.pkce.state && !codeInput.includes('://')) {
      new Notice('Paste the full Google Tasks callback URL so OAuth state can be verified.');
      return;
    }
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    try {
      const token = await exchangeGoogleTasksAuthorizationCode({
        clientId,
        codeOrCallbackUrl: codeInput,
        codeVerifier: this.pkce.codeVerifier,
        expectedState: this.pkce.state,
        signal: controller.signal,
      });
      this.plugin.settings.googleTasksAccessToken = token.accessToken;
      this.plugin.settings.googleTasksRefreshToken = token.refreshToken ?? this.plugin.settings.googleTasksRefreshToken;
      this.plugin.settings.googleTasksTokenExpiresAt = token.expiresAt ?? '';
      this.plugin.settings.googleTasksEnabled = true;
      await this.plugin.saveSettings();
      this.codeInput = '';
      this.close();
      new Notice('Google Tasks OAuth saved.');
    } catch (error) {
      if (!controller.signal.aborted) new Notice(`Google Tasks OAuth exchange failed: ${error instanceof Error ? error.message : String(error)}`);
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
