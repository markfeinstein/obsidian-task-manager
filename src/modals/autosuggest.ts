/**
 * autosuggest.ts
 *
 * TaskManagerAutoSuggest — CodeMirror 6 EditorSuggest for in-editor task
 * auto-completion.  Extracted from main.ts.
 */

import { EditorSuggest, getAllTags } from 'obsidian';
import type { App, EditorSuggestContext } from 'obsidian';
import { DEFAULT_SETTINGS, type TaskManagerSettings } from '../types';
import { todayString } from '../date-utils';
import {
  parseEditableTaskLine,
  suggestionDuplicatesExistingField,
  autoSuggestDynamicSuggestions,
  buildSlashSuggestions,
  resolveSlashSuggestion,
  buildNlDateTokens,
  resolveNlTaskDescription,
  buildAtAssigneeSuggestions,
  resolveSuggestionValue,
} from './task-edit-helpers';
import { DependencySuggestModal } from './dependency-modals';

export class TaskManagerAutoSuggest extends EditorSuggest<string> {
  constructor(
    private readonly appRef: App,
    private readonly getSettings: () => TaskManagerSettings = () => DEFAULT_SETTINGS,
  ) {
    super(appRef);
  }

  private readonly suggestions = [
    '📅 due date', '📅 today', '📅 tomorrow', '📅 Sunday', '📅 Monday', '📅 Tuesday', '📅 Wednesday', '📅 Thursday', '📅 Friday', '📅 Saturday', '📅 next week', '📅 next month', '📅 next year', '📆 today', '🗓 today',
    '⏳ scheduled date', '⏳ today', '⏳ tomorrow', '⏳ Sunday', '⏳ Monday', '⏳ Tuesday', '⏳ Wednesday', '⏳ Thursday', '⏳ Friday', '⏳ Saturday', '⏳ next week', '⏳ next month', '⏳ next year', '⌛ today',
    '🛫 start date', '🛫 today', '🛫 tomorrow', '🛫 Sunday', '🛫 Monday', '🛫 Tuesday', '🛫 Wednesday', '🛫 Thursday', '🛫 Friday', '🛫 Saturday', '🛫 next week', '🛫 next month', '🛫 next year',
    '➕ created today', '✅ done today', '❌ cancelled today', '⏰ reminder today 09:00', '⏰ tomorrow 09:00',
    '🔺 highest priority', '⏫ high priority', '🔼 medium priority', '🔽 low priority', '⏬ lowest priority',
    '🔁 recurring (repeat)', '🔁 every day', '🔁 every weekday', '🔁 every 3 days', '🔁 every 10 days when done', '🔁 every week', '🔁 every week when done', '🔁 every week on Sunday', '🔁 every week on Tuesday, Friday', '🔁 every 2 weeks', '🔁 every 3 weeks on Friday', '🔁 every month', '🔁 every month on the 1st', '🔁 every month on the last', '🔁 every month on the last Friday', '🔁 every month on the 2nd last Friday', '🔁 every year', '🔁 every January on the 15th',
    `🔁 every week until ${new Date().getFullYear() + 1}-12-31`, '🔁 every month for 3 times', '🔁 every day for 7 times', `🔁 every year until ${new Date().getFullYear() + 4}-12-31`,
    '⌚ 09:00', '⌚ 10:00', '⌚ 14:00', '⌚ 17:00',
    '🏁 on completion', '🏁 keep', '🏁 delete', '🏁 archive', '🏁 collect', '🏁 move-to-end', '🆔 id', '🆔 generate id', '⛔ depends on id',
    '[due:: date]', '[due:: today]', '[due:: tomorrow]', '[due:: next week]', '[due:: next month]', '[scheduled:: date]', '[scheduled:: today]', '[scheduled:: tomorrow]', '[start:: date]', '[start:: today]', '[start:: tomorrow]', '[created:: today]', '[completion:: today]', '[cancelled:: today]', '[reminder:: today 09:00]', '[repeat:: every week]', '[onCompletion:: delete]', '[id:: generate id]', '[dependsOn:: id]',
    'TQ_extra_instructions', 'TQ_short_mode', 'TQ_show_tree', 'TQ_show_toolbar', 'TQ_show_backlink', 'TQ_show_edit_button', 'TQ_show_postpone_button',
  ];

