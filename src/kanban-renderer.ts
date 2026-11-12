import { todayString } from './date-utils';
import type { KanbanBoardConfig, KanbanBoardGroupBy, TaskManagerSettings } from './types';
import type { ParsedTask } from './task-scanner';
import type { TaskQuery } from './task-query';
import { renderProgressBar } from './progress-bar-decorator';
import { getStatusColorClass, getPriorityColorClass } from './color-utils';
import { renderRecurrenceHeatmap } from './recurrence-heatmap';
import { t } from './i18n';

let kanbanQuickAddSequence = 0;

export interface KanbanRenderActions {
  onOpenSource?: (task: ParsedTask) => void;
  onRemoveFromBoard?: (task: ParsedTask) => Promise<void>;
  onQuickAdd?: (text: string, statusSymbol?: string) => Promise<void>;
  getRecurrenceHistoryDates?: (task: ParsedTask) => string[];
  onSaveSettings?: () => Promise<void>;
  onRerender?: () => void;
  onMoveToGroup?: (task: ParsedTask, groupBy: KanbanBoardGroupBy, value: string, customFieldKey?: string) => Promise<void>;
  /** Optional override for the text shown as a card's description (e.g. to hide inline tags). */
  taskText?: (task: ParsedTask) => string;
  /** Optional bounded mounting policy used by compact/sidebar surfaces only. */
  renderLimit?: { initialTotal: number; increment: number };
}

export function allocateKanbanVisibleCounts(counts: readonly number[], totalLimit: number): number[] {
  const allocated = counts.map(() => 0);
  let remaining = Math.max(0, Math.floor(totalLimit));
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (let index = 0; index < counts.length && remaining > 0; index += 1) {
      if ((allocated[index] ?? 0) >= (counts[index] ?? 0)) continue;
      allocated[index] += 1;
      remaining -= 1;
      progressed = true;
    }
  }
  return allocated;
}

