import test from 'node:test';
import assert from 'node:assert/strict';

class MockTextComponent {
  inputEl: { type: string } = { type: 'text' };

  setPlaceholder(_value: string): this { return this; }
  setValue(_value: string): this { return this; }
  onChange(_callback: (value: string) => Promise<void>): this { return this; }
}

class MockToggleComponent {
  setValue(_value: boolean): this { return this; }
  onChange(_callback: (value: boolean) => Promise<void>): this { return this; }
}

class MockSetting {
  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(callback: (text: MockTextComponent) => void): this {
    const text = new MockTextComponent();
    createdTextComponents.push(text);
    callback(text);
    return this;
  }
  addToggle(callback: (toggle: MockToggleComponent) => void): this {
    callback(new MockToggleComponent());
    return this;
  }
}

const createdTextComponents: MockTextComponent[] = [];

test('Voice & AI settings renders the Whisper API key as a password field', () => {
  const obsidianModule = require('obsidian') as { Setting: unknown };
  const originalSetting = obsidianModule.Setting;
  const modulePath = require.resolve('../src/settings/voice-ai-section');
  delete require.cache[modulePath];
  obsidianModule.Setting = MockSetting;
  createdTextComponents.length = 0;

  try {
    const { renderVoiceAndAiSection } = require('../src/settings/voice-ai-section') as typeof import('../src/settings/voice-ai-section');
    const containerEl = { createEl: () => ({}) } as unknown as HTMLElement;
    const plugin = {
      settings: {
        whisperApiKey: 'sk-secret',
        aiQueryEnabled: false,
        weeklyReviewEnabled: false,
        weeklyReviewInboxPath: '',
        orgModeEnabled: false,
      },
      saveSettings: async () => {},
    };

    renderVoiceAndAiSection(containerEl, plugin as never, () => {});

    assert.equal(createdTextComponents[0]?.inputEl.type, 'password');
  } finally {
    obsidianModule.Setting = originalSetting;
    delete require.cache[modulePath];
  }
});
