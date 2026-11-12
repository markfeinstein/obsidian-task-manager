import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCapture, VoiceCapturePreviewModal, WHISPER_MAX_AUDIO_BYTES, WHISPER_MAX_RECORDING_MS, WHISPER_REQUEST_TIMEOUT_MS } from '../src/voice-capture';
import { DEFAULT_SETTINGS } from '../src/types';
import { FakeDOMElement } from './test-utils';

function withSpeechGlobals<T>(patch: Record<string, unknown>, fn: () => T): T {
  const globals = globalThis as Record<string, unknown>;
  const keys = ['SpeechRecognition', 'webkitSpeechRecognition', 'MediaRecorder'];
  const previous = new Map(keys.map((key) => [key, globals[key]]));
  for (const key of keys) delete globals[key];
  Object.assign(globals, patch);
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  }
}

test('VoiceCapture.isAvailable requires a configured Whisper key for MediaRecorder fallback', () => {
  class MockMediaRecorder {}

  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => Promise.resolve({} as MediaStream) } },
  });
  try {
    withSpeechGlobals({ MediaRecorder: MockMediaRecorder }, () => {
      assert.equal(VoiceCapture.isAvailable(), false);
      assert.equal(VoiceCapture.isAvailable({ whisperApiKey: '   ' }), false);
      assert.equal(VoiceCapture.isAvailable({ whisperApiKey: 'sk-test' }), true);
    });
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
});

test('VoiceCapture.isAvailable rejects Whisper fallback without microphone access', () => {
  class MockMediaRecorder {}

  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  try {
    withSpeechGlobals({ MediaRecorder: MockMediaRecorder }, () => {
      assert.equal(VoiceCapture.isAvailable({ whisperApiKey: 'sk-test' }), false);
    });
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
});

test('VoiceCapture.start does not throw when microphone access is unavailable', () => {
  class MockMediaRecorder {}

  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  try {
    withSpeechGlobals({ MediaRecorder: MockMediaRecorder }, () => {
      const voiceCapture = new VoiceCapture({} as never, () => ({ whisperApiKey: 'sk-test' }) as never, () => {});
      assert.doesNotThrow(() => voiceCapture.start());
    });
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
});

test('VoiceCapture.isAvailable allows Web Speech without a Whisper key', () => {
  class MockSpeechRecognition {}

  withSpeechGlobals({ SpeechRecognition: MockSpeechRecognition }, () => {
    assert.equal(VoiceCapture.isAvailable(), true);
  });
});

test('VoiceCapture stops late Whisper stream when stopped before microphone permission resolves', async () => {
  let resolveStream!: (stream: MediaStream) => void;
  let recorderStarted = false;
  let trackStopped = false;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const globals = globalThis as Record<string, unknown>;
  const previousMediaRecorder = globals.MediaRecorder;

  class MockMediaRecorder {
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(readonly stream: MediaStream) {}

    start(): void {
      recorderStarted = true;
    }

    stop(): void {
      this.onstop?.();
    }
  }

  const stream = {
    getTracks: () => [{ stop: () => { trackStopped = true; } }],
  } as unknown as MediaStream;

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => new Promise<MediaStream>((resolve) => { resolveStream = resolve; }),
      },
    },
  });
  delete globals.SpeechRecognition;
  delete globals.webkitSpeechRecognition;
  globals.MediaRecorder = MockMediaRecorder;

  try {
    const voiceCapture = new VoiceCapture({} as never, () => ({ whisperApiKey: 'sk-test' }) as never, () => {});
    voiceCapture.start();
    await voiceCapture.stop();

    resolveStream(stream);
    await Promise.resolve();

    assert.equal(trackStopped, true);
    assert.equal(recorderStarted, false);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete (globalThis as Record<string, unknown>).navigator;
    if (previousMediaRecorder === undefined) delete globals.MediaRecorder;
    else globals.MediaRecorder = previousMediaRecorder;
  }
});

test('VoiceCapture.stop skips Whisper transcription when no audio chunks were captured', async () => {
  let fetchCalls = 0;
  let trackStopped = false;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousFetch = globalThis.fetch;
  const globals = globalThis as Record<string, unknown>;
  const previousMediaRecorder = globals.MediaRecorder;

  class MockMediaRecorder {
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(readonly stream: MediaStream) {}

    start(): void {}

    stop(): void {
      this.onstop?.();
    }
  }

  const stream = {
    getTracks: () => [{ stop: () => { trackStopped = true; } }],
  } as unknown as MediaStream;

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve(stream),
      },
    },
  });
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ text: 'transcribed' }) } as Response;
  }) as typeof fetch;
  delete globals.SpeechRecognition;
  delete globals.webkitSpeechRecognition;
  globals.MediaRecorder = MockMediaRecorder;

  try {
    const voiceCapture = new VoiceCapture({} as never, () => ({ whisperApiKey: 'sk-test' }) as never, () => {});
    voiceCapture.start();
    await Promise.resolve();
    await voiceCapture.stop();

    assert.equal(trackStopped, true);
    assert.equal(fetchCalls, 0);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete (globalThis as Record<string, unknown>).navigator;
    if (previousFetch) globalThis.fetch = previousFetch;
    else delete (globalThis as Record<string, unknown>).fetch;
    if (previousMediaRecorder === undefined) delete globals.MediaRecorder;
    else globals.MediaRecorder = previousMediaRecorder;
  }
});