export function renderKanban(
  el: HTMLElement,
  tasks: ParsedTask[],
  _query: TaskQuery,
  settings: TaskManagerSettings,
  onToggle: (task: ParsedTask) => Promise<void>,
  onEdit: (task: ParsedTask) => void,
  onChangeStatus?: (task: ParsedTask, symbol: string) => Promise<void>,
  onCreate?: (statusSymbol?: string) => void,
  actions: KanbanRenderActions = {},
): void {
  el.addClass('task-manager-kanban');
  const activeBoard = activeKanbanBoard(settings);
  const statusBoard = activeBoard.groupBy === 'status';
  renderBoardSelector(el, settings, activeBoard, actions);
  if (!statusBoard) {
    const note = el.createDiv({ cls: 'task-manager-kanban-mode-note' });
    note.setAttr('role', 'note');
    note.setText(actions.onMoveToGroup
      ? `Grouped by ${activeBoard.groupBy}. Use each card's More actions menu to move it without dragging.`
      : `Grouped by ${activeBoard.groupBy}; this board is a read-only grouping view. Open or edit a task to change its ${activeBoard.groupBy} value.`);
  }
  const board = el.createDiv({ cls: 'task-manager-kanban-board' });
  if (activeBoard.background) {
    board.addClass('task-manager-kanban-board-themed');
    board.style.setProperty('--task-manager-kanban-board-bg', activeBoard.background);
  }

  let dragKey: string | null = null;
  let dragColumnName: string | null = null;
  let pointerDrag: { task: ParsedTask; sourceColumn: string; ghost: HTMLElement; active: boolean } | null = null;

  const clearKanbanDragState = (): void => {
    dragKey = null;
    dragColumnName = null;
    if (typeof document !== 'undefined') {
      document.body?.classList.remove('task-manager-kanban-drag-active');
    }
    for (const column of Array.from(el.querySelectorAll('.task-manager-kanban-column-dragover'))) {
      column.classList.remove('task-manager-kanban-column-dragover');
    }
  };

  const markKanbanDragActive = (): void => {
    if (typeof document !== 'undefined') {
      document.body?.classList.add('task-manager-kanban-drag-active');
      document.addEventListener('dragend', clearKanbanDragState, { once: true });
      document.addEventListener('drop', clearKanbanDragState, { once: true });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', clearKanbanDragState, { once: true });
    }
  };

  const columns = new Map<string, ParsedTask[]>();
  for (const column of boardColumnNames(activeBoard, settings, tasks)) columns.set(column, []);
  for (const task of tasks) {
    if (task.tags.some((tag) => tag.replace(/^#/u, '').toLowerCase() === 'kanban-hidden')) continue;
    if (!matchesBoardQuery(task, activeBoard)) continue;
    const stateDef = settings.supportedStates.find((s) => s.rawText === task.checkbox);
    const colName = boardColumnForTask(task, activeBoard, stateDef?.name ?? task.status);
    let colTasks = columns.get(colName);
    if (!colTasks) {
      colTasks = [];
      columns.set(colName, colTasks);
    }
    colTasks.push(task);
  }

  const columnEntries = [...columns.entries()];
  const boundedPolicy = actions.renderLimit
    ? { initialTotal: Math.max(1, Math.floor(actions.renderLimit.initialTotal)), increment: Math.max(1, Math.min(100, Math.floor(actions.renderLimit.increment))) }
    : null;
  const initialCounts = boundedPolicy
    ? allocateKanbanVisibleCounts(columnEntries.map(([, tasksInColumn]) => tasksInColumn.length), boundedPolicy.initialTotal)
    : columnEntries.map(([, tasksInColumn]) => tasksInColumn.length);
  const globalLoaders: Array<() => boolean> = [];

  for (const [columnIndex, [colName, colTasks]] of columnEntries.entries()) {
    const stateDef = activeBoard.groupBy === 'status' ? settings.supportedStates.find((s) => s.name === colName) : undefined;
    const isCoreState = activeBoard.groupBy !== 'status' || stateDef?.type === 'todo' || stateDef?.type === 'done';
    if (colTasks.length === 0 && !isCoreState) continue;

    const displayColName = kanbanColumnDisplayName(colName, stateDef?.type);
    const col = board.createDiv({ cls: 'task-manager-kanban-column' });
    col.setAttr('role', 'group');
    col.setAttr('aria-label', `${displayColName} (${colTasks.length} task${colTasks.length !== 1 ? 's' : ''})`);

    const hdr = col.createDiv({ cls: 'task-manager-kanban-header' });
    hdr.setAttr('role', 'heading');
    hdr.setAttr('aria-level', '3');
    const icon = stateDef ? (stateDef.icon.trim() || '') : '';
    if (stateDef) {
      hdr.addClass(getStatusColorClass(stateDef.rawText));
    }
    if (icon) hdr.createEl('span', { text: icon, cls: 'task-manager-kanban-col-icon' });
    hdr.createEl('span', { text: displayColName, cls: 'task-manager-kanban-col-title' });
    if (colTasks.length > 0) {
      hdr.createEl('span', { text: String(colTasks.length), cls: 'task-manager-kanban-col-count' });
    }
    if (_query.wipLimit && stateDef?.type === 'in_progress') {
      const wip = hdr.createEl('span', { text: `WIP ${colTasks.length}/${_query.wipLimit}`, cls: 'task-manager-kanban-wip' });
      if (colTasks.length > _query.wipLimit) wip.addClass('is-over-limit');
    }
    if (onCreate) {
      const addBtn = hdr.createEl('button', { text: '+', cls: 'task-manager-kanban-add-btn' });
      addBtn.setAttr('title', `Create task in ${displayColName}`);
      addBtn.setAttr('aria-label', `Add task to ${displayColName}`);
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onCreate(stateDef?.rawText);
      });
    }

    if (onCreate) {
      const quickAddId = `task-manager-kanban-quick-add-${kanbanQuickAddSequence++}`;
      const quickAddLabel = col.createEl('label', { text: `Add task to ${displayColName}`, cls: 'task-manager-kanban-quick-add-label' });
      quickAddLabel.htmlFor = quickAddId;
      const quickAdd = col.createEl('input', { type: 'text', cls: 'task-manager-kanban-quick-add', placeholder: '+ Add quick task' });
      quickAdd.id = quickAddId;
      quickAdd.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const text = quickAdd.value.trim();
        if (text && actions.onQuickAdd) {
          void actions.onQuickAdd(text, stateDef?.rawText).then(() => { quickAdd.value = ''; });
        } else {
          onCreate(stateDef?.rawText);
          quickAdd.value = '';
        }
        window.setTimeout(() => quickAdd.focus(), 0);
      });
    }

    col.setAttr('data-column', colName);
    if (statusBoard) {
      col.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        col.addClass('task-manager-kanban-column-dragover');
      });
      col.addEventListener('dragleave', (e: DragEvent) => {
        // Only remove the highlight when the pointer truly leaves the column.
        // The DragEvent API fires dragleave on a parent element whenever the
        // cursor enters any child element, which causes the column highlight to
        // flicker every time the user hovers over a card during a drag.  Checking
        // relatedTarget prevents the false-negative removal.
        if (!col.contains(e.relatedTarget as Node)) {
          col.removeClass('task-manager-kanban-column-dragover');
        }
      });
      col.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        col.removeClass('task-manager-kanban-column-dragover');
        // For intra-kanban drags, dragKey is set by the card's dragstart listener.
        // For cross-view drops (e.g. from the list view via setupListTaskDrag), dragKey
        // is null — fall back to reading the task key from dataTransfer.
        const resolvedKey = dragKey
          || e.dataTransfer?.getData('application/task-id')
          || e.dataTransfer?.getData('text/plain')
          || null;
        const wasIntraKanbanDrag = dragKey !== null;
        const sourceColumnName = dragColumnName;
        clearKanbanDragState();
        if (!resolvedKey) return;
        // Prevent same-column drops, but only for intra-kanban moves where dragColumnName is known.
        if (wasIntraKanbanDrag && sourceColumnName === colName) return;
        const task = tasks.find((t) => t.key === resolvedKey);
        if (!task || !stateDef) return;
        if (onChangeStatus) {
          void onChangeStatus(task, stateDef.rawText);
        } else {
          void onToggle(task);
        }
      });
    }

    const cardsContainer = col.createDiv({ cls: 'task-manager-kanban-cards' });
    const renderCard = (task: ParsedTask): void => {
      const priority = task.metadata.priority || 'normal';
      const statusType = task.status === 'done' ? 'done' : task.status === 'in_progress' ? 'in_progress' : task.status === 'cancelled' ? 'cancelled' : 'todo';
      const card = cardsContainer.createDiv({ cls: `task-manager-kanban-card task-priority-${priority} task-status-${statusType}` });
      card.addClass('task-manager-filterable-item');
      card.addClass(getPriorityColorClass(priority));
      card.addClass(getStatusColorClass(task.checkbox));
      card.setAttr('data-task-tags', task.tags.join(','));
      card.setAttr('data-task-filter-text', [
        task.normalizedText,
        task.filePath,
        task.status,
        task.metadata.priority,
        task.metadata.dates.due,
        task.metadata.dates.scheduled,
        task.metadata.id,
        ...task.tags,
      ].filter(Boolean).join(' ').toLowerCase());
      card.setAttr('draggable', statusBoard ? 'true' : 'false');
      card.setAttr('role', 'article');
      card.setAttr('tabindex', '0');
      card.setAttr('aria-label', `Open or edit task: ${task.normalizedText}. Status: ${displayColName}${task.metadata.priority ? '. Priority: ' + task.metadata.priority : ''}${task.metadata.dates.due ? '. Due: ' + task.metadata.dates.due : ''}`);
      card.setAttr('aria-keyshortcuts', 'Enter Space');
      card.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit(task);
        }
      });

      if (statusBoard) {
        card.addEventListener('pointerdown', () => {
          // Hide editor-side ghost toolbars before the browser fires dragstart;
          // otherwise they can flash under the cursor while a card drag begins.
          card.addClass('is-actions-visible');
          markKanbanDragActive();

          const clearIfNoDrag = (): void => {
            if (dragKey === null) clearKanbanDragState();
            card.removeClass('is-actions-visible');
            window.removeEventListener('pointerup', clearIfNoDrag);
            window.removeEventListener('pointercancel', clearAndRemove);
          };

          const clearAndRemove = (): void => {
            clearKanbanDragState();
            card.removeClass('is-actions-visible');
            window.removeEventListener('pointerup', clearIfNoDrag);
            window.removeEventListener('pointercancel', clearAndRemove);
          };

          if (typeof window !== 'undefined') {
            window.addEventListener('pointerup', clearIfNoDrag);
            window.addEventListener('pointercancel', clearAndRemove);
          }
        });

        card.addEventListener('pointerdown', (event: PointerEvent) => {
          if (event.button !== 0 || event.pointerType === 'mouse') return;
          card.setPointerCapture?.(event.pointerId);
          const startX = event.clientX;
          const startY = event.clientY;
          const isTouchLike = event.pointerType === 'touch';
          const ghost = card.cloneNode(true) as HTMLElement;
          ghost.addClass('task-manager-kanban-pointer-ghost');
          ghost.style.display = 'none';
          document.body.appendChild(ghost);

          let dragStarted = false;
          let cancelled = false;
          let longPressTimer: number | null = null;

          const cleanup = (): void => {
            if (longPressTimer !== null) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            document.removeEventListener('pointercancel', cancel);
            card.removeClass('task-manager-kanban-card-dragging');
            card.removeClass('is-actions-visible');
            card.style.touchAction = '';
            ghost.remove();
            if (pointerDrag?.task === task && pointerDrag.sourceColumn === colName) pointerDrag = null;
          };

          const startDrag = (): void => {
            if (dragStarted || cancelled) return;
            dragStarted = true;
            pointerDrag = { task, sourceColumn: colName, ghost, active: true };
            card.addClass('task-manager-kanban-card-dragging');
            card.style.touchAction = 'none';
            ghost.style.display = '';
            markKanbanDragActive();
          };

          const move = (moveEvent: PointerEvent): void => {
            if (cancelled) return;
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            const distance = Math.hypot(dx, dy);
            if (!dragStarted) {
              if (isTouchLike) {
                if (distance > 8) {
                  cancelled = true;
                  cleanup();
                }
                return;
              }
              if (distance < 10) return;
              startDrag();
            }
            if (!dragStarted) return;
            ghost.style.left = `${moveEvent.clientX + 8}px`;
            ghost.style.top = `${moveEvent.clientY + 8}px`;
            for (const column of Array.from(el.querySelectorAll<HTMLElement>('.task-manager-kanban-column'))) {
              const rect = column.getBoundingClientRect();
              const over = moveEvent.clientX >= rect.left && moveEvent.clientX <= rect.right && moveEvent.clientY >= rect.top && moveEvent.clientY <= rect.bottom;
              column.toggleClass('task-manager-kanban-column-dragover', over);
            }
          };

          const end = (endEvent: PointerEvent): void => {
            void (async () => {
              const activeDrag = pointerDrag;
              cleanup();
              if (!dragStarted || cancelled || !activeDrag?.active) return;
              for (const column of Array.from(el.querySelectorAll<HTMLElement>('.task-manager-kanban-column-dragover'))) column.removeClass('task-manager-kanban-column-dragover');
              const target = document.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<HTMLElement>('.task-manager-kanban-column');
              const targetName = target?.getAttribute('data-column');
              if (!targetName || targetName === activeDrag.sourceColumn) return;
              const targetState = settings.supportedStates.find((state) => state.name === targetName);
              if (targetState && onChangeStatus) await onChangeStatus(activeDrag.task, targetState.rawText);
              else await onToggle(activeDrag.task);
            })();
          };

          const cancel = (): void => {
            cancelled = true;
            cleanup();
          };

          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', end);
          document.addEventListener('pointercancel', cancel);

          if (isTouchLike) {
            longPressTimer = window.setTimeout(() => {
              longPressTimer = null;
              startDrag();
            }, 425);
          }
        });

        card.addEventListener('dragstart', (e: DragEvent) => {
          dragKey = task.key;
          dragColumnName = colName;
          markKanbanDragActive();
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/task-id', task.key);
            e.dataTransfer.setData('text/plain', task.key);
            e.dataTransfer.setData('application/json', JSON.stringify({ taskKey: task.key, taskText: task.normalizedText, priority: task.metadata.priority }));
          }
          card.addClass('task-manager-kanban-card-dragging');
        });
        card.addEventListener('dragend', () => {
          card.removeClass('task-manager-kanban-card-dragging');
          card.removeClass('is-actions-visible');
          clearKanbanDragState();
        });
      }

      const topRow = card.createDiv({ cls: 'task-manager-kanban-card-top' });

      const actionWrap = card.createDiv({ cls: 'task-manager-kanban-card-actions' });
      const editBtn = actionWrap.createEl('button', { text: '✎', cls: 'task-manager-kanban-card-action' });
      editBtn.setAttr('type', 'button');
      editBtn.setAttr('title', 'Edit task');
      editBtn.setAttr('aria-label', `Edit task: ${task.normalizedText}`);
      editBtn.addEventListener('click', (event) => { event.stopPropagation(); onEdit(task); });
      let closeOpenMenu: ((restoreFocus: boolean) => void) | null = null;
      const moreBtn = actionWrap.createEl('button', { text: '⋯', cls: 'task-manager-kanban-card-action' });
      moreBtn.setAttr('type', 'button');
      moreBtn.setAttr('title', 'More actions');
      moreBtn.setAttr('aria-label', `More actions for ${task.normalizedText}`);
      moreBtn.setAttr('aria-haspopup', 'menu');
      moreBtn.setAttr('aria-expanded', 'false');
      moreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (closeOpenMenu) { closeOpenMenu(true); return; }
        const menu = card.createDiv({ cls: 'task-manager-kanban-card-menu' });
        menu.setAttr('role', 'menu');
        menu.setAttr('aria-label', `Actions for ${task.normalizedText}`);
        let outsideListener: ((event: MouseEvent) => void) | null = null;
        const closeMenu = (restoreFocus: boolean): void => {
          menu.remove();
          moreBtn.setAttr('aria-expanded', 'false');
          if (outsideListener && typeof document !== 'undefined') document.removeEventListener('click', outsideListener);
          outsideListener = null;
          closeOpenMenu = null;
          if (restoreFocus) moreBtn.focus();
        };
        closeOpenMenu = closeMenu;
        const addMenuButton = (label: string, cb: () => void): void => {
          const btn = menu.createEl('button', { text: label });
          btn.setAttr('type', 'button');
          btn.setAttr('role', 'menuitem');
          btn.addEventListener('click', () => { closeMenu(true); cb(); });
        };
        addMenuButton('Open source', () => actions.onOpenSource?.(task));
        addMenuButton('Edit task', () => onEdit(task));
        addMenuButton('Remove from board', () => { void actions.onRemoveFromBoard?.(task); });
        if (activeBoard.groupBy === 'status' && onChangeStatus) {
          menu.createDiv({ text: t('kanban.moveTo'), cls: 'task-manager-kanban-card-menu-section' });
          for (const state of settings.supportedStates.filter((candidate) => candidate.name !== colName)) {
            addMenuButton(`→ ${state.name}`, () => { void onChangeStatus(task, state.rawText); });
          }
        } else if (actions.onMoveToGroup) {
          menu.createDiv({ text: t('kanban.moveTo'), cls: 'task-manager-kanban-card-menu-section' });
          for (const targetColumn of columnEntries.map(([name]) => name).filter((name) => name !== colName)) {
            addMenuButton(`→ ${targetColumn}`, () => {
              void actions.onMoveToGroup?.(task, activeBoard.groupBy, targetColumn, activeBoard.customFieldKey);
            });
          }
        }
        moreBtn.setAttr('aria-expanded', 'true');
        menu.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu(true);
            return;
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          if (items.length === 0) return;
          event.preventDefault();
          const base = current < 0 ? (event.key === 'ArrowDown' ? -1 : 0) : current;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (base + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        });
        const scheduleTimeout = typeof window !== 'undefined' ? window.setTimeout.bind(window) : setTimeout;
        scheduleTimeout(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
          outsideListener = (closeEvent: MouseEvent): void => {
            if (!menu.contains(closeEvent.target as Node)) closeMenu(false);
          };
          document.addEventListener('click', outsideListener);
          menu.querySelector<HTMLButtonElement>('button')?.focus();
        }, 0);
      });

      const cbHit = topRow.createEl('label', { cls: 'task-manager-kanban-checkbox-hit' });
      const cb = cbHit.createEl('input', { type: 'checkbox' });
      cb.checked = task.status === 'done';
      cb.setAttr('aria-label', `Mark task as ${task.status === 'done' ? 'incomplete' : 'complete'}: ${task.normalizedText}`);
      cb.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void onToggle(task);
      });

      const descEl = topRow.createEl('button', { text: actions.taskText ? actions.taskText(task) : task.normalizedText, cls: 'task-manager-kanban-card-desc' });
      descEl.setAttr('type', 'button');
      descEl.setAttr('aria-label', `Edit ${task.normalizedText}`);
      descEl.addEventListener('click', () => onEdit(task));

      const allAfter = tasks
        .filter((t) => t.filePath === task.filePath && t.lineNumber > task.lineNumber)
        .sort((a, b) => a.lineNumber - b.lineNumber);
      const children: ParsedTask[] = [];
      for (const t of allAfter) {
        if (t.indentation.length <= task.indentation.length) break;
        children.push(t);
      }
      if (children.length > 0) {
        const doneCount = children.filter((t) => t.status === 'done' || t.status === 'cancelled').length;
        const progressBarEl = renderProgressBar(doneCount, children.length);
        card.appendChild(progressBarEl);
      }

      const heatmap = settings.recurringHeatmapEnabled ? renderRecurrenceHeatmap(task, tasks, actions.getRecurrenceHistoryDates?.(task) ?? []) : null;
      if (heatmap) card.appendChild(heatmap);

      const meta = card.createDiv({ cls: 'task-manager-kanban-card-meta' });
      if (task.metadata.dates.due) {
        const today = todayString();
        const isOverdue = task.metadata.dates.due < today && task.status !== 'done' && task.status !== 'cancelled';
        meta.createEl('span', {
          text: `📅 ${task.metadata.dates.due}`,
          cls: `task-manager-kanban-card-due${isOverdue ? ' is-overdue' : ''}`,
        });
      } else if (task.metadata.dates.scheduled) {
        meta.createEl('span', { text: `⏳ ${task.metadata.dates.scheduled}`, cls: 'task-manager-kanban-card-due' });
      }
      if (task.metadata.priority && task.metadata.priority !== 'normal') {
        const pIcon = ({ highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' } as Record<string, string>)[task.metadata.priority] ?? '';
        meta.createEl('span', { text: pIcon, cls: 'task-manager-kanban-card-priority' });
      }
      if (task.tags.length > 0) {
        const tagsEl = meta.createEl('span', { cls: 'task-manager-kanban-card-tags' });
        for (const tag of task.tags.slice(0, 3)) {
          tagsEl.createEl('span', { text: tag, cls: 'task-manager-kanban-card-tag' });
        }
      }

      const footer = card.createDiv({ cls: 'task-manager-kanban-card-footer' });
      const fileEl = footer.createEl('span', { cls: 'task-manager-kanban-card-file' });
      fileEl.setText(task.filePath.split('/').pop()?.replace(/\.md$/u, '') ?? task.filePath);
    };

    let visibleCount = 0;
    let loadMoreButton: HTMLButtonElement | null = null;
    let countStatus: HTMLElement | null = null;
    const updateBoundedControls = (): void => {
      if (!boundedPolicy || !countStatus) return;
      countStatus.setText(`Showing ${visibleCount} of ${colTasks.length} tasks in ${displayColName}`);
      if (!loadMoreButton) return;
      const remaining = colTasks.length - visibleCount;
      if (remaining <= 0) {
        loadMoreButton.setText(`All ${colTasks.length} shown`);
        loadMoreButton.setAttr('aria-label', `All tasks shown in ${displayColName}`);
        loadMoreButton.disabled = true;
      } else {
        const amount = Math.min(boundedPolicy.increment, remaining);
        loadMoreButton.setText(`Show ${amount} more`);
        loadMoreButton.setAttr('aria-label', `Show ${amount} more tasks in ${displayColName}. ${visibleCount} of ${colTasks.length} shown`);
        loadMoreButton.disabled = false;
      }
    };
    const appendOne = (): boolean => {
      const task = colTasks[visibleCount];
      if (!task) return false;
      renderCard(task);
      visibleCount += 1;
      updateBoundedControls();
      return true;
    };
    const appendMany = (amount: number): number => {
      let appended = 0;
      while (appended < amount && appendOne()) appended += 1;
      return appended;
    };
    appendMany(initialCounts[columnIndex] ?? colTasks.length);

    if (boundedPolicy && colTasks.length > 0) {
      countStatus = col.createDiv({ cls: 'task-manager-kanban-mount-status' });
      countStatus.setAttr('role', 'status');
      countStatus.setAttr('aria-live', 'polite');
      countStatus.tabIndex = -1;
      loadMoreButton = col.createEl('button', { cls: 'task-manager-kanban-load-more' });
      loadMoreButton.setAttr('type', 'button');
      loadMoreButton.addEventListener('click', () => {
        appendMany(boundedPolicy.increment);
        updateBoundedControls();
        if (loadMoreButton?.disabled) countStatus?.focus();
        else loadMoreButton?.focus();
      });
      updateBoundedControls();
      globalLoaders.push(appendOne);
    }

    if (colTasks.length === 0) {
      col.createDiv({ cls: 'task-manager-kanban-empty', text: 'Drop here' });
    }
  }

  if (boundedPolicy && globalLoaders.length > 0) {
    const controls = el.createDiv({ cls: 'task-manager-kanban-global-mount-controls' });
    const status = controls.createDiv({ cls: 'task-manager-kanban-global-mount-status' });
    status.setAttr('role', 'status');
    status.setAttr('aria-live', 'polite');
    status.tabIndex = -1;
    const button = controls.createEl('button', { cls: 'task-manager-kanban-global-load-more' });
    button.setAttr('type', 'button');
    let loaderCursor = 0;
    const totalCards = columnEntries.reduce((total, [, columnTasks]) => total + columnTasks.length, 0);
    const mountedCards = (): number => el.querySelectorAll('.task-manager-kanban-card').length;
    const updateGlobal = (): void => {
      const mounted = mountedCards();
      const remaining = Math.max(0, totalCards - mounted);
      status.setText(`Showing ${mounted} of ${totalCards} Kanban tasks`);
      if (remaining === 0) {
        button.setText(`All ${totalCards} shown`);
        button.setAttr('aria-label', t('kanban.allTasksShown'));
        button.disabled = true;
      } else {
        const amount = Math.min(boundedPolicy.increment, remaining);
        button.setText(`Show ${amount} more across board`);
        button.setAttr('aria-label', `Show ${amount} more Kanban tasks. ${mounted} of ${totalCards} shown`);
        button.disabled = false;
      }
    };
    button.addEventListener('click', () => {
      let appended = 0;
      let misses = 0;
      while (appended < boundedPolicy.increment && misses < globalLoaders.length) {
        const loader = globalLoaders[loaderCursor % globalLoaders.length];
        loaderCursor = (loaderCursor + 1) % globalLoaders.length;
        if (loader?.()) { appended += 1; misses = 0; }
        else misses += 1;
      }
      updateGlobal();
      if (button.disabled) status.focus();
      else button.focus();
    });
    updateGlobal();
  }
}

