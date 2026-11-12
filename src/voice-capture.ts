/**
 * Voice Capture for Task Manager (T3-2)
 *
 * Records audio using the browser's Web Speech API (zero dependencies) and
 * optionally falls back to the OpenAI Whisper REST API when a key is provided.
 * Transcribed text is passed through the NLP parser and shown in a preview
 * modal before inserting as a task.
 *
 * Usage:
 *   const vc = new VoiceCapture(app, getSettings, (taskLine) => insertTask(taskLine));
 *   vc.open();          // start listening
 *   vc.stop();          // stop and preview
 *
 * The optional Whisper path records a MediaRecorder blob, then sends it to
 * https://api.openai.com/v1/audio/transcriptions.
 */

import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { parseNLPInput, formatParsedNLPAsTaskLine } from './nlp-parser';
import type { TaskManagerSettings } from './types';
import { OAUTH_NETWORK_MAX_BYTES, requestJson } from './network-request';
import { t } from './i18n';
import { formatLocalDate } from './iso-date';

export const WHISPER_MAX_RECORDING_MS = 10 * 60 * 1000;
export const WHISPER_MAX_AUDIO_BYTES = 24 * 1024 * 1024;
export const WHISPER_REQUEST_TIMEOUT_MS = 60_000;
let voicePreviewSequence = 0;

// ── Web Speech API type declarations (not in TS lib by default) ────────────
interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
  /** Index of the first new result in `results` for this event. */
  readonly resultIndex: number;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  const g = globalThis as Record<string, unknown>;
  return (g['SpeechRecognition'] as SpeechRecognitionCtor | undefined)
    ?? (g['webkitSpeechRecognition'] as SpeechRecognitionCtor | undefined)
    ?? null;
}

function getUserMedia(): typeof navigator.mediaDevices.getUserMedia | null {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
    ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    : null;
}

// ── Whisper API helper ──────────────────────────────────────────────────────

async function transcribeWithWhisper(blob: Blob, apiKey: string, language: string | undefined, signal: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append('file', blob, 'recording.webm');
  form.append('model', 'whisper-1');
  if (language) form.append('language', language);

  const { response, body } = await requestJson<{ text?: unknown; error?: { message?: unknown } }>('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  }, { signal, timeoutMs: WHISPER_REQUEST_TIMEOUT_MS, maxBytes: OAUTH_NETWORK_MAX_BYTES, redirect: 'error' });

  if (!response.ok) {
    const message = typeof body.error?.message === 'string' ? body.error.message.slice(0, 200) : response.statusText;
    throw new Error(`Whisper API error ${response.status}${message ? ` - ${message}` : ''}`);
  }
  return typeof body.text === 'string' ? body.text.trim() : '';
}

// ── Preview modal ───────────────────────────────────────────────────────────

export class VoiceCapturePreviewModal extends Modal {
  private transcript = '';
  private taskLine = '';

  constructor(
    app: App,
    private readonly getSettings: () => TaskManagerSettings,
    private readonly onInsert: (taskLine: string) => void,
    initialTranscript = '',
  ) {
    super(app);
    this.transcript = initialTranscript;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('tm-voice-preview-modal');
    contentEl.createEl('h2', { text: '🎤 Voice Capture' });

    const controlId = `task-manager-voice-preview-${voicePreviewSequence++}`;
    // Transcript display / edit
    const transcriptSec = contentEl.createDiv({ cls: 'tm-voice-section' });
    const transcriptLabel = transcriptSec.createEl('label', { text: 'Transcribed text', cls: 'tm-voice-label' });
    transcriptLabel.htmlFor = `${controlId}-transcript`;
    const textArea = transcriptSec.createEl('textarea', { cls: 'tm-voice-textarea' });
    textArea.id = `${controlId}-transcript`;
    textArea.value = this.transcript;
    textArea.rows = 3;

    // Parsed preview
    const parsedSec = contentEl.createDiv({ cls: 'tm-voice-section' });
    const previewHeading = parsedSec.createEl('h3', { text: 'Parsed task preview', cls: 'tm-voice-label' });
    previewHeading.id = `${controlId}-preview-heading`;
    const previewEl = parsedSec.createDiv({ cls: 'tm-voice-preview' });
    previewEl.setAttr('role', 'region');
    previewEl.setAttr('aria-labelledby', previewHeading.id);

    const update = (): void => {
      this.transcript = textArea.value;
      const today = formatLocalDate(new Date());
      const parsed = parseNLPInput(this.transcript, today);
      const settings = this.getSettings();
      this.taskLine = formatParsedNLPAsTaskLine(parsed, false, settings.dateFormat ?? 'plain');
      previewEl.empty();
      previewEl.createEl('code', { text: this.taskLine, cls: 'tm-voice-preview-code' });
    };

    textArea.addEventListener('input', update);
    update();

    const insertTask = (): void => {
      if (this.taskLine.trim()) {
        this.onInsert(this.taskLine);
        this.close();
      } else {
        new Notice('No task text to insert');
      }
    };

    // Buttons
    const btnRow = contentEl.createDiv({ cls: 'tm-voice-buttons' });

    const insertBtn = btnRow.createEl('button', { text: '✅ Insert Task', cls: 'mod-cta' });
    insertBtn.addEventListener('click', insertTask);

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    // Plain Enter remains available for transcript editing. Ctrl/Cmd+Enter is
    // the explicit accelerator and is ignored during IME composition.
    contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.isComposing && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        insertTask();
        return;
      }
      if (e.key === 'Escape' && !e.isComposing) this.close();
    });
    insertBtn.setAttr('aria-keyshortcuts', 'Control+Enter Meta+Enter');

    textArea.focus();
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── Main VoiceCapture class ─────────────────────────────────────────────────

