/**
 * Vault task-note migration: copy local vault tasks into stable task-note files.
 * Provides dry-run reports and safe, non-destructive vault writes.
 */

import { App, Modal, Notice, DropdownComponent, TFile, normalizePath } from 'obsidian';
import type { MarkdownTask } from './task-model';
import { DryRunOutput } from './sync-contract';
import { FocusManager, FocusTrap } from './keyboard-nav';
import { ensureParentFolders } from './vault-utils';

export const LOCAL_VAULT_MIGRATION_SOURCE = 'local-vault-tasks';

export interface MigrationOptions {
  /**
   * Migration is intentionally copy-only. No existing option authorizes source
   * removal, so source tasks are preserved after every successful target write.
   */
  targetNamespace?: string;  // Where to store migrated tasks
  preserveMetadata: boolean;
  dryRun: boolean;
  conflictResolution: 'skip' | 'merge' | 'overwrite';
  filterBy?: {
    status?: string[];
    priority?: string[];
    tags?: string[];
    dateRange?: { start: Date; end: Date };
  };
}

export interface MigrationReport {
  timestamp: Date;
  sourceService: string;
  totalTasks: number;
  successfulMigrations: number;
  plannedMigrations: number;
  failedMigrations: number;
  skippedTasks: number;
  conflictedTasks: number;
  warnings: string[];
  dryRunOutput: DryRunOutput | null;
  migrationDuration: number;  // milliseconds
  details: MigrationTaskDetail[];
}

export interface MigrationTaskDetail {
  sourceId: string;
  title: string;
  status: 'planned' | 'success' | 'skipped' | 'conflict' | 'failed';
  reason?: string;
  targetLocation?: string;
  affectedFields: string[];
}

/**
 * Main Migration Wizard Modal
 */
export class MigrationWizardModal extends Modal {
  private currentStep: number = 0;
  private options: MigrationOptions = {
    targetNamespace: 'Task Manager Migrations',
    preserveMetadata: true,
    dryRun: true,
    conflictResolution: 'skip',
  };
  private onMigrate: (options: MigrationOptions) => Promise<MigrationReport> = () => Promise.resolve({
    timestamp: new Date(),
    sourceService: '',
    totalTasks: 0,
    successfulMigrations: 0,
    plannedMigrations: 0,
    failedMigrations: 0,
    skippedTasks: 0,
    conflictedTasks: 0,
    warnings: [],
    dryRunOutput: null,
    migrationDuration: 0,
    details: [],
  });
  private focusTrap: FocusTrap | null = null;
  private focusManager = new FocusManager();
  private hasCapturedFocus = false;

  constructor(
    app: App,
    onMigrate: (options: MigrationOptions) => Promise<MigrationReport>
  ) {
    super(app);
    this.onMigrate = onMigrate;
  }

  onOpen(): void {
    this.draw();
  }

  onClose(): void {
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.focusManager.restoreFocus();
    this.hasCapturedFocus = false;
    this.contentEl.empty();
  }

  private draw(): void {
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.contentEl.empty();
    this.contentEl.setAttr('role', 'dialog');
    this.contentEl.setAttr('aria-modal', 'true');

    if (this.currentStep === 0) {
      this.drawServiceSelection();
    } else if (this.currentStep === 1) {
      this.drawMigrationOptions();
    } else if (this.currentStep === 2) {
      this.drawDryRunReview();
    }

    const title = this.contentEl.querySelector<HTMLElement>('h2');
    if (title) {
      title.id = title.id || `task-manager-migration-title-${this.currentStep}`;
      this.contentEl.setAttr('aria-labelledby', title.id);
    }
    this.focusTrap = new FocusTrap(this.contentEl);
    const firstFocusable = this.contentEl.querySelector<HTMLElement>('button, input, select, textarea');
    if (firstFocusable) {
      if (!this.hasCapturedFocus) {
        this.focusManager.focus(firstFocusable);
        this.hasCapturedFocus = true;
      } else {
        firstFocusable.focus();
      }
    }
  }

  private drawServiceSelection(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Vault Task Note Migration' });
    contentEl.createEl('p', { text: 'Step 1 of 3: Confirm local source' });

    contentEl.createEl('p', {
      text: 'Copy tasks already present in this vault into stable task-note files. This workflow does not contact external services.',
      cls: 'migration-info',
    });

    const serviceContainer = contentEl.createDiv('migration-services');
    const button = serviceContainer.createEl('button', {
      text: 'Use local vault tasks',
      cls: 'migration-service-btn',
    });
    button.addEventListener('click', () => {
      this.currentStep = 1;
      this.draw();
    });

    const footer = contentEl.createDiv('migration-footer');
    footer.createEl('button', { text: 'Cancel', cls: 'mod-warning' }).addEventListener('click', () => {
      this.close();
    });
  }