function activeKanbanBoard(settings: TaskManagerSettings): KanbanBoardConfig {
  const boards = settings.kanbanBoards ?? [];
  return boards.find((board) => board.id === settings.activeKanbanBoardId) ?? boards[0] ?? {
    id: 'default-status-board', name: 'Status Board', query: 'all', groupBy: 'status', columns: [], background: '',
  };
}

function renderBoardSelector(el: HTMLElement, settings: TaskManagerSettings, active: KanbanBoardConfig, actions: KanbanRenderActions): void {
  const toolbar = el.createDiv({ cls: 'task-manager-kanban-board-toolbar' });
  const syncBoards = (nextBoards: KanbanBoardConfig[], nextActiveId: string): void => {
    settings.kanbanBoards = nextBoards;
    settings.activeKanbanBoardId = nextActiveId;
    void actions.onSaveSettings?.();
    actions.onRerender?.();
  };
  const getBoardContext = (): { boards: KanbanBoardConfig[]; currentIndex: number; currentBoard: KanbanBoardConfig } => {
    const currentActive = activeKanbanBoard(settings);
    const boards = resolvedBoards(settings, currentActive);
    const currentIndex = Math.max(0, boards.findIndex((board) => board.id === settings.activeKanbanBoardId || board.id === currentActive.id));
    return { boards, currentIndex, currentBoard: boards[currentIndex] ?? boards[0] ?? currentActive };
  };
  const initial = getBoardContext();
  const duplicateBoard = (source: KanbanBoardConfig, name: string, ctx: { boards: KanbanBoardConfig[]; currentIndex: number }): void => {
    const cloned = {
      ...source,
      id: uniqueBoardId(ctx.boards, source.id),
      name: uniqueBoardName(ctx.boards, name),
      columns: [...source.columns],
    };
    const nextBoards = [...ctx.boards];
    nextBoards.splice(ctx.currentIndex + 1, 0, cloned);
    syncBoards(nextBoards, cloned.id);
  };

  const headerGroup = toolbar.createDiv({ cls: 'task-manager-kanban-board-switcher' });
  headerGroup.createEl('span', { text: 'Board', cls: 'task-manager-kanban-board-label' });
  const select = headerGroup.createEl('select', { cls: 'task-manager-kanban-board-select' });
  select.setAttr('aria-label', 'Switch Kanban board');
  for (const board of initial.boards) select.createEl('option', { text: board.name, value: board.id });
  select.value = initial.currentBoard.id;
  select.addEventListener('change', () => {
    settings.activeKanbanBoardId = select.value;
    void actions.onSaveSettings?.();
    void actions.onRerender?.();
  });

  if (actions.onSaveSettings) {
    const actionGroup = toolbar.createDiv({ cls: 'task-manager-kanban-board-actions' });

    const newBtn = actionGroup.createEl('button', { text: '＋', cls: 'task-manager-kanban-board-action' });
    newBtn.setAttr('type', 'button');
    newBtn.setAttr('aria-label', 'Create new board');
    newBtn.addEventListener('click', () => {
      const ctx = getBoardContext();
      const name = prompt('New board name:', uniqueBoardName(ctx.boards, 'New board'))?.trim();
      if (!name) return;
      duplicateBoard(ctx.currentBoard, name, ctx);
    });

    const dupBtn = actionGroup.createEl('button', { text: '⧉', cls: 'task-manager-kanban-board-action' });
    dupBtn.setAttr('type', 'button');
    dupBtn.setAttr('aria-label', 'Duplicate board');
    dupBtn.addEventListener('click', () => {
      const ctx = getBoardContext();
      const name = prompt(`Duplicate "${ctx.currentBoard.name}" as:`, uniqueBoardName(ctx.boards, `${ctx.currentBoard.name} copy`))?.trim();
      if (!name) return;
      duplicateBoard(ctx.currentBoard, name, ctx);
    });

    const editBtn = actionGroup.createEl('button', { text: 'Edit', cls: 'task-manager-kanban-board-action' });
    editBtn.setAttr('type', 'button');
    editBtn.setAttr('aria-label', 'Edit board');
    editBtn.addEventListener('click', () => {
      const ctx = getBoardContext();
      const edited = promptForBoardConfig(ctx.currentBoard);
      if (!edited) return;
      const nextBoards = ctx.boards.map((board) => board.id === ctx.currentBoard.id ? edited : board);
      syncBoards(nextBoards, edited.id);
    });

    const deleteBtn = actionGroup.createEl('button', { text: '🗑', cls: 'task-manager-kanban-board-action' });
    deleteBtn.setAttr('type', 'button');
    deleteBtn.setAttr('aria-label', 'Delete board');
    deleteBtn.addEventListener('click', () => {
      const ctx = getBoardContext();
      const confirmation = prompt(`Type DELETE to remove "${ctx.currentBoard.name}"`, '');
      if (confirmation !== 'DELETE') return;
      const remaining = ctx.boards.filter((board) => board.id !== ctx.currentBoard.id);
      if (remaining.length === 0) {
        syncBoards([], '');
        return;
      }
      const nextActive = remaining[Math.min(ctx.currentIndex, remaining.length - 1)]?.id ?? remaining[0].id;
      syncBoards(remaining, nextActive);
    });
  }

  const label = toolbar.createEl('span', { text: `Group: ${initial.currentBoard.groupBy}${initial.currentBoard.customFieldKey ? `:${initial.currentBoard.customFieldKey}` : ''}`, cls: 'task-manager-kanban-board-mode' });
  label.setAttr('title', initial.currentBoard.query || 'not done');
}

