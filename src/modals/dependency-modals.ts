/**
 * dependency-modals.ts
 *
 * DependencySuggestModal and DependentTaskSuggestModal, plus the helper
 * functions they need.  Extracted from main.ts.
 */

import { SuggestModal, TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import { parseEditableTaskLine, formatEditableTaskLine, randomTaskId } from './task-edit-helpers';
import { scannableMarkdownFiles } from './modal-utils';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DependencySuggestion {
  file: TFile;
  lineNumber: number;
  line: string;
  description: string;
  id: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export async function collectDependencySuggestions(
  app: App,
  settings: TaskManagerSettings,
  sourcePath?: string,
): Promise<DependencySuggestion[]> {
  const suggestions: DependencySuggestion[] = [];
  for (const file of scannableMarkdownFiles(app, settings)) {
    const content = await app.vault.read(file);
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/^(?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\s+/u.test(line)) continue;
      if (settings.globalFilter && !line.toLowerCase().includes(settings.globalFilter.toLowerCase())) continue;
      const parsed = parseEditableTaskLine(line);
      if (!isActionableEditableStatus(parsed.checkbox, settings)) continue;
      if (parsed.description.includes('<%') && parsed.description.includes('%>')) continue;
      suggestions.push({ file, lineNumber: index + 1, line, description: parsed.description || line, id: parsed.id });
    }
  }
  return suggestions.sort(
    (left, right) =>
      Number(right.file.path === sourcePath) - Number(left.file.path === sourcePath)
      || left.description.localeCompare(right.description)
      || left.file.path.localeCompare(right.file.path),
  );
}

export function isActionableEditableStatus(marker: string, settings: TaskManagerSettings): boolean {
  const type = settings.supportedStates.find((s) => s.rawText === marker)?.type ?? 'todo';
  return type !== 'done' && type !== 'cancelled' && type !== 'untracked';
}

// ── DependencySuggestModal ───────────────────────────────────────────────────

export class DependencySuggestModal extends SuggestModal<DependencySuggestion> {
  private suggestions: DependencySuggestion[] = [];

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly onChooseId: (id: string) => void,
    private readonly sourcePath?: string,
  ) {
    super(app);
    this.setPlaceholder('Search tasks to depend on');
  }

  async onOpen(): Promise<void> {
    void super.onOpen();
    this.suggestions = await collectDependencySuggestions(this.app, this.settings, this.sourcePath);
  }

  getSuggestions(query: string): DependencySuggestion[] {
    const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
    return this.suggestions
      .filter((s) => terms.every((term) => `${s.description} ${s.file.path}`.toLowerCase().includes(term)))
      .slice(0, 20);
  }

  renderSuggestion(suggestion: DependencySuggestion, el: HTMLElement): void {
    el.createEl('div', { text: suggestion.description });
    el.createEl('small', { text: `${suggestion.id || '(will generate id)'} · ${suggestion.file.path}:${suggestion.lineNumber}` });
  }

  onChooseSuggestion(suggestion: DependencySuggestion): void {
    void this.ensureSuggestionId(suggestion).then((id) => this.onChooseId(id));
  }

  private async ensureSuggestionId(suggestion: DependencySuggestion): Promise<string> {
    if (suggestion.id) return suggestion.id;
    const id = randomTaskId();
    await this.app.vault.process(suggestion.file, (content) => {
      const lines = content.split(/(\r\n|\n|\r)/u);
      const textIndex = (suggestion.lineNumber - 1) * 2;
      if (textIndex >= 0 && textIndex < lines.length && !/(?:^|\s)🆔\s+\S+/u.test(lines[textIndex])) {
        lines[textIndex] = `${lines[textIndex]} 🆔 ${id}`;
      }
      return lines.join('');
    });
    return id;
  }
}

// ── DependentTaskSuggestModal ────────────────────────────────────────────────

export class DependentTaskSuggestModal extends SuggestModal<DependencySuggestion> {
  private suggestions: DependencySuggestion[] = [];

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly currentTaskId: () => string,
    private readonly sourcePath?: string,
  ) {
    super(app);
    this.setPlaceholder('Search tasks that should depend on this task');
  }

  async onOpen(): Promise<void> {
    void super.onOpen();
    this.suggestions = await collectDependencySuggestions(this.app, this.settings, this.sourcePath);
  }

  getSuggestions(query: string): DependencySuggestion[] {
    const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
    return this.suggestions
      .filter((s) => terms.every((term) => `${s.description} ${s.file.path}`.toLowerCase().includes(term)))
      .slice(0, 20);
  }

  renderSuggestion(suggestion: DependencySuggestion, el: HTMLElement): void {
    el.createEl('div', { text: suggestion.description });
    el.createEl('small', { text: `${suggestion.file.path}:${suggestion.lineNumber}` });
  }

  onChooseSuggestion(suggestion: DependencySuggestion): void {
    const id = this.currentTaskId();
    void this.app.vault.process(suggestion.file, (content) => {
      const lines = content.split(/(\r\n|\n|\r)/u);
      const textIndex = (suggestion.lineNumber - 1) * 2;
      if (textIndex < 0 || textIndex >= lines.length) return content;
      const parsed = parseEditableTaskLine(lines[textIndex]);
      const existing = parsed.dependsOn.split(/\s*,\s*/u).filter(Boolean);
      if (!existing.includes(id)) existing.push(id);
      lines[textIndex] = formatEditableTaskLine({ ...parsed, dependsOn: existing.join(',') }, this.settings.taskFormat);
      return lines.join('');
    });
  }
}
