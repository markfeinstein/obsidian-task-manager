/**
 * pomodoro-modal.ts
 *
 * Pomodoro timer modal and its helper functions.  Extracted from main.ts.
 */

import { Modal, Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import type { ParsedTask, TaskScanner } from '../task-scanner';
import { FocusManager, FocusTrap } from '../keyboard-nav';
import { t } from '../i18n';

// ── Helpers ──────────────────────────────────────────────────────────────────

export function parseDurationMinutes(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*$/iu.exec(value);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

export function minutesToClock(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ── PomodoroModal ────────────────────────────────────────────────────────────

export class PomodoroModal extends Modal {
  private intervalId: number | null = null;
  private seconds = 0;
  private phase: 'work' | 'break' | 'long-break' = 'work';
  private round = 0;
  private focusTrap: FocusTrap | null = null;
  private focusManager = new FocusManager();

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly task: ParsedTask,
    private readonly scanner: TaskScanner,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.modalEl.setAttribute('aria-label', t('pomodoro.title'));
    this.phase = 'work';
    this.seconds = this.settings.pomodoroWorkMinutes * 60;
    this.round = 0;
    const render = (): void => {
      contentEl.empty();
      contentEl.createEl('h3', { text: t('pomodoro.title') });
      contentEl.createEl('p', { text: this.task.normalizedText, cls: 'pomodoro-task' });
      const phaseLabel = this.phase === 'work' ? t('pomodoro.phase.work') : this.phase === 'long-break' ? t('pomodoro.phase.longBreak') : t('pomodoro.phase.shortBreak');
      contentEl.createEl('h4', { text: phaseLabel, cls: 'pomodoro-phase' });
      const mins = Math.floor(this.seconds / 60);
      const secs = this.seconds % 60;
      contentEl.createEl('div', {
        text: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
        cls: 'pomodoro-timer',
      });
      const totalSecs = (this.phase === 'work' ? this.settings.pomodoroWorkMinutes : this.phase === 'long-break' ? this.settings.pomodoroLongBreakMinutes : this.settings.pomodoroBreakMinutes) * 60;
      const pct = Math.round((1 - this.seconds / totalSecs) * 100);
      const bar = contentEl.createDiv({ cls: 'pomodoro-bar-bg' });
      const fill = bar.createDiv({ cls: 'pomodoro-bar-fill' });
      fill.style.setProperty('--task-manager-pomodoro-progress', `${pct}%`);
      const btnRow = contentEl.createDiv({ cls: 'pomodoro-btns' });
      if (this.intervalId === null) {
        const startBtn = btnRow.createEl('button', { text: t('action.start'), cls: 'mod-cta' });
        startBtn.addEventListener('click', () => { this.startTimer(render); });
      } else {
        const pauseBtn = btnRow.createEl('button', { text: t('action.pause') });
        pauseBtn.addEventListener('click', () => { this.pauseTimer(render); });
      }
      const skipBtn = btnRow.createEl('button', { text: t('action.skip') });
      skipBtn.addEventListener('click', () => { this.nextPhase(render); });
      const closeBtn = btnRow.createEl('button', { text: t('modal.btn.close') });
      closeBtn.addEventListener('click', () => { this.close(); });
      contentEl.createEl('p', {
        text: t('pomodoro.roundInfo', { round: this.round + 1, work: this.settings.pomodoroWorkMinutes, break: this.settings.pomodoroBreakMinutes }),
        cls: 'pomodoro-info',
      });
      this.focusTrap?.refresh();
    };
    render();
    this.focusTrap = new FocusTrap(contentEl);
  }

  private startTimer(render: () => void): void {
    this.intervalId = window.setInterval(() => {
      this.seconds -= 1;
      render();
      if (this.seconds <= 0) this.nextPhase(render);
    }, 1000);
    render();
  }

  private pauseTimer(render: () => void): void {
    if (this.intervalId !== null) { window.clearInterval(this.intervalId); this.intervalId = null; }
    render();
  }

  private nextPhase(render: () => void): void {
    if (this.intervalId !== null) { window.clearInterval(this.intervalId); this.intervalId = null; }
    if (this.phase === 'work') {
      this.round += 1;
      const isLongBreak = this.settings.pomodoroLongBreakAfter > 0 && this.round % this.settings.pomodoroLongBreakAfter === 0;
      if (this.settings.pomodoroLogActualTime && this.task?.filePath) {
        const workMins = this.settings.pomodoroWorkMinutes;
        const fileAbstract = this.app.vault.getAbstractFileByPath(this.task.filePath);
        if (fileAbstract && 'extension' in fileAbstract) {
          void this.app.vault.process(fileAbstract as TFile, (content) => {
            const lines = content.split('\n');
            const idx = (this.task.lineNumber ?? 1) - 1;
            if (idx >= 0 && idx < lines.length) {
              const currentLine = lines[idx];
              const actualMatch = currentLine.match(/\uD83D\uDD50\uFE0F?\s*(\d+)h\s*(\d+)m|\uD83D\uDD50\uFE0F?\s*(\d+)h(?!\s*\d)|\uD83D\uDD50\uFE0F?\s*(\d+)m/u);
              let totalMins = workMins;
              if (actualMatch) {
                const h = Number(actualMatch[1] ?? actualMatch[3] ?? 0);
                const m = Number(actualMatch[2] ?? actualMatch[4] ?? 0);
                totalMins += h * 60 + m;
              }
              const newH = Math.floor(totalMins / 60);
              const newM = totalMins % 60;
              const newActualStr = newH > 0 ? `🕐 ${newH}h ${newM}m` : `🕐 ${newM}m`;
              lines[idx] = actualMatch
                ? currentLine.replace(/\uD83D\uDD50\uFE0F?\s*[\d]+[hm][\d\s hm]*/u, newActualStr)
                : currentLine.trimEnd() + ' ' + newActualStr;
            }
            return lines.join('\n');
          }).then(() => new Notice(t('pomodoro.notice.logged', { minutes: workMins })));
        }
      }
      this.phase = isLongBreak ? 'long-break' : 'break';
      this.seconds = (isLongBreak ? this.settings.pomodoroLongBreakMinutes : this.settings.pomodoroBreakMinutes) * 60;
      new Notice(isLongBreak ? t('pomodoro.notice.longBreak') : t('pomodoro.notice.shortBreak'));
    } else {
      this.phase = 'work';
      this.seconds = this.settings.pomodoroWorkMinutes * 60;
      new Notice(t('pomodoro.notice.work'));
    }
    render();
  }

  onClose(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.focusManager.restoreFocus();
    this.contentEl.empty();
  }
}