  private drawMigrationOptions(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Vault Task Note Migration' });
    contentEl.createEl('p', { text: 'Step 2 of 3: Configure local copy options' });

    contentEl.createEl('p', {
      text: 'Source: tasks already stored in this vault',
      cls: 'migration-info',
    });

    const targetContainer = contentEl.createDiv('migration-option');
    const targetLabel = targetContainer.createEl('label');
    targetLabel.createEl('span', { text: 'Target vault folder' });
    const targetInput = targetLabel.createEl('input', {
      attr: {
        type: 'text',
        value: this.options.targetNamespace ?? '',
        placeholder: 'Task Manager Migrations',
      },
    });
    targetInput.addEventListener('input', (event) => {
      this.options.targetNamespace = (event.target as HTMLInputElement).value;
    });
    targetContainer.createEl('p', {
      text: 'Tasks are copied to stable Markdown files. Existing source tasks are never removed.',
      cls: 'setting-item-description',
    });

    // Dry run toggle
    const dryRunContainer = contentEl.createDiv('migration-option');
    const dryRunLabel = dryRunContainer.createEl('label');
    const dryRunCheckbox = dryRunLabel.createEl('input', {
      attr: { type: 'checkbox' },
    });
    if (this.options.dryRun) dryRunCheckbox.checked = true;
    dryRunCheckbox.addEventListener('change', (e) => {
      this.options.dryRun = (e.target as HTMLInputElement).checked;
    });
    dryRunLabel.createEl('span', { text: 'Dry run (preview changes without saving)' });

    // Preserve metadata toggle
    const preserveContainer = contentEl.createDiv('migration-option');
    const preserveLabel = preserveContainer.createEl('label');
    const preserveCheckbox = preserveLabel.createEl('input', {
      attr: { type: 'checkbox' },
    });
    if (this.options.preserveMetadata) preserveCheckbox.checked = true;
    preserveCheckbox.addEventListener('change', (e) => {
      this.options.preserveMetadata = (e.target as HTMLInputElement).checked;
    });
    preserveLabel.createEl('span', { text: 'Copy the complete original task line (including inline metadata)' });

    // Conflict resolution
    contentEl.createEl('label', { text: 'Conflict resolution strategy:' });
    const conflictSelect = new DropdownComponent(contentEl);
    conflictSelect.addOption('skip', 'Skip conflicting tasks');
    conflictSelect.addOption('merge', 'Merge with existing tasks');
    conflictSelect.addOption('overwrite', 'Overwrite existing tasks');
    conflictSelect.setValue(this.options.conflictResolution);
    conflictSelect.onChange((value) => {
      this.options.conflictResolution = value as 'skip' | 'merge' | 'overwrite';
    });

    // Buttons
    const footer = contentEl.createDiv('migration-footer');

    footer.createEl('button', { text: 'Back', cls: 'mod-secondary' }).addEventListener('click', () => {
      this.currentStep = 0;
      this.draw();
    });

    footer.createEl('button', { text: 'Next', cls: 'mod-cta' }).addEventListener('click', () => {
      this.currentStep = 2;
      this.draw();
      this.performDryRun();
    });

    footer.createEl('button', { text: 'Cancel', cls: 'mod-warning' }).addEventListener('click', () => {
      this.close();
    });
  }

  private drawDryRunReview(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Vault Task Note Migration' });
    contentEl.createEl('p', { text: 'Step 3 of 3: Review and confirm' });

    if (this.options.dryRun) {
      contentEl.createEl('p', {
        text: 'This is a dry-run preview. No tasks will be modified.',
        cls: 'migration-info mod-warning',
      });
    }

    const summary = contentEl.createDiv('migration-summary');
    summary.createEl('h3', { text: 'Local Copy Summary' });

    const details = [
      ['Workflow', 'Local vault tasks → task-note files'],
      ['Mode', this.options.dryRun ? 'Dry Run (Preview)' : 'Live'],
      ['Target Folder', this.options.targetNamespace || 'Task Manager Migrations'],
      ['Preserve Metadata', this.options.preserveMetadata ? 'Yes' : 'No'],
      ['Source Tasks', 'Preserved (non-destructive)'],
      ['Conflict Strategy', this.options.conflictResolution],
    ];

    const table = summary.createEl('table');
    details.forEach(([key, value]) => {
      const row = table.createEl('tr');
      row.createEl('td', { text: key, cls: 'migration-label' });
      row.createEl('td', { text: value });
    });

    // Buttons
    const footer = contentEl.createDiv('migration-footer');

    footer.createEl('button', { text: 'Back', cls: 'mod-secondary' }).addEventListener('click', () => {
      this.currentStep = 1;
      this.draw();
    });

    const actionBtn = footer.createEl('button', {
      text: this.options.dryRun ? 'Generate Preview' : 'Confirm & Copy',
      cls: 'mod-cta',
    });

    actionBtn.addEventListener('click', () => { void this.executeMigration(); });

    footer.createEl('button', { text: 'Cancel', cls: 'mod-warning' }).addEventListener('click', () => {
      this.close();
    });
  }

