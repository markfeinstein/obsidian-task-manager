import { Notice, Setting } from 'obsidian';
import { t } from '../i18n';
import { isSafeLocalAiEndpoint, LOCAL_AI_ENDPOINT_ERROR } from '../ai-endpoint-safety';
import { type AiQueryProvider, applyAiProviderDefaults, defaultAiEndpointForProvider, defaultAiModelForProvider } from '../types';
import type { SettingsHost } from '../settings-contract';

/**
 * Render the Voice & AI settings section.
 */
export function renderVoiceAndAiSection(
  containerEl: HTMLElement,
  plugin: SettingsHost,
  display: () => void,
): void {
// ── AI Query Expansion ──
containerEl.createEl('h3', { text: t('settings.voiceAi.voiceCapture') });
containerEl.createEl('p', {
  text: t('settings.voiceAi.recordAudioAndConvertSpeechToAStructuredTaskThe'),
  cls: 'setting-item-description',
});
new Setting(containerEl)
  .setName(t('settings.voiceAi.whisperApiKeyOptional'))
  .setDesc(t('settings.voiceAi.openaiWhisperApiKeyForVoiceTranscriptionFallbackLeaveBlank'))
  .addText((text) => {
    text.inputEl.type = 'password';
    text
      .setPlaceholder(t('settings.voiceAi.sk'))
      .setValue(plugin.settings.whisperApiKey)
      .onChange(async (value) => {
        plugin.settings.whisperApiKey = value.trim();
        await plugin.saveSettings();
      });
  });

containerEl.createEl('h3', { text: t('settings.voiceAi.aiQueryExpansion') });
containerEl.createEl('p', { text: t('settings.voiceAi.useAnAiLanguageModelToTranslateTheQuestionYou'), cls: 'setting-item-description' });
new Setting(containerEl)
  .setName(t('settings.voiceAi.enableAiQueryExpansion'))
  .setDesc(t('settings.voiceAi.activateTheAiQueryFeature'))
  .addToggle((toggle) => toggle.setValue(plugin.settings.aiQueryEnabled).onChange(async (value) => {
    plugin.settings.aiQueryEnabled = value;
    await plugin.saveSettings();
    display();
  }));
if (plugin.settings.aiQueryEnabled) {
  new Setting(containerEl)
    .setName(t('settings.voiceAi.aiProvider'))
    .setDesc(t('settings.voiceAi.languageModelProviderToUse'))
    .addDropdown((d) => d
      .addOption('openai', 'OpenAI')
      .addOption('anthropic', 'Anthropic')
      .addOption('ollama', 'Ollama (local)')
      .addOption('lm-studio', 'LM Studio (local)')
      .setValue(plugin.settings.aiQueryProvider)
      .onChange(async (value) => {
        const provider: AiQueryProvider = value === 'anthropic' || value === 'ollama' || value === 'lm-studio' ? value : 'openai';
        plugin.settings.aiQueryProvider = provider;
        applyAiProviderDefaults(plugin.settings, provider);
        if ((provider === 'ollama' || provider === 'lm-studio') && !isSafeLocalAiEndpoint(plugin.settings.aiQueryLocalEndpoint)) {
          plugin.settings.aiQueryLocalEndpoint = defaultAiEndpointForProvider(provider);
        }
        await plugin.saveSettings();
        display();
      }));
  if (plugin.settings.aiQueryProvider === 'anthropic') {
    new Setting(containerEl)
      .setName(t('aiQuery.browserAccessLabel'))
      .setDesc(t('aiQuery.browserAccessDescription'))
      .addToggle((toggle) => toggle.setValue(plugin.settings.aiQueryAnthropicBrowserAccess).onChange(async (value) => {
        plugin.settings.aiQueryAnthropicBrowserAccess = value;
        await plugin.saveSettings();
      }));
  }
  const localAiProvider = plugin.settings.aiQueryProvider === 'ollama' || plugin.settings.aiQueryProvider === 'lm-studio';
  if (!localAiProvider) {
    new Setting(containerEl)
      .setName(t('settings.voiceAi.aiApiKey'))
      .setDesc(t('settings.voiceAi.apiKeyForTheSelectedProvider'))
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder(t('settings.voiceAi.sk')).setValue(plugin.settings.aiQueryApiKey).onChange(async (value) => {
          plugin.settings.aiQueryApiKey = value.trim();
          await plugin.saveSettings();
        });
      });
  } else {
    new Setting(containerEl)
      .setName(t('settings.voiceAi.localAiEndpoint'))
      .setDesc(t('settings.voiceAi.openaiCompatibleChatCompletionsEndpointOllamaDefaultHttpLocalhost11434'))
      .addText((text) => text.setPlaceholder(defaultAiEndpointForProvider(plugin.settings.aiQueryProvider)).setValue(plugin.settings.aiQueryLocalEndpoint).onChange(async (value) => {
        const endpoint = value.trim() || defaultAiEndpointForProvider(plugin.settings.aiQueryProvider);
        if (!isSafeLocalAiEndpoint(endpoint)) {
          new Notice(LOCAL_AI_ENDPOINT_ERROR);
          text.setValue(plugin.settings.aiQueryLocalEndpoint || defaultAiEndpointForProvider(plugin.settings.aiQueryProvider));
          return;
        }
        plugin.settings.aiQueryLocalEndpoint = endpoint;
        await plugin.saveSettings();
      }));
  }
  new Setting(containerEl)
    .setName(t('settings.voiceAi.aiModel'))
    .setDesc(t('settings.voiceAi.modelNameEGGpt4oMiniClaudeHaiku4'))
    .addText((text) => text.setPlaceholder(defaultAiModelForProvider(plugin.settings.aiQueryProvider)).setValue(plugin.settings.aiQueryModel).onChange(async (value) => {
      plugin.settings.aiQueryModel = value.trim() || defaultAiModelForProvider(plugin.settings.aiQueryProvider);
      await plugin.saveSettings();
    }));
}