  onTrigger(cursor: { line: number; ch: number }, editor: { getLine(line: number): string }): { start: { line: number; ch: number }; end: { line: number; ch: number }; query: string } | null {
    const line = editor.getLine(cursor.line);
    const settings = this.getSettings();
    const lineHasGlobalFilter = !settings.globalFilter || line.toLowerCase().includes(settings.globalFilter.toLowerCase());
    const integrationDecision = (editor as { showTasksPluginAutoSuggest?: (cursor: { line: number; ch: number }, editor: unknown, lineHasGlobalFilter: boolean) => boolean | undefined }).showTasksPluginAutoSuggest?.(cursor, editor, lineHasGlobalFilter);
    if (integrationDecision === false) return null;
    if (integrationDecision !== true && !/^(?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[[^\]]*\]/u.test(line)) return null;
    if (!settings.autoSuggestInEditor) return null;
    if (!lineHasGlobalFilter) return null;
    const parsed = parseEditableTaskLine(line);
    const stateType = settings.supportedStates.find((state) => state.rawText === parsed.checkbox)?.type ?? 'untracked';
    const before = line.slice(0, cursor.ch);
    const isSlashQuery = settings.slashCommandsInEditor && /(?:^|\s)(\/[\p{L}\p{N}_ -]{0,60})$/u.test(before);
    const isAtQuery = settings.atAssigneeInEditor && /(?:^|\s)(@[\p{L}\p{N}._-]*)$/u.test(before);
    if (stateType === 'untracked' && !isSlashQuery && !isAtQuery) return null;

    if (settings.atAssigneeInEditor) {
      const atMatch = before.match(/(?:^|\s)(@[\p{L}\p{N}._-]*)$/u);
      if (atMatch) {
        const token = atMatch[1];
        return { start: { line: cursor.line, ch: cursor.ch - token.length }, end: cursor, query: token };
      }
    }

    if (settings.slashCommandsInEditor) {
      const nlMatch = before.match(/(?:^|\s)(\/(?:when|dates?|date)\b[^/]*)$/u);
      if (nlMatch) {
        const token = nlMatch[1];
        return { start: { line: cursor.line, ch: cursor.ch - token.length }, end: cursor, query: token };
      }
      const slashMatch = before.match(/(?:^|\s)(\/[\p{L}\p{N}_ -]{0,60})$/u);
      if (slashMatch) {
        const token = slashMatch[1];
        return { start: { line: cursor.line, ch: cursor.ch - token.length }, end: cursor, query: token };
      }
    }

    const tokenMatch = before.match(/(?:^|\s)([\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,40})$/u) || before.match(/(?:^|\s)(#[\p{L}\p{N}_/-]*)$/u);
    const token = tokenMatch?.[1] ?? '';
    if (token.length < settings.autoSuggestMinMatch && settings.autoSuggestMinMatch > 0) return null;
    return { start: { line: cursor.line, ch: cursor.ch - token.length }, end: cursor, query: token };
  }

  async getSuggestions(context: EditorSuggestContext): Promise<string[]> {
    const query = context.query.toLowerCase().trim();
    const line = context.editor.getLine(context.start.line) ?? '';
    const parsed = parseEditableTaskLine(line);
    const dataviewMode = /[\[(][^\])]*$/u.test(line.slice(0, context.end.ch ?? line.length)) || parsed.usesDataview;

    if (context.query.startsWith('@')) return this.getAtAssigneeSuggestions(context.query);
    if (context.query.startsWith('/')) return buildSlashSuggestions(context.query, todayString()).slice(0, this.getSettings().autoSuggestMaxItems);
    if (query.startsWith('#')) return this.getTagSuggestions(query, line);

    const dynamic = autoSuggestDynamicSuggestions(query, dataviewMode);
    const staticMatches = this.suggestions
      .filter((s) => dataviewMode ? s.startsWith('[') : !s.startsWith('['))
      .filter((s) => !query || s.toLowerCase().includes(query) || s.toLowerCase().includes(query.replace(/^in\s+/u, '')));
    const suggestions = [...dynamic, ...staticMatches]
      .filter((s) => !suggestionDuplicatesExistingField(s, parsed))
      .filter((s, i, arr) => arr.indexOf(s) === i);
    if (query && suggestions.length === 0) suggestions.push('⏎ new line');
    return suggestions.slice(0, this.getSettings().autoSuggestMaxItems);
  }

  private getTagSuggestions(query: string, line: string): string[] {
    const searchTerm = query.slice(1).toLowerCase();
    const vaultTags = new Set<string>();
    for (const file of this.appRef.vault.getMarkdownFiles()) {
      const cache = this.appRef.metadataCache.getFileCache(file);
      if (cache) {
        const tags = getAllTags(cache);
        if (tags) {
          for (const tag of tags) {
            vaultTags.add(tag.startsWith('#') ? tag.slice(1) : tag);
          }
        }
      }
    }
    const existingTags = new Set<string>();
    const tagRegex = /#([\p{L}\p{N}_/-]+)/gu;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(line)) !== null) existingTags.add(match[1].toLowerCase());

    return Array.from(vaultTags)
      .filter((tag) => !existingTags.has(tag.toLowerCase()))
      .filter((tag) => !searchTerm || tag.toLowerCase().includes(searchTerm))
      .sort()
      .slice(0, this.getSettings().autoSuggestMaxItems);
  }

  private async getAtAssigneeSuggestions(query: string): Promise<string[]> {
    const known = new Set<string>();
    await Promise.all(this.appRef.vault.getMarkdownFiles().map(async (file) => {
      try {
        const text = await this.appRef.vault.cachedRead(file);
        for (const match of text.matchAll(/(?:^|\s)👤\uFE0F?\s*@([\p{L}\p{N}._/-]+)/gu)) {
          if (match[1]) known.add(match[1]);
        }
      } catch {
        // Ignore unreadable files; autosuggest should stay usable.
      }
    }));
    return buildAtAssigneeSuggestions(query, Array.from(known));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    if (value.startsWith('/')) {
      // /nl <description> — show NL-expanded preview
      if (/^\/(?:nl|task)\b/u.test(value)) {
        const spaceIdx = value.indexOf(' ');
        const description = spaceIdx === -1 ? '' : value.slice(spaceIdx + 1);
        const cmdEl = el.createSpan({ cls: 'task-manager-suggest-cmd' });
        cmdEl.setText('/nl');
        cmdEl.style.cssText = 'color: var(--color-accent, var(--interactive-accent)); font-size: 0.85em; margin-right: 6px;';
        if (description) {
          const preview = resolveNlTaskDescription(description, todayString());
          el.appendText(preview !== description ? preview : description);
        } else {
          el.appendText('type task description… (parsed as natural language)');
        }
        return;
      }
      if (/^\/(?:when|dates?|date)\b/u.test(value)) {
        const spaceIdx = value.indexOf(' ');
        const instruction = spaceIdx === -1 ? '' : value.slice(spaceIdx + 1);
        const preview = buildNlDateTokens(instruction);
        const cmdEl = el.createSpan({ cls: 'task-manager-suggest-cmd' });
        cmdEl.setText('/when');
        cmdEl.style.cssText = 'color: var(--text-muted); font-size: 0.85em; margin-right: 6px;';
        el.appendText(preview || instruction);
        return;
      }
      const spaceIdx = value.indexOf(' ');
      if (spaceIdx !== -1) {
        const cmd = value.slice(1, spaceIdx);
        const label = value.slice(spaceIdx + 1);
        const cmdEl = el.createSpan({ cls: 'task-manager-suggest-cmd' });
        cmdEl.setText(`/${cmd}`);
        cmdEl.style.cssText = 'color: var(--text-muted); font-size: 0.85em; margin-right: 6px;';
        el.appendText(label);
        return;
      }
    }
    if (value.startsWith('@')) { el.setText(`👤 ${value}`); return; }
    el.setText(value);
  }

  selectSuggestion(value: string): void {
    if (!this.context) return;
    if (value === '⏎ new line') { this.context.editor.replaceRange('\n', this.context.start, this.context.end); return; }
    if (this.context.query?.startsWith('/')) {
      this.context.editor.replaceRange(resolveSlashSuggestion(value, todayString()), this.context.start, this.context.end);
      return;
    }
    if (this.context.query?.startsWith('@')) {
      const name = value.replace(/\s*\(new assignee\)$/u, '').replace(/^@/u, '');
      this.context.editor.replaceRange(`👤 @${name}`, this.context.start, this.context.end);
      return;
    }
    if (this.context.query?.startsWith('#')) {
      this.context.editor.replaceRange(`#${value}`, this.context.start, this.context.end);
      return;
    }
    const dataview = value.startsWith('[dependsOn::');
    if (value === '⛔ depends on id' || dataview) {
      const prefix = dataview ? '[dependsOn:: ' : '⛔ ';
      const suffix = dataview ? ']' : '';
      const start = this.context.start;
      const end = this.context.end;
      this.context.editor.replaceRange(`${prefix}${suffix}`, start, end);
      new DependencySuggestModal(this.appRef, this.getSettings(), (dependencyId) => {
        this.context?.editor.replaceRange(dependencyId, { line: start.line, ch: start.ch + prefix.length });
      }, this.appRef.workspace.getActiveFile()?.path).open();
      return;
    }
    this.context.editor.replaceRange(resolveSuggestionValue(value), this.context.start, this.context.end);
  }
}
