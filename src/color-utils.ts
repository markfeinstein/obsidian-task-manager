/**
 * Color Utility Helpers for Priority and Status Coloring (T1-4)
 * Provides consistent color application across all renderers
 */

export function getPriorityColorClass(priority?: string): string {
  switch (priority?.toLowerCase()) {
    case 'highest':
      return 'task-priority-highest';
    case 'high':
      return 'task-priority-high';
    case 'medium':
      return 'task-priority-medium';
    case 'low':
      return 'task-priority-low';
    case 'lowest':
      return 'task-priority-lowest';
    case 'normal':
    default:
      return 'task-priority-normal';
  }
}

export function getPriorityBackgroundClass(priority?: string): string {
  switch (priority?.toLowerCase()) {
    case 'highest':
      return 'task-priority-bg-highest';
    case 'high':
      return 'task-priority-bg-high';
    case 'medium':
      return 'task-priority-bg-medium';
    case 'low':
      return 'task-priority-bg-low';
    case 'lowest':
      return 'task-priority-bg-lowest';
    case 'normal':
    default:
      return 'task-priority-bg-normal';
  }
}

export function getStatusColorClass(checkbox?: string): string {
  switch (checkbox) {
    case 'x':
    case 'X':
      return 'task-status-done';
    case '/':
      return 'task-status-in-progress';
    case '!':
    case 'w':
    case 'W':
      return 'task-status-blocked';
    case '?':
      return 'task-status-waiting';
    case '>':
      return 'task-status-deferred';
    case '-':
      return 'task-status-cancelled';
    case ' ':
    default:
      return 'task-status-todo';
  }
}

export function getStatusBackgroundClass(checkbox?: string): string {
  switch (checkbox) {
    case 'x':
    case 'X':
      return 'task-status-bg-done';
    case '/':
      return 'task-status-bg-in-progress';
    case '!':
    case 'w':
    case 'W':
      return 'task-status-bg-blocked';
    case '?':
      return 'task-status-bg-waiting';
    case '>':
      return 'task-status-bg-deferred';
    case '-':
      return 'task-status-bg-cancelled';
    case ' ':
    default:
      return 'task-status-bg-todo';
  }
}

/**
 * Apply priority color to an element
 */
export function applyPriorityColor(element: HTMLElement, priority?: string): void {
  // Remove existing priority classes
  Array.from(element.classList).forEach((c) => {
    if (c.startsWith('task-priority-') && !c.startsWith('task-priority-bg-')) {
      element.classList.remove(c);
    }
  });
  // Add new priority class
  element.classList.add(getPriorityColorClass(priority));
}

/**
 * Apply status color to an element
 */
export function applyStatusColor(element: HTMLElement, checkbox?: string): void {
  // Remove existing status classes
  Array.from(element.classList).forEach((c) => {
    if (c.startsWith('task-status-') && !c.startsWith('task-status-bg-')) {
      element.classList.remove(c);
    }
  });
  // Add new status class
  element.classList.add(getStatusColorClass(checkbox));
}
