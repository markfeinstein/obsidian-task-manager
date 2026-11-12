import { moment, normalizePath, TFile } from 'obsidian';
import type { App, TAbstractFile } from 'obsidian';

export interface DailyNoteResolution {
  path: string;
  file: TFile;
}

export interface DailyNoteOptions {
  folder?: string;
  format?: string;
  dateFormat?: string;
  template?: string;
  enabled?: boolean;
}

interface PeriodicNotesPlugin {
  settings?: {
    daily?: DailyNoteOptions;
  };
}

interface DailyNotesInternalPlugin {
  instance?: {
    options?: DailyNoteOptions;
  };
}

interface TemplaterPlugin {
  templater?: {
    overwrite_file_commands?: (file: TFile) => Promise<void> | void;
  };
}

interface AppWithPluginSettings extends App {
  plugins?: {
    plugins?: Record<string, unknown>;
    enabledPlugins?: Set<string>;
  };
  internalPlugins?: {
    plugins?: Record<string, DailyNotesInternalPlugin | undefined>;
    getPluginById?: (id: string) => DailyNotesInternalPlugin | undefined;
  };
}

const DEFAULT_DAILY_FORMAT = 'YYYY-MM-DD';

export class DailyNoteResolver {
  constructor(private readonly app: App) {}

  resolveTodayPath(): string {
    return this.resolvePathForDate(this.formatDate(DEFAULT_DAILY_FORMAT));
  }

  resolvePathForDate(isoDate: string): string {
    const options = this.getDailyNoteOptions();
    return this.buildDailyNotePath(options, isoDate);
  }

  isTodayDailyNote(path: string): boolean {
    return this.normalizeVaultPath(path) === this.resolveTodayPath();
  }

  async resolveToday(isActive: () => boolean = () => true): Promise<DailyNoteResolution> {
    const assertActive = (): void => {
      if (!isActive()) throw new Error('Daily-note resolution cancelled because the owning lifecycle ended');
    };
    assertActive();
    const options = this.getDailyNoteOptions();
    const path = this.buildDailyNotePath(options, this.formatDate(DEFAULT_DAILY_FORMAT));

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (this.isTFile(existing)) {
      return { path, file: existing };
    }

    await this.ensureParentFolders(path, isActive);
    assertActive();
    const templateContent = await this.readTemplateContent(options.template);
    assertActive();
    let file: TFile;
    try {
      assertActive();
      file = await this.app.vault.create(path, templateContent);
    } catch (error) {
      assertActive();
      const raced = this.app.vault.getAbstractFileByPath(path);
      if (this.isTFile(raced)) {
        return { path, file: raced };
      }
      throw error;
    }
    assertActive();
    await this.applyTemplater(file);
    assertActive();
    return { path, file };
  }

  private buildDailyNotePath(options: DailyNoteOptions, isoDate: string): string {
    const format = this.normalizeDateFormat(options.format ?? options.dateFormat ?? DEFAULT_DAILY_FORMAT);
    const folder = this.normalizeFolder(options.folder ?? '');
    const datedName = this.formatConfiguredDate(isoDate, format);
    return this.ensureMarkdownExtension(normalizePath(folder ? `${folder}/${datedName}` : datedName));
  }

  private getDailyNoteOptions(): DailyNoteOptions {
    const app = this.app as AppWithPluginSettings;

    const periodicNotes = app.plugins?.plugins?.['periodic-notes'];
    if (this.isPeriodicNotesPlugin(periodicNotes)) {
      const daily = periodicNotes.settings?.daily;
      if (daily && daily.enabled !== false && (daily.folder || daily.format || daily.dateFormat || daily.template)) {
        return daily;
      }
    }

    const dailyNotes =
      app.internalPlugins?.getPluginById?.('daily-notes')?.instance?.options ??
      app.internalPlugins?.plugins?.['daily-notes']?.instance?.options;
    if (dailyNotes && (dailyNotes.folder || dailyNotes.format || dailyNotes.dateFormat || dailyNotes.template)) {
      return dailyNotes;
    }

    return { format: DEFAULT_DAILY_FORMAT, folder: '' };
  }

  private async readTemplateContent(templatePath: string | undefined): Promise<string> {
    const templateFile = this.resolveTemplateFile(templatePath);
    if (!templateFile) {
      return '';
    }

    return this.app.vault.read(templateFile);
  }

  private resolveTemplateFile(templatePath: string | undefined): TFile | null {
    if (!templatePath?.trim()) {
      return null;
    }

    const normalized = normalizePath(templatePath.trim()).replace(/^\/+|\/+$/gu, '');
    const candidates = [normalized, this.ensureMarkdownExtension(normalized)];
    for (const candidate of candidates) {
      const file = this.app.vault.getAbstractFileByPath(candidate);
      if (this.isTFile(file)) {
        return file;
      }
    }

    return null;
  }

  private async applyTemplater(file: TFile): Promise<void> {
    const app = this.app as AppWithPluginSettings;
    const templater = app.plugins?.plugins?.['templater-obsidian'];
    if (app.plugins?.enabledPlugins && !app.plugins.enabledPlugins.has('templater-obsidian')) {
      return;
    }

    if (!this.isTemplaterPlugin(templater)) {
      return;
    }

    await templater.templater?.overwrite_file_commands?.(file);
  }

  private async ensureParentFolders(path: string, isActive: () => boolean): Promise<void> {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
      return;
    }

    const folderPath = path.slice(0, lastSlash);
    if (!folderPath) {
      return;
    }

    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing: TAbstractFile | null = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        if (!isActive()) throw new Error('Daily-note folder creation cancelled because the owning lifecycle ended');
        await this.app.vault.createFolder(current);
        if (!isActive()) throw new Error('Daily-note folder creation cancelled because the owning lifecycle ended');
      }
    }
  }

  private ensureMarkdownExtension(path: string): string {
    return path.toLowerCase().endsWith('.md') ? path : `${path}.md`;
  }

  private normalizeFolder(folder: string): string {
    return this.normalizeVaultPath(folder).replace(/^\/+|\/+$/gu, '');
  }

  private normalizeVaultPath(path: string): string {
    return normalizePath(path).replace(/^\/+|\/+$/gu, '');
  }

  private normalizeDateFormat(format: string): string {
    return format.trim() || DEFAULT_DAILY_FORMAT;
  }

  private formatDate(format: string): string {
    const formatWithMoment = moment as unknown as () => { format: (dateFormat: string) => string };
    return formatWithMoment().format(format);
  }

  private formatConfiguredDate(isoDate: string, format: string): string {
    const formatWithMoment = moment as unknown as (value: string, dateFormat: string, strict: boolean) => { isValid?: () => boolean; format: (dateFormat: string) => string };
    const parsed = formatWithMoment(isoDate, DEFAULT_DAILY_FORMAT, true);
    return parsed.isValid?.() === false ? this.formatDate(format) : parsed.format(format);
  }

  private isPeriodicNotesPlugin(value: unknown): value is PeriodicNotesPlugin {
    return typeof value === 'object' && value !== null && 'settings' in value;
  }

  private isTemplaterPlugin(value: unknown): value is TemplaterPlugin {
    return typeof value === 'object' && value !== null && 'templater' in value;
  }

  private isTFile(value: TAbstractFile | null): value is TFile {
    return value instanceof TFile || Boolean(value && typeof (value as { path?: unknown }).path === 'string' && typeof (value as { basename?: unknown }).basename === 'string');
  }
}
