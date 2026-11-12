/** Accessible multi-step weekly review wizard. */

import { Modal, TFile, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import type { ParsedTask } from '../task-scanner';
import { todayString } from '../date-utils';
import { t } from '../i18n';
import { applyLocaleScope } from '../locale-scope';

function normalizeInboxNotePath(path: string): string {
  return normalizePath(path.trim()).replace(/\.md$/iu, '');
}

export function matchesWeeklyReviewInboxPath(filePath: string, inboxPath: string): boolean {
  return normalizeInboxNotePath(filePath) === normalizeInboxNotePath(inboxPath);
}

interface WeeklyReviewStep {
  title: string;
  description: string;
  tasks: ParsedTask[];
}

export class WeeklyReviewModal extends Modal {
  private readonly pageSize = 20;
  private readonly pageByStep = new Map<number, number>();
  private readonly visitedPages = new Set<string>();
  private step = 0;
  private overdue: ParsedTask[] = [];
  private undated: ParsedTask[] = [];
  private inbox: ParsedTask[] = [];
  private statusEl?: HTMLElement;
  private headingEl?: HTMLElement;
  private panelEl?: HTMLElement;
  private navigationEl?: HTMLElement;
  private backButton?: HTMLButtonElement;
  private nextButton?: HTMLButtonElement;
  private disposeLocaleScope?: () => void;

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly allTasks: ParsedTask[],
  ) {
    super(app);
  }

  onOpen(): void {
    const today = todayString();
    const notDone = this.allTasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'untracked');
    this.overdue = notDone.filter((task) => task.metadata.dates.due && task.metadata.dates.due < today);
    this.undated = notDone.filter((task) => !task.metadata.dates.due && !task.metadata.dates.scheduled && !task.metadata.dates.start);
    const inboxPathRaw = this.settings.weeklyReviewInboxPath || this.settings.quickCaptureInboxPath;
    this.inbox = inboxPathRaw ? notDone.filter((task) => matchesWeeklyReviewInboxPath(task.filePath, inboxPathRaw)) : [];
    this.step = 0;
    this.buildShell();
    this.renderStep(false);
  }

  private getSteps(): WeeklyReviewStep[] {
    return [
      { title: t('weeklyReview.overdue.title'), tasks: this.overdue, description: t('weeklyReview.overdue.description') },
      { title: t('weeklyReview.inbox.title'), tasks: this.inbox, description: t('weeklyReview.inbox.description') },
      { title: t('weeklyReview.undated.title'), tasks: this.undated, description: t('weeklyReview.undated.description') },
    ];
  }

  private buildShell(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-manager-weekly-review');
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = applyLocaleScope(contentEl);
    contentEl.createEl('h2', { text: t('weeklyReview.title') });
    this.statusEl = contentEl.createDiv({ cls: 'weekly-review-progress' });
    this.statusEl.setAttr('role', 'status');
    this.statusEl.setAttr('aria-live', 'polite');
    this.statusEl.setAttr('aria-atomic', 'true');
    this.headingEl = contentEl.createEl('h3', { cls: 'weekly-review-step-heading' });
    this.headingEl.setAttr('tabindex', '-1');
    this.headingEl.setAttr('aria-current', 'step');
    this.panelEl = contentEl.createDiv({ cls: 'weekly-review-panel' });
    this.panelEl.setAttr('role', 'region');

    this.navigationEl = contentEl.createDiv({ cls: 'weekly-review-btns' });
    this.backButton = this.navigationEl.createEl('button', { text: t('action.back') });
    this.backButton.setAttr('type', 'button');
    this.backButton.addEventListener('click', () => {
      if (this.step <= 0) return;
      this.step -= 1;
      this.renderStep(true);
    });
    this.nextButton = this.navigationEl.createEl('button', { cls: 'mod-cta' });
    this.nextButton.setAttr('type', 'button');
    this.nextButton.addEventListener('click', () => {
      const steps = this.getSteps();
      if (this.step > steps.length - 1) {
        this.close();
        return;
      }
      this.step += 1;
      this.renderStep(true);
    });
  }

  private renderStep(focusHeading: boolean): void {
    if (!this.statusEl || !this.headingEl || !this.panelEl || !this.backButton || !this.nextButton || !this.navigationEl) return;
    const steps = this.getSteps();
    const current = steps[this.step];
    this.panelEl.empty();

    if (!current) {
      this.statusEl.setText(t('weeklyReview.complete.title'));
      this.headingEl.setText(t('weeklyReview.complete.title'));
      this.panelEl.createEl('p', { text: t('weeklyReview.complete.summary', { count: steps.reduce((total, item) => total + item.tasks.length, 0) }) });
      this.panelEl.createEl('p', {
        text: t('weeklyReview.complete.stats', { overdue: this.overdue.length, inbox: this.inbox.length, undated: this.undated.length }),
        cls: 'weekly-review-stats',
      });
      this.backButton.hidden = true;
      this.nextButton.disabled = false;
      this.nextButton.setText(t('modal.btn.close'));
    } else {
      this.statusEl.setText(t('weeklyReview.progress', { current: this.step + 1, total: steps.length }));
      this.headingEl.setText(current.title);
      this.panelEl.createEl('p', { text: current.description, cls: 'weekly-review-desc' });
      this.panelEl.createEl('p', {
        text: t(current.tasks.length === 1 ? 'ui.taskCountSingular' : 'ui.taskCountPlural', { count: current.tasks.length }),
        cls: 'weekly-review-count',
      });
      this.renderTaskList(this.panelEl, current.tasks);
      this.backButton.hidden = this.step === 0;
      this.nextButton.setText(this.step < steps.length - 1 ? t('weeklyReview.next') : t('weeklyReview.finish'));
      const pageCount = Math.max(1, Math.ceil(current.tasks.length / this.pageSize));
      this.nextButton.disabled = Array.from({ length: pageCount }, (_value, page) => `${this.step}:${page}`).some((key) => !this.visitedPages.has(key));
    }

    if (focusHeading) this.headingEl.focus();
  }

  private renderTaskList(parent: HTMLElement, tasks: ParsedTask[]): void {
    const pageCount = Math.max(1, Math.ceil(tasks.length / this.pageSize));
    const page = Math.min(this.pageByStep.get(this.step) ?? 0, pageCount - 1);
    this.pageByStep.set(this.step, page);
    this.visitedPages.add(`${this.step}:${page}`);
    const start = page * this.pageSize;
    const list = parent.createEl('ul', { cls: 'weekly-review-list' });
    for (const task of tasks.slice(start, start + this.pageSize)) {
      const item = list.createEl('li', { cls: 'weekly-review-item' });
      item.createEl('span', { text: task.normalizedText, cls: 'weekly-review-task-description' });
      const note = task.filePath.split('/').pop()?.replace(/\.md$/u, '') || task.filePath;
      item.createEl('small', { text: note, cls: 'weekly-review-file' });
      const openButton = item.createEl('button', { text: '↗', cls: 'weekly-review-open-btn' });
      openButton.setAttr('type', 'button');
      const openLabel = t('weeklyReview.openTask', { task: task.normalizedText, note });
      openButton.setAttr('aria-label', openLabel);
      openButton.setAttr('title', openLabel);
      openButton.addEventListener('click', () => {
        const file = this.app.vault.getAbstractFileByPath(task.filePath);
        if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file, { active: true, eState: { line: Math.max(0, task.lineNumber - 1) } });
      });
    }
    if (pageCount > 1) {
      const pager = parent.createDiv({ cls: 'weekly-review-pager' });
      const previous = pager.createEl('button', { text: t('action.previous') });
      previous.disabled = page === 0;
      previous.addEventListener('click', () => { this.pageByStep.set(this.step, page - 1); this.renderStep(false); });
      const status = pager.createSpan({ text: `Page ${page + 1} of ${pageCount} · ${Math.min(start + this.pageSize, tasks.length)} of ${tasks.length} reviewed` });
      status.setAttr('role', 'status');
      const next = pager.createEl('button', { text: t('action.next') });
      next.disabled = page >= pageCount - 1;
      next.addEventListener('click', () => { this.pageByStep.set(this.step, page + 1); this.renderStep(false); });
    }
  }

  onClose(): void {
    this.statusEl = undefined;
    this.headingEl = undefined;
    this.panelEl = undefined;
    this.navigationEl = undefined;
    this.backButton = undefined;
    this.nextButton = undefined;
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = undefined;
    this.contentEl.empty();
  }
}