function promptForBoardConfig(board: KanbanBoardConfig): KanbanBoardConfig | null {
  const name = prompt('Board name:', board.name);
  if (name === null) return null;
  const query = prompt('Board query:', board.query);
  if (query === null) return null;
  const groupBy = prompt('Group by (status, priority, tag, project, assignee, custom):', board.groupBy);
  if (groupBy === null) return null;
  const normalizedGroupBy = normalizeBoardGroupBy(groupBy, board.groupBy);
  if (!normalizedGroupBy) return null;
  const customFieldKey = normalizedGroupBy === 'custom'
    ? prompt('Custom field key:', board.customFieldKey ?? '')
    : '';
  if (normalizedGroupBy === 'custom' && customFieldKey === null) return null;
  const columns = prompt('Columns (comma-separated; blank keeps current):', board.columns.join(', '));
  if (columns === null) return null;
  const background = prompt('Background (CSS color or gradient; blank keeps current):', board.background);
  if (background === null) return null;
  return {
    ...board,
    name: name.trim() || board.name,
    query: query.trim() || board.query,
    groupBy: normalizedGroupBy,
    customFieldKey: normalizedGroupBy === 'custom' ? (customFieldKey?.trim() || board.customFieldKey) : undefined,
    columns: columns.trim()
      ? columns.split(',').map((value) => value.trim()).filter(Boolean)
      : [...board.columns],
    background: background.trim() || board.background,
  };
}

