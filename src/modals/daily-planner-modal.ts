/**
 * daily-planner-modal.ts
 *
 * Daily Planning Assistant modal.  Previously received a TaskManagerPlugin
 * reference; now takes explicit dependencies to avoid circular imports.
 */

import { Modal, Notice, TFile, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import type { ParsedTask, TaskScanner } from '../task-scanner';
import type { DailyNoteResolver } from '../daily-note';
import { addDate } from '../date-utils';
import { todayString } from '../date-utils';
import { scanScannableTasks } from './modal-utils';
import { applyManualOrderWrites, applyRowMove, attachManualDrag, planManualReorder, sortTasksWithManualOrder } from '../manual-order';

let dailyPlannerSequence = 0;

/** Date-then-text fallback ordering for the planner's “Today's plan” step when no manual order is set. */
function comparePlannerByDate(a: ParsedTask, b: ParsedTask): number {
  const da = a.metadata.dates.scheduled ?? a.metadata.dates.due ?? '';
  const db = b.metadata.dates.scheduled ?? b.metadata.dates.due ?? '';
  if (da !== db) return da < db ? -1 : 1;
  return a.normalizedText.localeCompare(b.normalizedText);
}

export class DailyPlannerModal extends Modal {
  private readonly phasePanelId = `task-manager-daily-planner-panel-${dailyPlannerSequence++}`;
  private phase: 0 | 1 | 2 = 0;
  private overdueTasks: ParsedTask[] = [];
  private backlogTasks: ParsedTask[] = [];
  private todayTasks: ParsedTask[] = [];
  private isLoading = true;
  private liveStatusMessage = '';

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly scanner: TaskScanner,
    private readonly dailyNoteResolver: DailyNoteResolver,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('Daily Planning Assistant');
    this.modalEl.addClass('tm-planner-modal');
    const { contentEl } = this;
    contentEl.addClass('tm-planner');
    contentEl.setAttr('aria-busy', 'true');
    contentEl.empty();
    const loading = contentEl.createDiv('tm-planner-loading');
    loading.setAttr('role', 'status');
    loading.setAttr('aria-live', 'polite');
    setIcon(loading.createSpan('tm-planner-loading-icon'), 'loader');
    loading.createSpan({ text: 'Loading tasks…' });
    await this.loadTasks();
    this.isLoading = false;
    contentEl.setAttr('aria-busy', 'false');
    this.renderPhase();
  }

  private async loadTasks(): Promise<void> {
    const allTasks = await scanScannableTasks(this.app, this.settings, this.scanner);
    const today = todayString();
    const active = allTasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    this.overdueTasks = active.filter((t) => t.metadata.dates.due && t.metadata.dates.due < today);
    this.backlogTasks = active.filter((t) => !t.metadata.dates.due && !t.metadata.dates.scheduled);
    this.todayTasks = sortTasksWithManualOrder(
      active.filter(
        (t) =>
          (t.metadata.dates.due && t.metadata.dates.due === today) ||
          (t.metadata.dates.scheduled && t.metadata.dates.scheduled === today),
      ),
      comparePlannerByDate,
    );
  }

  private renderPhase(): void {
    const { contentEl } = this;
    contentEl.empty();

    const phases = [
      { label: 'Review overdue', icon: 'alert-triangle', tasks: this.overdueTasks,
        subtitle: 'Clear or push out anything past due before planning the day.',
        empty: 'No overdue tasks — you’re all caught up.' },
      { label: 'Schedule backlog', icon: 'inbox', tasks: this.backlogTasks,
        subtitle: 'Pull undated tasks you want to tackle into today.',
        empty: 'No undated backlog tasks to schedule.' },
      { label: 'Today’s plan', icon: 'sun', tasks: this.todayTasks,
        subtitle: 'Everything due or scheduled for today — log it to your daily note.',
        empty: 'Nothing scheduled for today yet — add some from the backlog.' },
    ];

    // Segmented step tabs (mirrors the dashboard's Today/Week/Month control).
    const steps = contentEl.createDiv('tm-planner-steps');
    steps.setAttr('role', 'tablist');
    steps.setAttr('aria-label', 'Daily planning steps');
    const stepButtons: HTMLButtonElement[] = [];
    phases.forEach((p, i) => {
      const btn = steps.createEl('button', { cls: `tm-planner-step${this.phase === i ? ' is-active' : ''}${i < this.phase ? ' is-done' : ''}` });
      btn.id = `${this.phasePanelId}-tab-${i}`;
      btn.setAttr('role', 'tab');
      btn.setAttr('aria-controls', this.phasePanelId);
      btn.setAttr('aria-selected', String(this.phase === i));
      btn.tabIndex = this.phase === i ? 0 : -1;
      btn.createSpan({ cls: 'tm-planner-step-index', text: String(i + 1) });
      btn.createSpan({ cls: 'tm-planner-step-label', text: p.label });
      btn.createSpan({ cls: 'tm-planner-step-count', text: String(p.tasks.length) });
      btn.addEventListener('click', () => {
        this.phase = i as 0 | 1 | 2;
        this.renderPhase();
        this.contentEl.querySelector<HTMLButtonElement>(`#${this.phasePanelId}-tab-${i}`)?.focus();
      });
      stepButtons.push(btn);
    });
    steps.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const current = stepButtons.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? stepButtons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + stepButtons.length) % stepButtons.length;
      stepButtons[next]?.click();
    });

    const phase = phases[this.phase];
    const status = contentEl.createDiv('task-manager-sr-only');
    status.setAttr('role', 'status');
    status.setAttr('aria-live', 'polite');
    status.setText(this.liveStatusMessage || `${phases[this.phase].label}: ${phases[this.phase].tasks.length} tasks`);
    const head = contentEl.createDiv('tm-planner-phase-head');
    head.createDiv({ cls: 'tm-planner-phase-title', text: phase.label });
    head.createDiv({ cls: 'tm-planner-phase-sub', text: phase.subtitle });

    const body = contentEl.createDiv('tm-planner-body');
    body.id = this.phasePanelId;
    body.setAttr('role', 'tabpanel');
    body.setAttr('aria-labelledby', `${this.phasePanelId}-tab-${this.phase}`);
    body.tabIndex = -1;
    const { tasks } = phase;

    if (tasks.length === 0) {
      const empty = body.createDiv('tm-planner-empty');
      setIcon(empty.createDiv('tm-planner-empty-icon'), 'check-circle');
      empty.createDiv({ cls: 'tm-planner-empty-text', text: phase.empty });
    } else {
      const list = body.createDiv('tm-planner-list');
      const rows: HTMLElement[] = [];
      for (const [taskIndex, task] of tasks.entries()) {
        const row = list.createDiv({ cls: `tm-planner-row tm-planner-row--p${this.phase}` });
        if (this.phase === 2) {
          const handle = row.createDiv('tm-planner-drag-handle');
          setIcon(handle, 'grip-vertical');
          handle.setAttr('aria-hidden', 'true');
          handle.setAttr('title', 'Drag to reorder');
        }
        const main = row.createDiv('tm-planner-row-main');
        main.createDiv({ cls: 'tm-planner-desc', text: task.normalizedText });
        const meta = this.taskMeta(task);
        const metaRow = main.createDiv('tm-planner-meta');
        if (meta) metaRow.createSpan({ cls: `tm-planner-chip is-${meta.tone}`, text: meta.text });
        const src = task.filePath.split('/').pop()?.replace(/\.md$/u, '');
        if (src) metaRow.createSpan({ cls: 'tm-planner-chip is-muted', text: src });

        const actions = row.createDiv('tm-planner-actions');
        if (this.phase === 0) {
          this.actionBtn(actions, { icon: 'check', label: 'Done', cta: true, onClick: () => this.markTaskDone(task) });
          this.actionBtn(actions, { icon: 'calendar-plus', label: '+1 day', onClick: () => this.postponeTask(task, 1) });
        } else if (this.phase === 1) {
          this.actionBtn(actions, { icon: 'calendar-check', label: 'Today', cta: true, onClick: () => this.scheduleTaskToday(task) });
        } else {
          if (taskIndex > 0) this.actionBtn(actions, { icon: 'arrow-up', label: 'Move up', onClick: () => this.reorderTodayTask(taskIndex, taskIndex - 1).catch((error: unknown) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`)) });
          if (taskIndex < tasks.length - 1) this.actionBtn(actions, { icon: 'arrow-down', label: 'Move down', onClick: () => this.reorderTodayTask(taskIndex, taskIndex + 1).catch((error: unknown) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`)) });
          this.actionBtn(actions, { icon: 'inbox', label: 'To backlog', onClick: () => this.unscheduleTask(task) });
          this.actionBtn(actions, { icon: 'check', label: 'Done', cta: true, onClick: () => this.markTaskDone(task) });
        }
        rows.push(row);
      }
      if (this.phase === 2 && rows.length > 1) {
        attachManualDrag(rows, (from, to) => {
          void this.reorderTodayTask(from, to)
            .catch((error) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`));
        });
      }
    }

    const nav = contentEl.createDiv('tm-planner-foot');
    const left = nav.createDiv('tm-planner-foot-left');
    if (this.phase > 0) this.actionBtn(left, { icon: 'chevron-left', label: 'Previous', onClick: () => {
      this.phase = (this.phase - 1) as 0 | 1 | 2;
      this.renderPhase();
      this.contentEl.querySelector<HTMLButtonElement>(`#${this.phasePanelId}-tab-${this.phase}`)?.focus();
    } });
    const right = nav.createDiv('tm-planner-foot-right');
    if (this.phase < 2) {
      this.actionBtn(right, { icon: 'chevron-right', label: 'Next', cta: true, iconAfter: true, onClick: () => {
        this.phase = (this.phase + 1) as 0 | 1 | 2;
        this.renderPhase();
        this.contentEl.querySelector<HTMLButtonElement>(`#${this.phasePanelId}-tab-${this.phase}`)?.focus();
      } });
    } else {
      this.actionBtn(right, { icon: 'notebook-pen', label: 'Log to daily note', cta: true, onClick: () => this.logDailyPlan() });
    }
  }

  /** A small icon+label button used throughout the planner; keeps spacing/markup consistent. */
  private actionBtn(parent: HTMLElement, opts: { icon: string; label: string; cta?: boolean; iconAfter?: boolean; onClick: () => unknown }): void {
    const btn = parent.createEl('button', { cls: `tm-planner-btn${opts.cta ? ' is-cta' : ''}` });
    const icon = (): void => setIcon(btn.createSpan('tm-planner-btn-icon'), opts.icon);
    if (!opts.iconAfter) icon();
    btn.createSpan({ cls: 'tm-planner-btn-label', text: opts.label });
    if (opts.iconAfter) icon();
    btn.addEventListener('click', () => { void opts.onClick(); });
  }

  /** Build the contextual meta chip (overdue age / scheduled date) for a task row. */
  private taskMeta(task: ParsedTask): { text: string; tone: 'overdue' | 'soon' | 'muted' } | null {
    const today = todayString();
    const due = task.metadata.dates.due;
    const scheduled = task.metadata.dates.scheduled;
    if (this.phase === 0 && due) {
      const days = Math.floor((new Date(today).getTime() - new Date(due).getTime()) / 86_400_000);
      return { text: days > 0 ? `${days}d overdue · due ${due}` : `due ${due}`, tone: 'overdue' };
    }
    if (this.phase === 2) {
      if (scheduled) return { text: `scheduled ${scheduled}`, tone: 'soon' };
      if (due) return { text: `due ${due}`, tone: 'soon' };
    }
    return null;
  }

  private async markTaskDone(task: ParsedTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;
    await this.app.vault.process(file, (content) => {
      const lines = content.split(/\r?\n/u);
      const idx = task.lineNumber - 1;
      if (idx < 0 || idx >= lines.length) return content;
      lines[idx] = lines[idx].replace(/\[([^\]]*)\]/u, '[x]');
      return lines.join('\n');
    });
    this.overdueTasks = this.overdueTasks.filter((t) => t.key !== task.key);
    this.todayTasks = this.todayTasks.filter((t) => t.key !== task.key);
    this.backlogTasks = this.backlogTasks.filter((t) => t.key !== task.key);
    this.renderPhase();
  }

  /**
   * Move a task off today's plan and back into the (undated) backlog by stripping the dates that
   * placed it there: always the scheduled date (⏳/⌛), plus a due date (📅/📆/🗓) only when it is
   * today's (a future/past due date is left intact, since that isn't what put it on *today's* plan).
   */
  private async unscheduleTask(task: ParsedTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;
    const today = todayString();
    const dropDueToday = task.metadata.dates.due === today;
    await this.app.vault.process(file, (content) => {
      const lines = content.split(/\r?\n/u);
      const idx = task.lineNumber - 1;
      if (idx < 0 || idx >= lines.length) return content;
      let line = lines[idx];
      line = line.replace(/\s*[\u23f3\u231b]\s*\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?/gu, '');
      if (dropDueToday) line = line.replace(/\s*[\u{1f4c5}\u{1f4c6}\u{1f5d3}]\u{fe0f}?\s*\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?/gu, '');
      lines[idx] = line.trimEnd();
      return lines.join('\n');
    });
    const backlogTask: ParsedTask = {
      ...task,
      metadata: {
        ...task.metadata,
        dates: {
          ...task.metadata.dates,
          scheduled: undefined,
          scheduledTime: undefined,
          due: dropDueToday ? undefined : task.metadata.dates.due,
          dueTime: dropDueToday ? undefined : task.metadata.dates.dueTime,
        },
      },
    };
    this.todayTasks = this.todayTasks.filter((t) => t.key !== task.key);
    const isUndated = !backlogTask.metadata.dates.due && !backlogTask.metadata.dates.scheduled;
    if (isUndated && !this.backlogTasks.some((t) => t.key === task.key)) {
      this.backlogTasks = [...this.backlogTasks, backlogTask];
    }
    this.renderPhase();
  }

  /**
   * Persist a drag-reorder of the “Today's plan” list: write a minimal set of `[order:: N]` markers
   * and update the in-memory order so the re-render reflects the new arrangement immediately. The
   * order is read back (and honoured) the next time the planner is opened.
   */
  private async reorderTodayTask(from: number, to: number): Promise<void> {
    if (from === to || from < 0 || to < 0 || from >= this.todayTasks.length || to >= this.todayTasks.length) return;
    const reordered = applyRowMove(this.todayTasks, from, to);
    const movedKey = this.todayTasks[from].key;
    const keysAfter = reordered.map((t) => t.key);
    const orderByKey = new Map(this.todayTasks.map((t) => [t.key, t.metadata.manualOrder] as const));
    const writes = planManualReorder(keysAfter, movedKey, (key) => orderByKey.get(key));
    const writeMap = new Map(writes.map((w) => [w.key, w.order] as const));
    this.todayTasks = reordered.map((t) => (writeMap.has(t.key)
      ? { ...t, metadata: { ...t.metadata, manualOrder: writeMap.get(t.key) ?? undefined } }
      : t));
    const taskByKey = new Map(this.todayTasks.map((t) => [t.key, t] as const));
    await applyManualOrderWrites(this.app, writes, taskByKey, undefined, this.scanner);
    this.liveStatusMessage = `${this.todayTasks[to]?.normalizedText ?? 'Task'} moved to position ${to + 1} of ${this.todayTasks.length}`;
    this.renderPhase();
  }

  private async postponeTask(task: ParsedTask, days: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;
    const today = todayString();
    const currentDue = task.metadata.dates.due ?? today;
    const newDue = addDate(currentDue, 'day', days);
    await this.app.vault.process(file, (content) => {
      const lines = content.split(/\r?\n/u);
      const idx = task.lineNumber - 1;
      if (idx < 0 || idx >= lines.length) return content;
      if (/\ud83d\udcc5/.test(lines[idx])) {
        lines[idx] = lines[idx].replace(/\ud83d\udcc5\s*\d{4}-\d{2}-\d{2}/gu, `📅 ${newDue}`);
      } else {
        lines[idx] = `${lines[idx].trimEnd()} 📅 ${newDue}`;
      }
      return lines.join('\n');
    });
    this.overdueTasks = this.overdueTasks.filter((t) => t.key !== task.key);
    this.renderPhase();
  }

  private async scheduleTaskToday(task: ParsedTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;
    const today = todayString();
    await this.app.vault.process(file, (content) => {
      const lines = content.split(/\r?\n/u);
      const idx = task.lineNumber - 1;
      if (idx < 0 || idx >= lines.length) return content;
      lines[idx] = `${lines[idx].trimEnd()} ⏳ ${today}`;
      return lines.join('\n');
    });
    const scheduledTask: ParsedTask = {
      ...task,
      metadata: {
        ...task.metadata,
        dates: {
          ...task.metadata.dates,
          scheduled: today,
        },
      },
    };
    this.backlogTasks = this.backlogTasks.filter((t) => t.key !== task.key);
    if (!this.todayTasks.some((t) => t.key === task.key)) {
      this.todayTasks = [...this.todayTasks, scheduledTask];
    }
    this.renderPhase();
  }

  private async logDailyPlan(): Promise<void> {
    const today = todayString();
    const heading = this.settings.dailyPlanHeading || 'Daily Plan';
    const lines = [
      `## ${heading}`,
      `*Generated: ${today}*`,
      '',
      ...this.todayTasks.map((t) => `- [ ] ${t.normalizedText}`),
      '',
    ];
    try {
      const { file } = await this.dailyNoteResolver.resolveToday();
      await this.app.vault.process(file, (content) => {
        if (content.includes(`## ${heading}`)) return content;
        return content.endsWith('\n') ? `${content}${lines.join('\n')}` : `${content}\n${lines.join('\n')}`;
      });
      new Notice(`Task Manager: Daily plan logged to ${file.basename}`);
    } catch (e) {
      new Notice(`Task Manager: Could not log plan — ${String(e)}`);
    }
    this.close();
  }
}
