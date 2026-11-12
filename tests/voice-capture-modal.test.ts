import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'obsidian';
import { VoiceCaptureRecordingModal } from '../src/modals/voice-capture-modal';
import type { VoiceCapture } from '../src/voice-capture';
import { installDomHarness } from './dom-harness';

test('voice recording modal stops into preview and releases keyboard state', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  let stops = 0;
  let aborts = 0;
  const capture = {
    start: (onInterim: (value: string) => void) => { onInterim('heard task'); },
    stop: async () => { stops += 1; },
    abort: () => { aborts += 1; },
  } as unknown as VoiceCapture;
  const modal = new VoiceCaptureRecordingModal({} as App, capture);
  const content = harness.document.createElement('div');
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();
  assert.match(content.textContent ?? '', /heard task/u);
  const stop = Array.from(content.querySelectorAll<HTMLButtonElement>('button')).find((button) => /Stop/u.test(button.textContent ?? ''));
  assert.ok(stop);
  stop.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stops, 1);
  modal.onClose();
  assert.equal(aborts, 0);
  assert.equal(content.children.length, 0);
});