function normalizeBoardGroupBy(value: string, fallback: KanbanBoardGroupBy): KanbanBoardGroupBy | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  switch (normalized) {
    case 'status':
    case 'priority':
    case 'tag':
    case 'project':
    case 'assignee':
    case 'custom':
      return normalized;
    default:
      return null;
  }
}

function resolvedBoards(settings: TaskManagerSettings, active: KanbanBoardConfig): KanbanBoardConfig[] {
  return (settings.kanbanBoards ?? []).length > 0 ? (settings.kanbanBoards ?? []) : [active];
}

function uniqueBoardId(boards: readonly KanbanBoardConfig[], base: string): string {
  const slug = base.trim().toLowerCase().replace(/[^a-z0-9]+/giu, '-').replace(/^-+|-+$/gu, '') || 'board';
  let candidate = slug;
  let suffix = 2;
  while (boards.some((board) => board.id === candidate)) {
    candidate = `${slug}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function uniqueBoardName(boards: readonly KanbanBoardConfig[], base: string): string {
  const trimmed = base.trim() || 'Board';
  let candidate = trimmed;
  let suffix = 2;
  while (boards.some((board) => board.name.toLowerCase() === candidate.toLowerCase())) {
    candidate = `${trimmed} ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function boardColumnNames(board: KanbanBoardConfig, settings: TaskManagerSettings, tasks: readonly ParsedTask[]): string[] {
  if (board.columns.length > 0) return board.columns;
  if (board.groupBy === 'status') return settings.supportedStates.map((state) => state.name);
  const values = new Set<string>();
  for (const task of tasks) values.add(boardColumnForTask(task, board, 'Inbox'));
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function boardColumnForTask(task: ParsedTask, board: KanbanBoardConfig, fallback: string): string {
  if (board.groupBy === 'status') return fallback;
  if (board.groupBy === 'priority') return task.metadata.priority ?? 'normal';
  if (board.groupBy === 'project') return task.metadata.project ?? 'No project';
  if (board.groupBy === 'assignee') return task.metadata.assignee ?? 'Unassigned';
  if (board.groupBy === 'tag') return task.tags[0]?.replace(/^#/u, '') || 'No tag';
  if (board.groupBy === 'custom' && board.customFieldKey) {
    const value = task.metadata.customFields?.[board.customFieldKey.toLowerCase()]?.value;
    if (Array.isArray(value)) return value[0] ?? 'None';
    return value === undefined || value === '' ? 'None' : String(value);
  }
  return fallback;
}

function matchesBoardQuery(task: ParsedTask, board: KanbanBoardConfig): boolean {
  const query = board.query.trim().toLowerCase();
  if (!query || query === 'not done') return task.status !== 'done' && task.status !== 'cancelled';
  if (query === 'all') return true;
  if (query.startsWith('tag ')) {
    const tag = query.replace(/^tag\s+/u, '').replace(/^#/u, '');
    return task.tags.some((candidate) => candidate.replace(/^#/u, '').toLowerCase() === tag);
  }
  return `${task.normalizedText} ${task.filePath} ${task.status} ${task.tags.join(' ')}`.toLowerCase().includes(query);
}
function kanbanColumnDisplayName(name: string, type?: string): string {
  switch (type) {
    case 'in_progress':
      return 'Doing';
    case 'deferred':
      return 'Later';
    case 'cancelled':
      return 'Cancel';
    case 'blocked':
      return name.toLowerCase() === 'waiting' ? 'Wait' : name;
    default:
      return name;
  }
}