test('VoiceCapture exposes bounded Whisper resource limits', () => {
  assert.equal(WHISPER_MAX_RECORDING_MS, 10 * 60 * 1000);
  assert.equal(WHISPER_MAX_AUDIO_BYTES, 24 * 1024 * 1024);
  assert.equal(WHISPER_REQUEST_TIMEOUT_MS, 60_000);
});

test('VoiceCapture aborts an oversized recording and releases tracks', async () => {
  let recorder!: MockMediaRecorder;
  let trackStops = 0;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const globals = globalThis as Record<string, unknown>;
  const previousMediaRecorder = globals.MediaRecorder;
  const rememberRecorder = (value: MockMediaRecorder): void => { recorder = value; };
  class MockMediaRecorder {
    state = 'recording';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(readonly stream: MediaStream) { rememberRecorder(this); }
    start(): void {}
    stop(): void { this.state = 'inactive'; this.onstop?.(); }
  }
  const stream = { getTracks: () => [{ stop: () => { trackStops += 1; } }] } as unknown as MediaStream;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  delete globals.SpeechRecognition; delete globals.webkitSpeechRecognition; globals.MediaRecorder = MockMediaRecorder;
  try {
    const capture = new VoiceCapture({} as never, () => ({ whisperApiKey: 'sk-test' }) as never, () => {});
    capture.start();
    await Promise.resolve();
    recorder.ondataavailable?.({ data: { size: WHISPER_MAX_AUDIO_BYTES + 1 } as Blob });
    assert.ok(trackStops > 0);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globals.navigator;
    if (previousMediaRecorder === undefined) delete globals.MediaRecorder; else globals.MediaRecorder = previousMediaRecorder;
  }
});

test('VoiceCapture abort cancels an in-flight Whisper body and prevents a late preview', async () => {
  let recorder!: MockMediaRecorder;
  let trackStopped = false;
  let fetchCalls = 0;
  let previews = 0;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousFetch = globalThis.fetch;
  const previousOpen = VoiceCapturePreviewModal.prototype.open;
  const globals = globalThis as Record<string, unknown>;
  const previousMediaRecorder = globals.MediaRecorder;
  const rememberRecorder = (value: MockMediaRecorder): void => { recorder = value; };
  class MockMediaRecorder {
    state = 'recording';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(readonly stream: MediaStream) { rememberRecorder(this); }
    start(): void {}
    stop(): void { this.state = 'inactive'; this.onstop?.(); }
  }
  const stream = { getTracks: () => [{ stop: () => { trackStopped = true; } }] } as unknown as MediaStream;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  delete globals.SpeechRecognition; delete globals.webkitSpeechRecognition; globals.MediaRecorder = MockMediaRecorder;
  VoiceCapturePreviewModal.prototype.open = function open(): void { previews += 1; };
  globalThis.fetch = (async () => { fetchCalls += 1; return new Response(new ReadableStream({ start() {} }), { status: 200 }); }) as typeof fetch;
  try {
    const capture = new VoiceCapture({} as never, () => ({ whisperApiKey: 'sk-test' }) as never, () => {});
    capture.start();
    await Promise.resolve();
    recorder.ondataavailable?.({ data: new Blob(['audio']) });
    const stopping = capture.stop();
    for (let index = 0; index < 10 && fetchCalls === 0; index += 1) await Promise.resolve();
    assert.equal(fetchCalls, 1);
    capture.abort();
    await stopping;
    assert.equal(trackStopped, true);
    assert.equal(previews, 0);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globals.navigator;
    globalThis.fetch = previousFetch;
    VoiceCapturePreviewModal.prototype.open = previousOpen;
    if (previousMediaRecorder === undefined) delete globals.MediaRecorder; else globals.MediaRecorder = previousMediaRecorder;
  }
});

test('VoiceCapturePreviewModal reserves plain Enter for editing and inserts on Ctrl+Enter', () => {
  let inserted = '';
  const modal = new VoiceCapturePreviewModal(
    {} as never,
    () => DEFAULT_SETTINGS,
    (taskLine) => { inserted = taskLine; },
    'Write docs tomorrow',
  );
  const contentEl = new FakeDOMElement('div');
  (modal as { contentEl: HTMLElement }).contentEl = contentEl as unknown as HTMLElement;

  let closed = false;
  (modal as { close: () => void }).close = () => { closed = true; };

  modal.onOpen();

  const keydown = contentEl.listeners.get('keydown');
  assert.equal(typeof keydown, 'function');

  let prevented = false;
  const event = (ctrlKey: boolean) => ({
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey,
    altKey: false,
    isComposing: false,
    preventDefault: () => { prevented = true; },
  });
  keydown?.(event(false));
  assert.equal(prevented, false);
  assert.equal(closed, false);

  keydown?.(event(true));
  assert.equal(prevented, true);
  assert.equal(closed, true);
  assert.match(inserted, /^- \[ \] /u);
  assert.match(inserted, /Write docs/u);
});