// ── Weekly Review ──
containerEl.createEl('h3', { text: t('settings.voiceAi.weeklyReview') });
containerEl.createEl('p', { text: t('settings.voiceAi.aGuidedGtdStyleWeeklyReviewWorkflowUseTheStart'), cls: 'setting-item-description' });
new Setting(containerEl)
  .setName(t('settings.voiceAi.enableWeeklyReview'))
  .setDesc(t('settings.voiceAi.showTheWeeklyReviewCommandInTheCommandPalette'))
  .addToggle((toggle) => toggle.setValue(plugin.settings.weeklyReviewEnabled).onChange(async (value) => {
    plugin.settings.weeklyReviewEnabled = value;
    await plugin.saveSettings();
  }));
new Setting(containerEl)
  .setName(t('settings.voiceAi.inboxNotePath'))
  .setDesc(t('settings.voiceAi.theInboxNoteToProcessDuringTheWeeklyReviewDefaults'))
  .addText((text) => text.setPlaceholder(t('settings.voiceAi.inboxMd')).setValue(plugin.settings.weeklyReviewInboxPath).onChange(async (value) => {
    plugin.settings.weeklyReviewInboxPath = value.trim();
    await plugin.saveSettings();
  }));

// ── Org-mode compatibility (#9) ──
containerEl.createEl('h3', { text: t('settings.voiceAi.orgModeCompatibility') });
new Setting(containerEl)
  .setName(t('settings.voiceAi.enableOrgModeTaskFormat'))
  .setDesc(
    'When enabled, lines matching `- TODO: task text`, `- DONE: task text`, etc. are recognised as tasks '
    + 'in addition to the standard `- [ ] task text` checkbox format. '
    + 'Supported keywords: TODO, DOING, DONE, NOW, LATER, WAIT, WAITING, CANCELLED, CLOSED.',
  )
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.orgModeEnabled).onChange(async (value) => {
      plugin.settings.orgModeEnabled = value;
      await plugin.saveSettings();
    }),
  );

}
