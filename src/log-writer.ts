import { moment } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { TaskManagerSettings } from './types';

export interface LogEntry {
  text: string;
  sourcePath?: string;
  completedAt: Date;
  /** Stable idempotency marker for completion-log reconciliation. */
  completionId?: string;
}

export class LogWriter {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => TaskManagerSettings,
  ) {}

  formatLogLine(dailyNote: TFile, entry: LogEntry): string {
    const settings = this.getSettings();
    const sourceLink = this.shouldIncludeSourceLink(dailyNote, entry.sourcePath)
      ? ` ${this.formatSourceLink(dailyNote, entry.sourcePath)}`
      : '';
    const timePrefix = settings.includeCompletionTime ? `${this.formatTime(entry.completedAt)} - ` : '';
    const defaultLine = `- ${timePrefix}${entry.text}${sourceLink}`;

    // ── Configurable log entry template (#11) ─────────────────────────────
    const template = (settings.logEntryTemplate ?? '').trim();
    if (template) {
      const time = settings.includeCompletionTime ? this.formatTime(entry.completedAt) : '';
      const task = entry.text;
      const file = sourceLink.trim();
      const tags = (entry.text.match(/(^|\s)(#[^\s!@#$%^&*(),.?":{}|<>]+)/gu) ?? [])
        .map((t) => t.trim())
        .join(' ');
      const priorityMatch = /[\uD83D\uDD3A\u23EB\uD83D\uDD3C\uD83D\uDD3D\u23EC]/u.exec(entry.text);
      const priority = priorityMatch ? priorityMatch[0] : '';
      // Date of completion (YYYY-MM-DD)
      const date = entry.completedAt
        ? `${entry.completedAt.getFullYear()}-${String(entry.completedAt.getMonth() + 1).padStart(2, '0')}-${String(entry.completedAt.getDate()).padStart(2, '0')}`
        : '';
      // Status is always 'completed' in the completion log
      const status = 'completed';
      // Duration: extracted from task text like "Task text - 2h 30m" or "Task (1h)"
      const durationMatch = /(?:\()?(\d+h(?:\s*\d+m)?|\d+m)(?:\))?$/u.exec(entry.text.trim());
      const duration = durationMatch ? durationMatch[1] : '';

      let result = template;
      // Process conditional blocks first (these use a different {{#key}}…{{/key}} syntax).
      result = result.replace(
        /\{\{#time\}\}(.*?)\{\{\/time\}\}/gsu,
        time ? '$1' : '',
      );
      result = result.replace(
        /\{\{#file\}\}(.*?)\{\{\/file\}\}/gsu,
        file ? '$1' : '',
      );
      result = result.replace(
        /\{\{#duration\}\}(.*?)\{\{\/duration\}\}/gsu,
        duration ? '$1' : '',
      );
      // Replace simple variables in a single pass so that task text containing
      // "{{...}}" patterns is never re-expanded after substitution.
      const vars: Record<string, string> = { time, task, file, tags, priority, date, status, duration };
      result = result.replace(/\{\{([a-z]+)\}\}/gu, (_match, key: string) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : _match,
      );
      return this.withCompletionMarker(result, entry.completionId);
    }

    return this.withCompletionMarker(defaultLine, entry.completionId);
  }

  private withCompletionMarker(line: string, completionId: string | undefined): string {
    if (!completionId) return line;
    const safeId = completionId.replace(/[^A-Za-z0-9_-]/gu, '');
    return safeId ? `${line} <!-- task-manager-completion:${safeId} -->` : line;
  }

  async appendToDailyLog(dailyNote: TFile, entry: LogEntry, isActive: () => boolean = () => true): Promise<string> {
    return (await this.appendBatchToDailyLog(dailyNote, [entry], isActive))[0];
  }

  /** Append/reconcile a completion wave with one heading read and one atomic note process. */
  async appendBatchToDailyLog(dailyNote: TFile, entries: readonly LogEntry[], isActive: () => boolean = () => true): Promise<string[]> {
    if (entries.length === 0) return [];
    const lines = entries.map((entry) => this.formatLogLine(dailyNote, entry));
    const persistedLines = [...lines];
    const markers = lines.map((line) => line.match(/<!-- task-manager-completion:[A-Za-z0-9_-]+ -->/u)?.[0]);
    // Per-note override (#20): resolve once for the complete wave.
    const heading = await this.resolveLogHeading(dailyNote);
    if (!isActive()) throw new Error('Completion log write cancelled because the owning lifecycle ended');

    await this.app.vault.process(dailyNote, (content) => {
      if (!isActive()) return content;
      const existingByMarker = new Map<string, string>();
      for (const existingLine of content.split(/\r?\n/u)) {
        const marker = existingLine.match(/<!-- task-manager-completion:[A-Za-z0-9_-]+ -->/u)?.[0];
        if (marker) existingByMarker.set(marker, existingLine);
      }
      const missing: string[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const marker = markers[index];
        const existingLine = marker ? existingByMarker.get(marker) : undefined;
        if (existingLine !== undefined) persistedLines[index] = existingLine;
        else missing.push(lines[index]);
      }
      return missing.length > 0 ? this.appendLineToSection(content, heading, missing.join('\n')) : content;
    });
    if (!isActive()) throw new Error('Completion log write cancelled because the owning lifecycle ended');
    return persistedLines;
  }

  /**
   * Resolve the log section heading for a given note.
   * Checks the note's frontmatter for `task_log_heading` or `log_heading` overrides
   * before falling back to the global setting.
   */
  private async resolveLogHeading(note: TFile): Promise<string> {
    const globalHeading = this.getSettings().logSectionHeading.trim() || 'Log';
    try {
      const content = await this.app.vault.cachedRead(note);
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
      if (!fmMatch) return globalHeading;
      const frontmatter = fmMatch[1];
      // Match common YAML scalar forms such as task_log_heading: Some heading or quoted values.
      const overrideMatch = frontmatter.match(/^(?:task_log_heading|log_heading):\s*(?:["'`](.*?)['"`]|(.*))\s*$/mu);
      const override = overrideMatch?.[1] ?? overrideMatch?.[2];
      return override?.trim() || globalHeading;
    } catch (error) {
      console.warn(
        `[LogWriter] Failed to read frontmatter override for ${note.path}; using global log heading.`,
        error,
      );
      return globalHeading;
    }
  }

  appendLineToSection(content: string, heading: string, line: string): string {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const trimmedHeading = heading.trim() || 'Log';
    const section = this.findHeadingSection(normalizedContent, trimmedHeading);

    const updated = section
      ? this.insertLineAtSectionEnd(normalizedContent, section.endIndex, line)
      : this.appendNewSection(normalizedContent, trimmedHeading, line);

    return eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated;
  }

  private insertLineAtSectionEnd(content: string, endIndex: number, line: string): string {
    const beforeSectionEnd = content.slice(0, endIndex).replace(/[ \t\n]*$/u, '');
    const afterSectionEnd = content.slice(endIndex).replace(/^\n*/u, '');
    const inserted = `${beforeSectionEnd}\n${line}\n`;

    return afterSectionEnd ? `${inserted}\n${afterSectionEnd}` : inserted;
  }

  private appendNewSection(content: string, heading: string, line: string): string {
    const trimmedEnd = content.replace(/[ \t\n]*$/u, '');
    const prefix = trimmedEnd ? `${trimmedEnd}\n\n` : '';
    return `${prefix}## ${heading}\n${line}\n`;
  }

  private findHeadingSection(content: string, heading: string): { endIndex: number } | null {
    const targetHeading = heading.trim();
    const lines = content.matchAll(/.*(?:\n|$)/g);
    let offset = 0;
    let targetLevel: number | null = null;

    for (const match of lines) {
      const lineWithNewline = match[0];
      if (!lineWithNewline) {
        break;
      }

      const line = lineWithNewline.endsWith('\n') ? lineWithNewline.slice(0, -1) : lineWithNewline;
      const parsedHeading = this.parseMarkdownHeading(line);
      if (parsedHeading) {
        if (targetLevel !== null && parsedHeading.level <= targetLevel) {
          return { endIndex: offset };
        }

        if (targetLevel === null && parsedHeading.text === targetHeading) {
          targetLevel = parsedHeading.level;
        }
      }

      offset += lineWithNewline.length;
    }

    return targetLevel !== null ? { endIndex: content.length } : null;
  }

  private parseMarkdownHeading(line: string): { level: number; text: string } | null {
    const match = /^(?: {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line);
    if (!match) {
      return null;
    }

    const text = match[2].replace(/[ \t]+#+[ \t]*$/u, '').trim();
    return { level: match[1].length, text };
  }

  private shouldIncludeSourceLink(dailyNote: TFile, sourcePath: string | undefined): sourcePath is string {
    return Boolean(
      this.getSettings().includeSourceLinkWhenNotDailyNote &&
        sourcePath &&
        sourcePath !== dailyNote.path,
    );
  }

  private formatSourceLink(dailyNote: TFile, sourcePath: string | undefined): string {
    if (!sourcePath) {
      return '';
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (sourceFile) {
      const linkText = this.app.metadataCache.fileToLinktext(sourceFile as TFile, dailyNote.path, true);
      return `[[${linkText}]]`;
    }

    return `[[${sourcePath.replace(/\.md$/iu, '')}]]`;
  }

  async appendDailyStatsSummary(
    dailyNote: TFile,
    completedTasks: Array<{ text: string; priority?: string }>,
  ): Promise<void> {
    const settings = this.getSettings();
    if (!settings.dailyStatsSummaryEnabled) return;
    const total = completedTasks.length;
    if (total === 0) return;

    // Count by priority
    const priorityCounts: Record<string, number> = {};
    const priorityLabels: Record<string, string> = {
      highest: '🔺 highest',
      high: '⏫ high',
      medium: '🔼 medium',
      low: '🔽 low',
      lowest: '⏬ lowest',
    };
    for (const t of completedTasks) {
      if (t.priority && t.priority !== 'normal') {
        priorityCounts[t.priority] = (priorityCounts[t.priority] ?? 0) + 1;
      }
    }

    const template = (settings.dailyStatsSummaryTemplate || '> ✅ {{total}} tasks completed').trim();
    let line = template.replace(/\{\{total\}\}/gu, String(total));

    // Handle {{#byPriority}}...{{/byPriority}} block
    const byPriorityMatch = /\{\{#byPriority\}\}(.*?)\{\{\/byPriority\}\}/su.exec(line);
    if (byPriorityMatch) {
      const innerTemplate = byPriorityMatch[1];
      const parts: string[] = [];
      for (const [key, label] of Object.entries(priorityLabels)) {
        const count = priorityCounts[key] ?? 0;
        if (count > 0) {
          parts.push(innerTemplate.replace(/\{\{label\}\}/gu, label).replace(/\{\{count\}\}/gu, String(count)));
        }
      }
      line = line.replace(byPriorityMatch[0], parts.join(', '));
    }

    const heading = await this.resolveLogHeading(dailyNote);
    await this.app.vault.process(dailyNote, (content) => this.appendLineToSection(content, heading, line));
  }

  private formatTime(date: Date): string {
    const format = this.getSettings().logTimeFormat.trim() || 'HH:mm';
    const formatWithMoment = moment as unknown as (input: Date) => { format: (dateFormat: string) => string };
    return formatWithMoment(date).format(format);
  }
}
