/**
 * voice-capture-modal.ts
 *
 * Shows a live recording indicator with interim transcript while the user
 * speaks.  Stopping opens the VoiceCapturePreviewModal from voice-capture.ts.
 */

import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import type { VoiceCapture } from '../voice-capture';

export class VoiceCaptureRecordingModal extends Modal {
  private vc: VoiceCapture;
  private feedbackEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private stopBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private stopped = false;
  private isStopping = false;
  private stopCompleted = false;
  private handleKeydown?: (e: KeyboardEvent) => void;

  constructor(app: App, vc: VoiceCapture) {
    super(app);
    this.vc = vc;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('tm-voice-recording-modal');
    contentEl.createEl('h2', { text: '🎤 Voice Capture' });

    this.statusEl = contentEl.createDiv({ cls: 'tm-voice-status', text: '● Recording — speak your task…' });
    this.statusEl.setAttr('aria-live', 'polite');
    this.statusEl.setAttr('aria-label', 'Recording status');

    this.feedbackEl = contentEl.createDiv({ cls: 'tm-voice-interim', text: '…listening' });
    this.feedbackEl.setAttr('aria-live', 'polite');

    this.stopBtn = contentEl.createEl('button', { text: '⏹ Stop & Preview', cls: 'mod-cta' });
    this.stopBtn.addEventListener('click', () => { void this.doStop(); });

    this.cancelBtn = contentEl.createEl('button', { text: 'Cancel' });
    this.cancelBtn.addEventListener('click', () => {
      if (this.isStopping) return;
      this.vc.abort();
      this.stopped = true;
      this.close();
    });

    this.handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.isStopping) return;
        this.vc.abort();
        this.stopped = true;
        this.close();
      }
    };
    contentEl.addEventListener('keydown', this.handleKeydown);

    this.vc.start((interim) => {
      if (this.feedbackEl && !this.isStopping) this.feedbackEl.setText(interim || '…listening');
    });
  }

  private setStoppingUi(): void {
    this.isStopping = true;
    this.statusEl.setText('⏳ Preparing preview…');
    this.feedbackEl.setText('Processing your recording. This may take a moment.');
    this.contentEl.setAttr('aria-busy', 'true');
    this.stopBtn.disabled = true;
    this.stopBtn.setText('⏳ Working…');
    this.cancelBtn.disabled = true;
  }

  private async doStop(): Promise<void> {
    if (this.stopped || this.isStopping) return;
    this.stopped = true;
    this.setStoppingUi();
    try {
      await this.vc.stop();
      this.stopCompleted = true;
    } finally {
      this.isStopping = false;
      this.close();
    }
  }

  onClose(): void {
    if (this.handleKeydown) {
      this.contentEl.removeEventListener('keydown', this.handleKeydown);
    }
    if (!this.stopCompleted) this.vc.abort();
    this.contentEl.empty();
  }
}
