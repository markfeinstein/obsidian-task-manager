import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import { exchangeMicrosoftTodoAuthorizationCode } from '../microsoft-todo-sync';

export interface MicrosoftTodoOAuthHost {
  settings: TaskManagerSettings;
  saveSettings(): Promise<void>;
}

export interface MicrosoftTodoPkceSession {
  codeVerifier: string;
  state?: string;
}

export class MicrosoftTodoOAuthModal extends Modal {
  private codeInput = '';
  private requestController: AbortController | null = null;

  constructor(
    app: App,
    private readonly plugin: MicrosoftTodoOAuthHost,
    private readonly pkce: MicrosoftTodoPkceSession,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Microsoft To Do OAuth' });
    contentEl.createEl('p', { text: 'Finish Microsoft sign-in, then paste the redirected callback URL here to save refreshable tokens.' });
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
    const clientId = this.plugin.settings.msToDoClientId.trim();
    const codeInput = this.codeInput.trim();
    if (!clientId || !codeInput) {
      new Notice('Microsoft To Do OAuth is not ready');
      return;
    }
    if (this.pkce.state && !codeInput.includes('://')) {
      new Notice('Paste the full Microsoft To Do callback URL so OAuth state can be verified.');
      return;
    }
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    try {
      const token = await exchangeMicrosoftTodoAuthorizationCode({
        clientId,
        codeOrCallbackUrl: codeInput,
        codeVerifier: this.pkce.codeVerifier,
        expectedState: this.pkce.state,
        signal: controller.signal,
      });
      this.plugin.settings.msToDoToken = token.accessToken;
      this.plugin.settings.msToDoRefreshToken = token.refreshToken ?? this.plugin.settings.msToDoRefreshToken;
      this.plugin.settings.msToDoTokenExpiresAt = token.expiresAt ?? '';
      this.plugin.settings.msToDoEnabled = true;
      await this.plugin.saveSettings();
      this.codeInput = '';
      this.close();
      new Notice('Microsoft To Do OAuth saved.');
    } catch (error) {
      if (!controller.signal.aborted) new Notice(`Microsoft To Do OAuth exchange failed: ${error instanceof Error ? error.message : String(error)}`);
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