  private performDryRun(): void {
    if (this.options.dryRun) new Notice('Review the options, then generate a no-write preview.');
  }

  private async executeMigration(): Promise<void> {
    try {
      const report = await this.onMigrate(this.options);
      this.close();

      // Display results
      showMigrationReport(this.app, report);
    } catch (error) {
      new Notice(`Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

/**
 * Display migration report in a modal
 */
export function showMigrationReport(app: App, report: MigrationReport): void {
  const modal = new Modal(app);
  const { contentEl } = modal;

  contentEl.createEl('h2', { text: 'Vault Task Note Copy Report' });

  const summary = contentEl.createDiv('migration-report-summary');
  summary.createEl('h3', { text: 'Summary' });

  const stats = [
    ['Timestamp', report.timestamp.toLocaleString()],
    ['Vault Tasks Considered', report.totalTasks.toString()],
    ['Files Written', report.successfulMigrations.toString()],
    ['Planned', report.plannedMigrations.toString()],
    ['Skipped', report.skippedTasks.toString()],
    ['Conflicts', report.conflictedTasks.toString()],
    ['Failed', report.failedMigrations.toString()],
    ['Duration', `${report.migrationDuration}ms`],
  ];

  const table = summary.createEl('table', { cls: 'migration-report-table' });
  stats.forEach(([label, value]) => {
    const row = table.createEl('tr');
    row.createEl('td', { text: label, cls: 'migration-label' });
    row.createEl('td', { text: value });
  });

  if (report.warnings.length > 0) {
    const warningsSection = contentEl.createDiv('migration-warnings');
    warningsSection.createEl('h3', { text: 'Warnings' });
    const warningsList = warningsSection.createEl('ul');
    report.warnings.forEach((warning) => {
      warningsList.createEl('li', { text: warning });
    });
  }

  if (report.details.length > 0) {
    const detailsSection = contentEl.createDiv('migration-details');
    detailsSection.createEl('h3', { text: 'Detailed Results' });
    const detailsList = detailsSection.createEl('ul');
    report.details.forEach((detail) => {
      const item = detailsList.createEl('li');
      const statusEmoji = {
        planned: '→',
        success: '✓',
        skipped: '⊘',
        conflict: '⚠',
        failed: '✗',
      }[detail.status];
      item.createEl('span', { text: `${statusEmoji} ${detail.title}` });
      if (detail.reason) {
        item.createEl('span', { text: ` (${detail.reason})`, cls: 'migration-detail-reason' });
      }
    });
  }

  contentEl.createDiv('migration-footer').createEl('button', {
    text: 'Close',
    cls: 'mod-cta',
  }).addEventListener('click', () => {
    modal.close();
  });

  modal.open();
}

// ═══════════════════════════════════════════════════════════════════════════
// In-vault syntax migration (Feature 7 — P2)
// ═══════════════════════════════════════════════════════════════════════════

/** Source formats that can be migrated from within the vault. */
export type InVaultSourceFormat =
  | 'obsidian-tasks'
  | 'reminder'
  | 'dataview'
  | 'kanban'
  | 'task-genius'
  | 'custom-checkboxes';

/** A single-line migration result. */
export interface LineMigration {
  /** 1-based line number in the file. */
  lineNumber: number;
  /** Original text before migration. */
  original: string;
  /** Text after migration (may equal original if no change). */
  migrated: string;
  /** Human-readable description of each applied transformation. */
  changes: string[];
}

/**
 * Migrate a single file's content from a given in-vault source format.
 *
 * When `dryRun` is true (default) the returned `content` is unchanged — only
 * the `migrations` array tells you what *would* change.
 */
export function migrateVaultFileSyntax(
  content: string,
  sourceFormat: InVaultSourceFormat,
  filePath: string,
  dryRun = true,
): { content: string; migrations: LineMigration[] } {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/u);
  const migrations: LineMigration[] = [];
  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];

    // Track current Markdown heading (used by kanban migration to name the column).
    const headingMatch = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(original);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
    }

    // Only transform task lines.
    if (!/^\s*[-*+] \[.\]/u.test(original)) continue;

    const { migrated, changes } = applyFormatMigration(original, sourceFormat, currentSection);
    if (migrated !== original) {
      migrations.push({ lineNumber: i + 1, original, migrated, changes });
      if (!dryRun) lines[i] = migrated;
    }
  }

  return { content: dryRun ? content : lines.join(newline), migrations };
}

// ─── per-format migration helpers ────────────────────────────────────────────

function applyFormatMigration(
  line: string,
  format: InVaultSourceFormat,
  section: string,
): { migrated: string; changes: string[] } {
  const changes: string[] = [];
  let migrated = line;
  switch (format) {
    case 'reminder':        migrated = migrateReminderSyntax(migrated, changes); break;
    case 'dataview':        migrated = migrateDataviewSyntax(migrated, changes); break;
    case 'obsidian-tasks':  migrated = migrateObsidianTasksSyntax(migrated, changes); break;
    case 'kanban':          migrated = migrateKanbanCard(migrated, changes, section); break;
    case 'task-genius':     migrated = migrateTaskGeniusSyntax(migrated, changes); break;
    case 'custom-checkboxes': migrated = migrateCustomCheckboxSyntax(migrated, changes); break;
  }
  return { migrated, changes };
}

/** Convert one Reminder-plugin marker line without mutating vault state. */
export function convertReminderPluginSyntax(line: string): string {
  return migrateReminderSyntax(line, []);
}

/** Reminder plugin: `(@YYYY-MM-DD)` or `(@YYYY-MM-DD HH:MM)` → `⏰ YYYY-MM-DD[ HH:MM]` */
function migrateReminderSyntax(line: string, changes: string[]): string {
  return line.replace(
    /\(@(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\)/gu,
    (_, date: string, time?: string) => {
      const to = time ? `⏰ ${date} ${time}` : `⏰ ${date}`;
      changes.push(`reminder (@${date}${time ? ' ' + time : ''}) → ${to}`);
      return to;
    },
  );
}

/** Dataview inline field → emoji metadata. */
const DV_DATE_MAP: Readonly<Record<string, string>> = {
  due: '📅', scheduled: '⏳', start: '🛫', created: '➕',
  completion: '✅', done: '✅', cancelled: '❌', canceled: '❌',
};
const DV_PRIORITY_MAP: Readonly<Record<string, string>> = {
  highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬',
};

function migrateDataviewSyntax(line: string, changes: string[]): string {
  // [field:: YYYY-MM-DD] → emoji YYYY-MM-DD
  let r = line.replace(
    /[\[(]([A-Za-z][A-Za-z _-]*)::[ \t]*(\d{4}-\d{2}-\d{2})[\])]/gu,
    (match, field: string, date: string) => {
      const emoji = DV_DATE_MAP[field.toLowerCase()];
      if (!emoji) return match;
      changes.push(`[${field}:: ${date}] → ${emoji} ${date}`);
      return `${emoji} ${date}`;
    },
  );
  // [priority:: level] → priority emoji
  r = r.replace(
    /[\[(]priority::[ \t]*(\w+)[\])]/giu,
    (match, level: string) => {
      const emoji = DV_PRIORITY_MAP[level.toLowerCase()];
      if (!emoji) return match;
      changes.push(`[priority:: ${level}] → ${emoji}`);
      return emoji;
    },
  );
  return r;
}

/** Obsidian Tasks: same emoji format — remove duplicate priority emojis. */
function migrateObsidianTasksSyntax(line: string, changes: string[]): string {
  const RE = /[🔺⏫🔼🔽⏬]/gu;
  const hits = [...line.matchAll(RE)];
  if (hits.length < 2) return line;
  let first = true;
  const result = line.replace(RE, (m) => {
    if (first) { first = false; return m; }
    changes.push(`removed duplicate priority emoji ${m}`);
    return '';
  });
  return result.replace(/  +/gu, ' ');
}

/** Kanban board: tag card with `[project:: ColumnName]` derived from the current `## Column` heading. */
function migrateKanbanCard(line: string, changes: string[], section: string): string {
  if (!section) return line;
  if (/\[project::/iu.test(line)) return line;  // already tagged
  const tagged = `${line.trimEnd()} [project:: ${section}]`;
  changes.push(`kanban card → added [project:: ${section}]`);
  return tagged;
}

/** Task Genius: `+ProjectName` → `[project:: ProjectName]`. */
function migrateTaskGeniusSyntax(line: string, changes: string[]): string {
  return line.replace(
    /(^|\s)\+([A-Za-z0-9_-]+)/gu,
    (_, prefix: string, name: string) => {
      changes.push(`+${name} → [project:: ${name}]`);
      return `${prefix}[project:: ${name}]`;
    },
  );
}

/** Custom checkboxes: map non-standard checkbox characters to supported equivalents. */
const CUSTOM_CB_MAP: Readonly<Record<string, string>> = {
  '>': '/',   // forwarded/deferred → in-progress
};

function migrateCustomCheckboxSyntax(line: string, changes: string[]): string {
  const m = /^(\s*[-*+] \[)([^\]])\]/u.exec(line);
  if (!m) return line;
  const cb = m[2];
  const mapped = CUSTOM_CB_MAP[cb];
  if (mapped) {
    changes.push(`custom checkbox [${cb}] → [${mapped}]`);
    return line.slice(0, m.index + m[1].length) + mapped + line.slice(m.index + m[1].length + 1);
  }
  return line;
}

/**
 * Batch-migrate multiple in-vault files from a source format.
 * Returns a `MigrationReport`; in dry-run mode no file content is changed.
 */
export function migrateVaultFiles(
  files: Array<{ path: string; content: string }>,
  sourceFormat: InVaultSourceFormat,
  options: MigrationOptions,
): MigrationReport {
  const startTime = Date.now();
  const report: MigrationReport = {
    timestamp: new Date(),
    sourceService: sourceFormat,
    totalTasks: 0,
    successfulMigrations: 0,
    plannedMigrations: 0,
    failedMigrations: 0,
    skippedTasks: 0,
    conflictedTasks: 0,
    warnings: [],
    dryRunOutput: null,
    migrationDuration: 0,
    details: [],
  };

  for (const file of files) {
    try {
      const { migrations } = migrateVaultFileSyntax(
        file.content, sourceFormat, file.path, options.dryRun,
      );
      report.totalTasks += migrations.length;
      for (const mg of migrations) {
        report.plannedMigrations += 1;
        report.details.push({
          sourceId: `${file.path}:${mg.lineNumber}`,
          title: mg.original.trim(),
          status: 'planned',
          reason: `${options.dryRun ? 'Would apply' : 'Requires a vault writer to apply'}: ${mg.changes.join('; ')}`,
          targetLocation: file.path,
          affectedFields: mg.changes,
        });
      }
    } catch (err) {
      report.failedMigrations++;
      report.warnings.push(
        `Error processing ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!options.dryRun && report.details.length > 0) {
    report.warnings.push('This helper only builds an in-memory syntax preview; use a vault-backed migration to persist changes.');
  }
  report.migrationDuration = Date.now() - startTime;
  return report;
}

export type MigrationPlanAction = 'create' | 'overwrite' | 'merge' | 'skip' | 'conflict' | 'failed';

export interface MigrationPlanOperation {
  sourceId: string;
  title: string;
  identity: string;
  marker: string;
  targetPath?: string;
  content: string;
  action: MigrationPlanAction;
  reason: string;
  affectedFields: string[];
}

export interface MigrationPlan {
  sourceService: string;
  dryRun: boolean;
  conflictResolution: MigrationOptions['conflictResolution'];
  totalTasks: number;
  operations: MigrationPlanOperation[];
  warnings: string[];
}

const DEFAULT_MIGRATION_NAMESPACE = 'Task Manager Migrations';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableHash(value: string): string {
  // FNV-1a 64-bit: deterministic across platforms and sufficiently collision-resistant
  // for vault filenames. The complete stable identity is also kept in the plan.
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, '0');
}

function sourceTaskId(task: MarkdownTask): string {
  // Explicit task IDs are vault-wide identities. Prefer them over stableKey,
  // whose current task-model representation still includes the source path.
  return task.metadata.id || task.stableKey || task.key || `${task.filePath}:${task.lineNumber}`;
}

function migrationIdentity(sourceService: string, task: MarkdownTask): string {
  const taskIdentity = sourceTaskId(task) || `${task.filePath}:${task.lineNumber}:${task.rawLine}`;
  return `${sourceService}:${taskIdentity}`;
}

export function normalizeMigrationTargetNamespace(targetNamespace?: string): string {
  const raw = (targetNamespace ?? DEFAULT_MIGRATION_NAMESPACE).trim().replace(/\\/gu, '/');
  if (!raw) throw new Error('Target vault folder cannot be empty');
  if (/^(?:\/|[A-Za-z]:\/)/u.test(raw)) throw new Error('Target vault folder must be relative to the vault');
  if (/[\u0000-\u001f\u007f:*?"<>|]/u.test(raw)) throw new Error('Target vault folder contains invalid characters');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('Target vault folder cannot contain . or .. segments');
  const normalized = normalizePath(parts.join('/')).replace(/^\/+|\/+$/gu, '');
  if (!normalized || normalized.endsWith('.md')) throw new Error('Target vault folder must be a folder path');
  return normalized;
}

function taskMigrationLine(task: MarkdownTask, preserveMetadata: boolean): string {
  if (preserveMetadata) {
    const originalLine = String(task.rawLine || '').split(/\r?\n/u)[0].trimEnd();
    if (originalLine) return originalLine;
  }
  const checkbox = String(task.checkbox || ' ').replace(/[\]\r\n]/gu, '') || ' ';
  const body = String(task.normalizedText || task.body || 'Untitled task').split(/\r?\n/u)[0].trim() || 'Untitled task';
  return `- [${checkbox}] ${body}`;
}

function migrationConfigurationError(options: MigrationOptions): string | null {
  const range = options.filterBy?.dateRange;
  if (!range) return null;
  if (!(range.start instanceof Date) || !(range.end instanceof Date)) return 'Date filter must contain Date values';
  const start = range.start.getTime();
  const end = range.end.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Date filter contains an invalid date';
  if (start > end) return 'Date filter start must not be after its end';
  return null;
}

function filterReason(task: MarkdownTask, filter: NonNullable<MigrationOptions['filterBy']>): string | null {
  if (filter.status?.length && !filter.status.includes(task.status)) return 'Does not match status filter';
  if (filter.priority?.length && !filter.priority.includes(task.metadata.priority)) return 'Does not match priority filter';
  if (filter.tags?.length && !filter.tags.every((tag) => task.tags.includes(tag))) return 'Does not match tag filter';
  if (filter.dateRange) {
    const taskDate = task.metadata.dates.due
      || task.metadata.dates.scheduled
      || task.metadata.dates.start
      || task.metadata.dates.created;
    const timestamp = taskDate ? new Date(`${taskDate}T00:00:00`).getTime() : Number.NaN;
    if (!Number.isFinite(timestamp)
      || timestamp < filter.dateRange.start.getTime()
      || timestamp > filter.dateRange.end.getTime()) return 'Does not match date filter';
  }
  return null;
}

function migrationMarker(identity: string): string {
  return `<!-- task-manager-migration:v2:${encodeURIComponent(identity)} -->`;
}

function contentHasMarker(content: string, marker: string): boolean {
  return content.split(/\r?\n/u).some((line) => line.trim() === marker);
}

function isMigrationOwnedContent(content: string): boolean {
  return /(?:^|\r?\n)<!-- task-manager-migration:v\d+:[^\r\n]* -->(?:\r?\n|$)/u.test(content);
}

function pathIsWithinNamespace(filePath: string, namespace: string): boolean {
  const normalizedFile = normalizePath(filePath).replace(/^\/+|\/+$/gu, '');
  return normalizedFile === namespace || normalizedFile.startsWith(`${namespace}/`);
}

async function sourceIsMigrationOwned(
  app: App,
  filePath: string,
  namespace: string,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (pathIsWithinNamespace(filePath, namespace)) return true;
  let pending = cache.get(filePath);
  if (!pending) {
    pending = (async () => {
      const sourceFile = app.vault.getAbstractFileByPath(filePath);
      if (!(sourceFile instanceof TFile)) return false;
      return isMigrationOwnedContent(await app.vault.cachedRead(sourceFile));
    })();
    cache.set(filePath, pending);
  }
  return pending;
}

function mergedMigrationContent(current: string, content: string): string {
  if (!current) return content;
  return `${current.replace(/\s*$/u, '')}\n\n${content}`;
}

export async function buildMigrationPlan(
  app: App,
  tasks: MarkdownTask[],
  options: MigrationOptions,
): Promise<MigrationPlan> {
  const sourceService = LOCAL_VAULT_MIGRATION_SOURCE;
  const plan: MigrationPlan = {
    sourceService,
    dryRun: options.dryRun,
    conflictResolution: options.conflictResolution,
    totalTasks: tasks.length,
    operations: [],
    warnings: ['This local copy is non-destructive: source vault tasks will be preserved.'],
  };

  let namespace: string;
  try {
    namespace = normalizeMigrationTargetNamespace(options.targetNamespace);
  } catch (error) {
    const reason = errorMessage(error);
    plan.warnings.push(`Migration configuration error: ${reason}`);
    for (const task of tasks) {
      plan.operations.push({
        sourceId: sourceTaskId(task), title: task.body || task.normalizedText,
        identity: migrationIdentity(sourceService, task), marker: '', content: '',
        action: 'failed', reason: 'Migration configuration is invalid; see report warning', affectedFields: [],
      });
    }
    return plan;
  }

  const configurationError = migrationConfigurationError(options);
  if (configurationError) {
    plan.warnings.push(`Migration configuration error: ${configurationError}`);
    for (const task of tasks) {
      plan.operations.push({
        sourceId: sourceTaskId(task), title: task.body || task.normalizedText,
        identity: migrationIdentity(sourceService, task), marker: '', content: '',
        action: 'failed', reason: 'Migration configuration is invalid; see report warning', affectedFields: [],
      });
    }
    return plan;
  }

  const ownershipCache = new Map<string, Promise<boolean>>();
  for (const task of tasks) {
    const sourceId = sourceTaskId(task);
    const title = task.body || task.normalizedText || 'Untitled task';
    const identity = migrationIdentity(sourceService, task);
    const identityHash = stableHash(identity);
    const marker = migrationMarker(identity);
    const targetPath = normalizePath(`${namespace}/task-${identityHash}.md`);
    const content = `${marker}\n${taskMigrationLine(task, options.preserveMetadata)}\n`;
    const affectedFields = options.preserveMetadata ? ['complete original task line'] : ['status', 'description'];
    const filtered = options.filterBy ? filterReason(task, options.filterBy) : null;
    if (filtered) {
      plan.operations.push({ sourceId, title, identity, marker, targetPath, content, action: 'skip', reason: filtered, affectedFields: [] });
      continue;
    }

    try {
      if (await sourceIsMigrationOwned(app, task.filePath, namespace, ownershipCache)) {
        plan.operations.push({
          sourceId, title, identity, marker, targetPath, content, action: 'skip',
          reason: 'Source task is already inside a migration-owned task-note file', affectedFields: [],
        });
        continue;
      }
    } catch (error) {
      plan.operations.push({
        sourceId, title, identity, marker, targetPath, content, action: 'failed',
        reason: `Could not inspect source file ownership: ${errorMessage(error)}`, affectedFields: [],
      });
      continue;
    }

    plan.operations.push({
      sourceId, title, identity, marker, targetPath, content,
      action: 'create', reason: `Create ${targetPath}`, affectedFields,
    });
  }

  // Resolve batch-level ambiguity before inspecting or writing any target. Mark
  // every member conflicted so one duplicate can never be silently discarded.
  const pendingOperations = plan.operations.filter((operation) => operation.action === 'create');
  const identityCounts = new Map<string, number>();
  const targetCounts = new Map<string, number>();
  for (const operation of pendingOperations) {
    identityCounts.set(operation.identity, (identityCounts.get(operation.identity) ?? 0) + 1);
    if (operation.targetPath) targetCounts.set(operation.targetPath, (targetCounts.get(operation.targetPath) ?? 0) + 1);
  }
  for (const operation of pendingOperations) {
    const duplicateIdentity = (identityCounts.get(operation.identity) ?? 0) > 1;
    const duplicateTarget = operation.targetPath && (targetCounts.get(operation.targetPath) ?? 0) > 1;
    if (duplicateIdentity || duplicateTarget) {
      operation.action = 'conflict';
      operation.reason = duplicateIdentity
        ? 'Duplicate full source identity in this migration batch'
        : 'Multiple source identities resolve to the same planned target path';
      operation.affectedFields = [];
    }
  }

  for (const operation of plan.operations) {
    if (operation.action !== 'create' || !operation.targetPath) continue;
    try {
      const existing = app.vault.getAbstractFileByPath(operation.targetPath);
      if (!existing) continue;
      if (!(existing instanceof TFile)) {
        operation.action = 'conflict';
        operation.reason = 'A folder already exists at the target file path';
        operation.affectedFields = [];
        continue;
      }
      const current = await app.vault.cachedRead(existing);
      if (contentHasMarker(current, operation.marker)) {
        if (current === operation.content) {
          operation.action = 'skip';
          operation.reason = 'Already copied with identical content';
          operation.affectedFields = [];
        } else if (options.conflictResolution === 'overwrite') {
          operation.action = 'overwrite';
          operation.reason = `Replace the existing task-note copy ${operation.targetPath}`;
        } else {
          operation.action = 'skip';
          operation.reason = 'Full source identity already exists; preserving its current task-note content';
          operation.affectedFields = [];
        }
      } else if (options.conflictResolution === 'overwrite') {
        operation.action = 'overwrite';
        operation.reason = `Overwrite conflicting file ${operation.targetPath}`;
      } else if (options.conflictResolution === 'merge') {
        operation.action = 'merge';
        operation.reason = `Append a marked task copy to ${operation.targetPath}`;
      } else {
        operation.action = 'conflict';
        operation.reason = `Target file already exists: ${operation.targetPath}`;
        operation.affectedFields = [];
      }
    } catch (error) {
      operation.action = 'failed';
      operation.reason = `Could not inspect target: ${errorMessage(error)}`;
      operation.affectedFields = [];
    }
  }
  return plan;
}

type CommitResult = { status: 'success' | 'skipped' | 'conflict'; reason: string };

async function commitToExistingFile(
  app: App,
  file: TFile,
  operation: MigrationPlanOperation,
  conflictResolution: MigrationOptions['conflictResolution'],
): Promise<CommitResult> {
  let outcome: CommitResult = { status: 'skipped', reason: 'No change was required' };
  await app.vault.process(file, (current) => {
    if (contentHasMarker(current, operation.marker)) {
      if (current === operation.content) {
        outcome = { status: 'skipped', reason: 'Already copied with identical content' };
        return current;
      }
      if (conflictResolution !== 'overwrite') {
        outcome = { status: 'skipped', reason: 'Full source identity already exists; preserving its current task-note content' };
        return current;
      }
      outcome = { status: 'success', reason: 'Overwrote the existing task-note copy' };
      return operation.content;
    }
    if (conflictResolution === 'skip') {
      outcome = { status: 'conflict', reason: 'Target file already exists' };
      return current;
    }
    if (conflictResolution === 'merge') {
      outcome = { status: 'success', reason: 'Merged into the existing target file' };
      return mergedMigrationContent(current, operation.content);
    }
    outcome = { status: 'success', reason: 'Overwrote the conflicting target file' };
    return operation.content;
  });
  return outcome;
}

async function commitMigrationOperation(
  app: App,
  operation: MigrationPlanOperation,
  conflictResolution: MigrationOptions['conflictResolution'],
): Promise<CommitResult> {
  if (!operation.targetPath) throw new Error('Task-note copy operation has no target path');
  const existing = app.vault.getAbstractFileByPath(operation.targetPath);
  if (existing && !(existing instanceof TFile)) return { status: 'conflict', reason: 'A folder exists at the target file path' };
  if (existing instanceof TFile) return commitToExistingFile(app, existing, operation, conflictResolution);

  await ensureParentFolders(app, operation.targetPath);
  try {
    await app.vault.create(operation.targetPath, operation.content);
    return { status: 'success', reason: 'Created task-note file' };
  } catch (error) {
    const raced = app.vault.getAbstractFileByPath(operation.targetPath);
    if (raced instanceof TFile) return commitToExistingFile(app, raced, operation, conflictResolution);
    if (raced) return { status: 'conflict', reason: 'A folder was created at the target file path' };
    throw error;
  }
}

function dryRunOutputForPlan(plan: MigrationPlan): DryRunOutput {
  const actionable = plan.operations.filter((operation) => ['create', 'overwrite', 'merge'].includes(operation.action));
  const conflicts = plan.operations.filter((operation) => operation.action === 'conflict');
  const createCount = actionable.filter((operation) => operation.action === 'create').length;
  const updateCount = actionable.length - createCount;
  return {
    totalOperations: actionable.length,
    byType: { create: createCount, update: updateCount, delete: 0, reopen: 0 },
    byService: { [plan.sourceService]: actionable.length },
    potentialConflicts: conflicts.map((operation) => ({
      field: 'targetPath',
      vaultValue: operation.targetPath,
      serviceValue: operation.identity,
      service: 'local-vault-task-copy',
      detectedAt: Date.now(),
    })),
    fieldWarnings: [],
    operations: actionable.map((operation) => ({
      id: operation.identity,
      type: operation.action,
      service: plan.sourceService,
      vaultTaskKey: operation.sourceId,
      preview: `${operation.reason}. Source vault task remains unchanged.`,
    })),
  };
}

function baseMigrationReport(plan: MigrationPlan): MigrationReport {
  return {
    timestamp: new Date(), sourceService: plan.sourceService, totalTasks: plan.totalTasks,
    successfulMigrations: 0, plannedMigrations: 0, failedMigrations: 0, skippedTasks: 0, conflictedTasks: 0,
    warnings: [...plan.warnings], dryRunOutput: plan.dryRun ? dryRunOutputForPlan(plan) : null,
    migrationDuration: 0, details: [],
  };
}

export async function executeMigrationPlan(app: App, plan: MigrationPlan): Promise<MigrationReport> {
  const startTime = Date.now();
  const report = baseMigrationReport(plan);
  for (const operation of plan.operations) {
    const detail: MigrationTaskDetail = {
      sourceId: operation.sourceId, title: operation.title,
      status: 'skipped', reason: operation.reason, targetLocation: operation.targetPath,
      affectedFields: operation.affectedFields,
    };
    if (operation.action === 'skip') {
      report.skippedTasks += 1;
    } else if (operation.action === 'conflict') {
      detail.status = 'conflict';
      report.conflictedTasks += 1;
    } else if (operation.action === 'failed') {
      detail.status = 'failed';
      report.failedMigrations += 1;
    } else if (plan.dryRun) {
      detail.status = 'planned';
      detail.reason = `Would ${operation.action} ${operation.targetPath}; source vault task would be preserved`;
      report.plannedMigrations += 1;
    } else {
      try {
        const result = await commitMigrationOperation(app, operation, plan.conflictResolution);
        detail.status = result.status;
        detail.reason = result.reason;
        if (result.status === 'success') report.successfulMigrations += 1;
        else if (result.status === 'conflict') report.conflictedTasks += 1;
        else report.skippedTasks += 1;
      } catch (error) {
        detail.status = 'failed';
        detail.reason = `Write failed: ${errorMessage(error)}`;
        report.failedMigrations += 1;
      }
    }
    report.details.push(detail);
  }
  report.migrationDuration = Date.now() - startTime;
  return report;
}

/** Build a typed plan, then preview or commit it through the supplied App vault. */
export async function performMigration(
  app: App,
  tasks: MarkdownTask[],
  options: MigrationOptions,
): Promise<MigrationReport> {
  const startedAt = Date.now();
  const plan = await buildMigrationPlan(app, tasks, options);
  const report = await executeMigrationPlan(app, plan);
  report.migrationDuration = Date.now() - startedAt;
  return report;
}
