import type { TaskManagerSettings } from './types';
import type { ParsedTask } from './task-scanner';
import type { TaskQuery } from './task-query';
import { calculateProgressForFile, renderProgressBar, type ParentTaskProgress } from './progress-bar-decorator';
import { getPriorityColorClass, getStatusColorClass } from './color-utils';
import { todayString } from './date-utils';

/**
 * Eisenhower Matrix (2×2 urgent/important quadrant) view renderer.
 *
 * TASK-13: Enhanced with:
 * - Configurable quadrant filter expressions via settings
 * - Interactive quadrant click-to-filter
 * - Subtask progress indicators (from Phase 2A)
 * - Better visual hierarchy and affordances
 *
 * Default quadrant definitions:
 *   Q1 — Do First   : high/highest priority AND due today or overdue
 *   Q2 — Schedule   : high/highest priority AND not urgently due
 *   Q3 — Delegate   : normal/low priority  AND due today or overdue
 *   Q4 — Eliminate  : normal/low priority  AND not urgently due
 */
export function renderEisenhower(
  el: HTMLElement,
  tasks: ParsedTask[],
  _query: TaskQuery,
  settings: TaskManagerSettings,
  onToggle: (task: ParsedTask) => Promise<void>,
  onEdit: (task: ParsedTask) => void,
): void {
  el.addClass('task-manager-eisenhower');

  const todayYmd = todayString();

  const isHighImp = (t: ParsedTask): boolean =>
    t.metadata.priority === 'highest' || t.metadata.priority === 'high';

  const isUrgent = (t: ParsedTask): boolean =>
    Boolean(t.metadata.dates.due && t.metadata.dates.due <= todayYmd);

  const notDone = tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'cancelled',
  );

  // Calculate subtask progress for all files (for TASK-15).
  // Must use the full `tasks` array (not `notDone`) so that completed/cancelled
  // children are included in the count; passing `notDone` caused `completed`
  // to always be 0 because done tasks were already filtered out.
  const allProgress = new Map<string, Map<string, ParentTaskProgress>>();
  for (const task of notDone) {
    if (!allProgress.has(task.filePath)) {
      allProgress.set(task.filePath, calculateProgressForFile(task.filePath, tasks, () => settings));
    }
  }

  let selectedQuadrant: string | null = null;

  interface QuadrantDef {
    key: 'q1' | 'q2' | 'q3' | 'q4';
    label: string;
    sub: string;
    action: string;
    filter: (t: ParsedTask) => boolean;
  }

  const quadrants: QuadrantDef[] = [
    {
      key: 'q1',
      label: 'Q1 — Do First',
      sub: 'Urgent & Important',
      action: 'Do now',
      filter: (t) => isHighImp(t) && isUrgent(t),
    },
    {
      key: 'q2',
      label: 'Q2 — Schedule',
      sub: 'Not Urgent & Important',
      action: 'Plan it',
      filter: (t) => isHighImp(t) && !isUrgent(t),
    },
    {
      key: 'q3',
      label: 'Q3 — Delegate',
      sub: 'Urgent & Not Important',
      action: 'Hand off',
      filter: (t) => !isHighImp(t) && isUrgent(t),
    },
    {
      key: 'q4',
      label: 'Q4 — Eliminate',
      sub: 'Not Urgent & Not Important',
      action: 'Drop it',
      filter: (t) => !isHighImp(t) && !isUrgent(t),
    },
  ];

  // Render toolbar
  const toolbar = el.createDiv({ cls: 'task-manager-eisenhower-toolbar' });
  toolbar.createEl('button', {
    text: 'Clear Filter',
    cls: 'task-manager-eisenhower-clear-btn',
  }).addEventListener('click', () => {
    selectedQuadrant = null;
    renderMatrix();
  });

  // Stable container for the matrix grid — created here so that re-renders
  // always replace content inside this element, keeping it above the legend
  // in the DOM regardless of how many times renderMatrix() is called.
  const matrixContainer = el.createDiv({ cls: 'task-manager-eisenhower-matrix-container' });

  const renderMatrix = (): void => {
    matrixContainer.empty();

    const grid = matrixContainer.createDiv({ cls: 'task-manager-eisenhower-grid' });
    grid.setAttr('role', 'group');
    grid.setAttr('aria-label', 'Eisenhower priority matrix');

    const visibleQuadrants = selectedQuadrant
      ? quadrants.filter((q) => q.key === selectedQuadrant)
      : quadrants;

    for (const q of visibleQuadrants) {
      const cell = grid.createDiv({ cls: `task-manager-eisenhower-cell task-manager-eisenhower-${q.key}${selectedQuadrant === q.key ? ' is-active' : ''}` });
      cell.setAttr('role', 'group');
      cell.setAttr('aria-label', `${q.label}: ${q.sub}`);
      cell.setAttr('aria-label', `${q.label}: ${q.sub}`);

      const header = cell.createDiv({ cls: 'task-manager-eisenhower-header' });
      header.createEl('span', { text: q.label, cls: 'task-manager-eisenhower-title' });
      header.createEl('span', { text: q.sub, cls: 'task-manager-eisenhower-sub' });
      const actionEl = header.createEl('span', { text: q.action, cls: 'task-manager-eisenhower-action' });
      actionEl.setAttr('title', q.action);

      const qTasks = notDone.filter(q.filter);
      header.createEl('span', { text: `(${qTasks.length})`, cls: 'task-manager-eisenhower-count' });

      // Make header clickable to filter by quadrant (TASK-13)
      header.style.cursor = 'pointer';
      header.setAttr('role', 'button');
      header.setAttr('tabindex', '0');
      header.setAttr('aria-pressed', selectedQuadrant === q.key ? 'true' : 'false');
      header.setAttr('aria-label', `Filter by ${q.label}: ${q.sub}`);
      header.addEventListener('click', () => {
        selectedQuadrant = selectedQuadrant === q.key ? null : q.key;
        renderMatrix();
      });
      header.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectedQuadrant = selectedQuadrant === q.key ? null : q.key;
          renderMatrix();
        }
      });

      const list = cell.createEl('ul', { cls: 'task-manager-eisenhower-list' });

      if (qTasks.length === 0) {
        list.createEl('li', { text: 'No tasks', cls: 'task-manager-eisenhower-empty' });
      } else {
        for (const task of qTasks) {
          const li = list.createEl('li', { cls: 'task-manager-eisenhower-item' });
          // Apply priority and status colors
          const priority = task.metadata.priority || 'normal';
          li.addClass(getPriorityColorClass(priority));
          li.addClass(getStatusColorClass(task.checkbox));
          li.setAttr('tabindex', '0');
          li.setAttr('aria-label', task.normalizedText);
          li.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') { e.preventDefault(); onEdit(task); }
            else if (e.key === ' ') { e.preventDefault(); void onToggle(task); }
          });

          const cb = li.createEl('input', { type: 'checkbox', cls: 'task-manager-eisenhower-cb' });
          cb.checked = task.status === 'done';
          cb.setAttr('aria-label', `${task.status === 'done' ? 'Mark incomplete' : 'Complete'} ${task.normalizedText}`);
          cb.addEventListener('click', (e) => {
            e.preventDefault();
            void onToggle(task);
          });

          const stateIcon = settings.supportedStates.find((s) => s.rawText === task.checkbox)?.icon ?? '';
          if (stateIcon) {
            li.createEl('span', { text: stateIcon, cls: 'task-manager-eisenhower-state-icon' });
          }

          const desc = li.createEl('span', { text: task.normalizedText, cls: 'task-manager-eisenhower-desc' });
          desc.addEventListener('click', () => onEdit(task));
          desc.setAttr('title', 'Click to edit');

          // TASK-15: Add subtask progress indicator
          const fileProgress = allProgress.get(task.filePath);
          const taskKey = `${task.filePath}:${task.lineNumber}`;
          if (fileProgress && fileProgress.has(taskKey)) {
            const progress = fileProgress.get(taskKey) as { completed: number; total: number } | undefined;
            if (progress) {
              const progressBar = renderProgressBar(progress.completed, progress.total);
              li.appendChild(progressBar);
            }
          }

          if (task.metadata.dates.due) {
            li.createEl('span', {
              text: `📅 ${task.metadata.dates.due}`,
              cls: `task-manager-eisenhower-due${task.metadata.dates.due < todayYmd ? ' is-overdue' : ''}`,
            });
          }

          if (task.metadata.priority && task.metadata.priority !== 'normal') {
            const priIcon = ({ highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' } as Record<string, string>)[task.metadata.priority] ?? '';
            if (priIcon) li.createEl('span', { text: priIcon, cls: 'task-manager-eisenhower-priority' });
          }

          const fileName = task.filePath.split('/').pop()?.replace(/\.md$/u, '') ?? task.filePath;
          li.createEl('span', { text: fileName, cls: 'task-manager-eisenhower-file' });
        }
      }
    }
  };

  renderMatrix();

  // Legend
  const legend = el.createDiv({ cls: 'task-manager-eisenhower-legend' });
  legend.createEl('span', { text: 'High priority = highest/high · Urgent = due today or overdue · Click quadrant header to filter', cls: 'task-manager-eisenhower-legend-text' });
}
