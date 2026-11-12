/**
 * ai-query-modal.ts
 *
 * AI-powered natural-language query modal.  Extracted from main.ts.
 * Uses fetchWithTimeout (defined locally to avoid circular import from main.ts).
 */

import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { FocusManager, FocusTrap } from '../keyboard-nav';
import type { TaskManagerSettings } from '../types';
import type { TaskScanner } from '../task-scanner';
import { defaultAiEndpointForProvider, defaultAiModelForProvider } from '../types';
import { isSafeLocalAiEndpoint, LOCAL_AI_ENDPOINT_ERROR } from '../ai-endpoint-safety';
import { AI_NETWORK_MAX_BYTES, requestResponse } from '../network-request';
import { AI_QUERY_PROMPT_MAX_BYTES, utf8ByteLength } from '../input-budgets';
import { parseTaskQuery } from '../task-query';
import { t } from '../i18n';

export function serializeAiQueryBlock(query: string, blockName: string): string {
  const longest = Math.max(0, ...Array.from(query.matchAll(/`+/gu), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${blockName}\n${query}\n${fence}\n`;
}

export async function buildAiQueryApiError(response: Response, providerLabel: string): Promise<Error> {
  const baseMessage = `${providerLabel} API error ${response.status}`;
  let detail = '';
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = (await response.json()) as {
        error?: string | { message?: string; type?: string; code?: string };
        message?: string;
        detail?: string;
        error_description?: string;
      };
      const structuredError = typeof data.error === 'string' ? undefined : data.error;
      const detailParts = [
        typeof data.error === 'string' ? data.error : undefined,
        structuredError?.message,
        data.error_description,
        data.message,
        data.detail,
        structuredError?.code,
        structuredError?.type,
      ].filter((part, index, parts): part is string => Boolean(part) && parts.indexOf(part) === index);
      detail = detailParts.join(' — ');
    } else {
      const text = (await response.text()).trim();
      if (text) detail = text.slice(0, 500);
    }
  } catch {
    // Fall back to the status-only message if the error body is unreadable.
  }
  return new Error(detail ? `${baseMessage} - ${detail}` : baseMessage);
}

let aiQueryInputSequence = 0;

export class AiQueryModal extends Modal {
  private focusTrap: FocusTrap | null = null;
  private focusManager = new FocusManager();
  private requestController: AbortController | null = null;

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly scanner: TaskScanner,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.modalEl.setAttribute('aria-label', t('aiQuery.title'));
    contentEl.createEl('h3', { text: t('aiQuery.title') });
    contentEl.createEl('p', { text: t('aiQuery.description'), cls: 'ai-query-desc' });
    const inputId = `task-manager-ai-query-${aiQueryInputSequence++}`;
    const inputLabel = contentEl.createEl('label', { text: t('aiQuery.requestLabel') });
    inputLabel.htmlFor = inputId;
    const input = contentEl.createEl('textarea', { cls: 'ai-query-input' });
    input.id = inputId;
    input.placeholder = t('aiQuery.requestPlaceholder');
    input.rows = 3;
    const resultEl = contentEl.createDiv({ cls: 'ai-query-result' });
    resultEl.setAttr('role', 'status');
    resultEl.setAttr('aria-live', 'polite');
    resultEl.setAttr('aria-atomic', 'true');
    const btnRow = contentEl.createDiv({ cls: 'ai-query-btns' });
    const searchBtn = btnRow.createEl('button', { text: t('aiQuery.generate'), cls: 'mod-cta' });
    const cancelBtn = btnRow.createEl('button', { text: t('modal.btn.cancel') });
    cancelBtn.addEventListener('click', () => { this.close(); });
    searchBtn.addEventListener('click', () => { void (async () => {
      const prompt = input.value.trim();
      if (!prompt) return;
      if (utf8ByteLength(prompt) > AI_QUERY_PROMPT_MAX_BYTES) {
        resultEl.empty();
        const errorEl = resultEl.createEl('p', { text: t('aiQuery.requestTooLarge'), cls: 'ai-query-error' });
        errorEl.setAttr('role', 'alert');
        return;
      }
      searchBtn.disabled = true;
      searchBtn.textContent = t('aiQuery.thinking');
      contentEl.setAttr('aria-busy', 'true');
      resultEl.empty();
      resultEl.setText(t('aiQuery.generating'));
      try {
        const query = await this.callAiApi(prompt);
        const parsed = parseTaskQuery(query, {
          savedQueries: this.settings.savedQueries,
          enableQueryDsl: this.settings.enableQueryDsl,
          enableDslExpressions: this.settings.enableDslExpressions,
          nlpQueryEnabled: this.settings.nlpQueryEnabled,
        });
        if (parsed.errors.length > 0) throw new Error(parsed.errors.join('; '));
        const blockName = this.settings.queryCodeBlockName || 'task-list';
        const serialized = serializeAiQueryBlock(query, blockName);
        resultEl.empty();
        resultEl.createEl('pre', { text: serialized, cls: 'ai-query-dsl' });
        const insertBtn = resultEl.createEl('button', { text: t('aiQuery.insert'), cls: 'mod-cta' });
        insertBtn.addEventListener('click', () => {
          const rechecked = parseTaskQuery(query, {
            savedQueries: this.settings.savedQueries,
            enableQueryDsl: this.settings.enableQueryDsl,
            enableDslExpressions: this.settings.enableDslExpressions,
            nlpQueryEnabled: this.settings.nlpQueryEnabled,
          });
          if (rechecked.errors.length > 0) return;
          const leaf = this.app.workspace.getMostRecentLeaf();
          const view = leaf?.view as { editor?: { replaceSelection?: (t: string) => void } };
          view?.editor?.replaceSelection?.(serialized);
          this.close();
        });
      } catch (error) {
        resultEl.empty();
        const errorEl = resultEl.createEl('p', { text: t('aiQuery.error', { message: error instanceof Error ? error.message : String(error) }), cls: 'ai-query-error' });
        errorEl.setAttr('role', 'alert');
      } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = t('aiQuery.generate');
        contentEl.setAttr('aria-busy', 'false');
      }
    })(); });
    this.focusTrap = new FocusTrap(contentEl);
  }

  private async requestAi(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    try {
      return await requestResponse(input, init, { signal: controller.signal, maxBytes: AI_NETWORK_MAX_BYTES, redirect: 'error' });
    } finally {
      if (this.requestController === controller) this.requestController = null;
    }
  }

  private async callAiApi(userPrompt: string): Promise<string> {
    const systemPrompt = [
      'You are a task management query assistant. Convert natural language into a Task Manager DSL query.',
      'Available filter keywords: not done, done, due before/after/on DATE, scheduled before/after/on DATE,',
      'priority is high/medium/low, path includes TEXT, tag includes TEXT, has context, context includes TEXT,',
      'is recurring, is blocked, description includes TEXT.',
      'Available sort: sort by smart, sort by urgency, sort by due, sort by priority.',
      'Available group: group by status, group by priority, group by folder.',
      'Other: limit N, show tree, not done.',
      'Return ONLY the raw query text, no explanation, no code fences.',
    ].join('\n');

    const provider = this.settings.aiQueryProvider;
    const localProvider = provider === 'ollama' || provider === 'lm-studio';
    if (!localProvider && !this.settings.aiQueryApiKey.trim()) throw new Error(t('aiQuery.apiKeyRequired'));
    if (provider === 'anthropic') {
      if (!this.settings.aiQueryAnthropicBrowserAccess) throw new Error(t('aiQuery.browserAccessRequired'));
      const resp = await this.requestAi('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.settings.aiQueryApiKey.trim(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.settings.aiQueryModel || defaultAiModelForProvider(provider), max_tokens: 512, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
      });
      if (!resp.ok) throw await buildAiQueryApiError(resp, 'Anthropic');
      const data = (await resp.json()) as { content?: Array<{ type?: string; text?: string }> };
      const query = Array.isArray(data.content) ? data.content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').trim() : '';
      if (!query) throw new Error(t('aiQuery.emptyResponse'));
      return query;
    }

    const endpoint = localProvider
      ? (this.settings.aiQueryLocalEndpoint.trim() || defaultAiEndpointForProvider(provider))
      : 'https://api.openai.com/v1/chat/completions';
    if (localProvider && !isSafeLocalAiEndpoint(endpoint)) {
      throw new Error(LOCAL_AI_ENDPOINT_ERROR);
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!localProvider) headers.Authorization = `Bearer ${this.settings.aiQueryApiKey.trim()}`;
    const resp = await this.requestAi(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.settings.aiQueryModel || defaultAiModelForProvider(provider),
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        max_tokens: 512,
        temperature: 0.1,
        ...(localProvider ? {} : { store: false }),
      }),
    });
    if (!resp.ok) throw await buildAiQueryApiError(resp, localProvider ? 'Local AI' : 'OpenAI');
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string }; text?: string }> };
    const query = data.choices?.[0]?.message?.content?.trim() ?? data.choices?.[0]?.text?.trim() ?? '';
    if (!query) throw new Error(t('aiQuery.emptyResponse'));
    return query;
  }

  onClose(): void {
    this.requestController?.abort();
    this.requestController = null;
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.focusManager.restoreFocus();
    this.contentEl.empty();
  }
}