export class VoiceCapture {
  private recognition: SpeechRecognitionLike | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private isRecording = false;
  private interimTranscript = '';
  private finalTranscript = '';
  private pendingSpeechStopResolve: (() => void) | null = null;
  private recordingTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private audioBytes = 0;
  private uploadController: AbortController | null = null;
  private generation = 0;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => TaskManagerSettings,
    private readonly onInsert: (taskLine: string) => void,
  ) {}

  private clearRecordingTimer(): void {
    if (this.recordingTimer !== null) globalThis.clearTimeout(this.recordingTimer);
    this.recordingTimer = null;
  }

  private stopRecorderTracks(recorder: MediaRecorder | null = this.mediaRecorder): void {
    (recorder?.stream?.getTracks() ?? []).forEach((track) => track.stop());
  }

  /** True if at least one configured speech recognition method is available. */
  static isAvailable(settings?: Pick<TaskManagerSettings, 'whisperApiKey'>): boolean {
    return getSpeechRecognition() !== null || (
      'MediaRecorder' in globalThis
      && getUserMedia() !== null
      && Boolean(settings?.whisperApiKey?.trim())
    );
  }

  /** Start recording. Shows live transcript indicator if Web Speech is available. */
  start(onInterim?: (text: string) => void): void {
    if (this.isRecording) return;
    this.isRecording = true;
    this.generation += 1;
    const generation = this.generation;
    this.uploadController?.abort();
    this.uploadController = null;
    this.clearRecordingTimer();
    this.audioChunks = [];
    this.audioBytes = 0;
    this.finalTranscript = '';
    this.interimTranscript = '';

    const settings = this.getSettings();
    const SpeechRecognitionCtor = getSpeechRecognition();

    if (SpeechRecognitionCtor) {
      // ── Web Speech API path ─────────────────────────────────────
      this.recognition = new SpeechRecognitionCtor();
      this.recognition.lang = settings.preferredLocale ?? 'en-US';
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.maxAlternatives = 1;

      this.recognition.onresult = (e: SpeechRecognitionEvent) => {
        // Only process *new* results (from e.resultIndex onward).
        // The Web Speech API accumulates all results in e.results across events;
        // looping from 0 would re-append already-processed final transcripts,
        // causing every previously spoken word to be duplicated.
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r?.[0]) {
            if (r.isFinal) {
              this.finalTranscript += r[0].transcript + ' ';
            } else {
              interim = r[0].transcript;
            }
          }
        }
        this.interimTranscript = interim;
        onInterim?.(this.finalTranscript + interim);
      };

      this.recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          new Notice(`Voice capture error: ${e.error}`);
        }
        this.isRecording = false;
      };

      this.recognition.onend = () => {
        // Auto-restart for continuous capture unless user stopped.
        if (this.isRecording) {
          try { this.recognition?.start(); } catch { /* already started */ }
          return;
        }
        if (this.pendingSpeechStopResolve) {
          const resolve = this.pendingSpeechStopResolve;
          this.pendingSpeechStopResolve = null;
          this.openSpeechPreview();
          resolve();
        }
      };

      this.recognition.start();
    } else if ('MediaRecorder' in globalThis) {
      // ── Whisper fallback path (requires API key) ────────────────
      if (!settings.whisperApiKey) {
        new Notice('Voice capture: Web Speech API not available and no Whisper API key configured in settings.');
        this.isRecording = false;
        return;
      }
      const requestMicrophone = getUserMedia();
      if (!requestMicrophone) {
        new Notice('Voice capture: microphone access is not available in this environment.');
        this.isRecording = false;
        return;
      }
      void requestMicrophone({ audio: true }).then((stream) => {
        if (!this.isRecording || this.generation !== generation) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        this.audioChunks = [];
        this.audioBytes = 0;
        this.mediaRecorder = new MediaRecorder(stream);
        this.mediaRecorder.ondataavailable = (e) => {
          if (this.generation !== generation || e.data.size <= 0) return;
          this.audioBytes += e.data.size;
          if (this.audioBytes > WHISPER_MAX_AUDIO_BYTES) {
            new Notice(t('voice.error.recordingSizeLimit'));
            this.abort();
            return;
          }
          this.audioChunks.push(e.data);
        };
        this.mediaRecorder.start(250);  // collect chunks every 250ms
        this.recordingTimer = globalThis.setTimeout(() => {
          if (this.isRecording && this.generation === generation) void this.stop();
        }, WHISPER_MAX_RECORDING_MS);
      }).catch((err: unknown) => {
        new Notice(`Voice capture: microphone access denied — ${String(err)}`);
        this.isRecording = false;
      });
    } else {
      new Notice('Voice capture is not supported in this browser/environment.');
      this.isRecording = false;
    }
  }

  /** Stop recording and open the preview modal. */
  async stop(): Promise<void> {
    if (!this.isRecording) return;
    const generation = this.generation;
    this.isRecording = false;
    this.clearRecordingTimer();

    if (this.recognition) {
      return new Promise((resolve) => {
        this.pendingSpeechStopResolve = resolve;
        try {
          this.recognition?.stop();
        } catch {
          this.pendingSpeechStopResolve = null;
          if (this.generation === generation) this.openSpeechPreview();
          resolve();
        }
      });
    }

    const mediaRecorder = this.mediaRecorder;
    if (!mediaRecorder) return;
    return new Promise((resolve) => {
      mediaRecorder.onstop = () => {
        void (async () => {
          try {
            const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
            this.audioChunks = [];
            this.audioBytes = 0;
            this.stopRecorderTracks(mediaRecorder);
            if (this.mediaRecorder === mediaRecorder) this.mediaRecorder = null;
            if (this.generation !== generation) return;
            if (blob.size === 0) {
              new Notice('Voice capture: no audio was captured. Please try again.');
              return;
            }
            if (blob.size > WHISPER_MAX_AUDIO_BYTES) {
              new Notice(t('voice.error.recordingTooLarge'));
              return;
            }
            const settings = this.getSettings();
            if (!settings.whisperApiKey) return;

            new Notice('Voice capture: transcribing…');
            const controller = new AbortController();
            this.uploadController = controller;
            try {
              const text = await transcribeWithWhisper(blob, settings.whisperApiKey, settings.preferredLocale?.slice(0, 2), controller.signal);
              if (this.generation === generation && !controller.signal.aborted) {
                new VoiceCapturePreviewModal(this.app, this.getSettings, this.onInsert, text).open();
              }
            } catch (err) {
              if (this.generation === generation && !controller.signal.aborted) {
                new Notice(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            } finally {
              if (this.uploadController === controller) this.uploadController = null;
            }
          } catch (err) {
            if (this.generation === generation) new Notice(`Voice capture error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            this.stopRecorderTracks(mediaRecorder);
            this.audioChunks = [];
            this.audioBytes = 0;
            resolve();
          }
        })();
      };
      mediaRecorder.stop();
    });
  }

  private openSpeechPreview(): void {
    this.recognition = null;
    const transcript = (this.finalTranscript + this.interimTranscript).trim();
    new VoiceCapturePreviewModal(this.app, this.getSettings, this.onInsert, transcript).open();
  }

  /** Abort without preview. */
  abort(): void {
    this.generation += 1;
    this.isRecording = false;
    this.clearRecordingTimer();
    this.uploadController?.abort();
    this.uploadController = null;
    this.recognition?.abort();
    this.recognition = null;
    const resolvePendingSpeechStop = this.pendingSpeechStopResolve;
    this.pendingSpeechStopResolve = null;
    resolvePendingSpeechStop?.();
    const recorder = this.mediaRecorder;
    if (recorder) {
      this.stopRecorderTracks(recorder);
      try {
        if ((recorder as MediaRecorder & { state?: string }).state === 'recording') recorder.stop();
      } catch { /* recorder may already be stopping */ }
      this.mediaRecorder = null;
    }
    this.audioChunks = [];
    this.audioBytes = 0;
  }
}

// ── Floating mic button (for sidebar widget) ────────────────────────────────

/**
 * Render a mic button in the given container. Starts/stops a VoiceCapture
 * session and shows live interim text in the provided feedback element.
 */
export function renderMicButton(
  container: HTMLElement,
  vc: VoiceCapture,
  feedbackEl?: HTMLElement,
): HTMLButtonElement {
  const btn = container.createEl('button', {
    cls: 'tm-voice-mic-btn',
    text: '🎤',
  });
  btn.setAttr('type', 'button');
  btn.setAttr('aria-label', 'Start voice capture');
  btn.setAttr('title', 'Voice capture task');
  btn.setAttr('aria-pressed', 'false');

  let active = false;

  btn.addEventListener('click', () => {
    active = !active;
    btn.setAttr('aria-pressed', String(active));
    btn.setText(active ? '⏹' : '🎤');
    btn.setAttr('aria-label', active ? 'Stop recording' : 'Start voice capture');
    btn.toggleClass('is-recording', active);

    if (active) {
      vc.start((interim) => {
        if (feedbackEl) feedbackEl.setText(interim || '…listening');
      });
    } else {
      void vc.stop().then(() => {
        if (feedbackEl) feedbackEl.setText('');
      });
    }
  });

  return btn;
}
