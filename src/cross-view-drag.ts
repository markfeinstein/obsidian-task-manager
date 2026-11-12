/**
 * Cross-View Drag/Drop Support
 * Enables tasks to be dragged between different view types (list, kanban, calendar, timeline)
 * with visual feedback and intelligent date/status assignment.
 */

import type { ParsedTask } from './task-scanner';

interface DragTaskData {
  taskKey: string;
  taskText: string;
  priority?: string;
}

function isDragTaskData(value: unknown): value is DragTaskData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return typeof data.taskKey === 'string'
    && data.taskKey.length > 0
    && typeof data.taskText === 'string'
    && data.taskText.length > 0
    && (data.priority === undefined || typeof data.priority === 'string');
}

function hasPointerLeftElement(element: HTMLElement, event: DragEvent): boolean {
  const relatedTarget = event.relatedTarget;
  return !relatedTarget || !element.contains(relatedTarget as Node);
}

/**
 * Creates a visual ghost preview element shown during drag operations
 * Positioned off-screen and updated by drag handlers
 */
export function createGhostPreview(task: ParsedTask | DragTaskData): HTMLElement {
  const ghost = document.createElement('div');
  ghost.className = 'task-manager-drag-ghost';
  ghost.style.position = 'fixed';
  ghost.style.left = '-9999px';
  ghost.style.top = '-9999px';
  ghost.style.background = 'var(--background-secondary)';
  ghost.style.border = '2px solid var(--interactive-accent)';
  ghost.style.borderRadius = '4px';
  ghost.style.padding = '8px 12px';
  ghost.style.zIndex = '9999';
  ghost.style.pointerEvents = 'none';
  ghost.style.maxWidth = '300px';
  ghost.style.overflow = 'hidden';
  ghost.style.textOverflow = 'ellipsis';
  ghost.style.whiteSpace = 'nowrap';
  ghost.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';

  // Priority badge
  const priority = 'metadata' in task ? task.metadata?.priority : task.priority;
  let badge = '';
  if (priority && priority !== 'normal') {
    const badges: Record<string, string> = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' };
    badge = badges[priority] ? `${badges[priority]} ` : '';
  }

  const text = 'normalizedText' in task ? task.normalizedText : task.taskText;
  ghost.textContent = `${badge}${text}`;

  document.body.appendChild(ghost);
  return ghost;
}

/**
 * Update ghost preview position to follow mouse cursor
 */
export function updateGhostPreviewPosition(ghost: HTMLElement, x: number, y: number): void {
  ghost.style.left = `${x + 10}px`;
  ghost.style.top = `${y + 10}px`;
}

/**
 * Clean up ghost preview element
 */
export function cleanupGhostPreview(ghost: HTMLElement): void {
  ghost.remove();
}

/**
 * Setup drag for tasks in list view
 * Adds drag event handlers and visual feedback
 * @returns Cleanup function to remove all event listeners
 */
export function setupListTaskDrag(
  element: HTMLElement,
  task: ParsedTask,
  _onTaskDropped?: (task: ParsedTask, targetType: string, data: Record<string, unknown>) => void,
): () => void {
  element.setAttribute('draggable', 'true');

  let ghostElement: HTMLElement | null = null;

  const handleDragStart = (e: DragEvent): void => {
    if (!e.dataTransfer) return;

    // Create ghost preview
    ghostElement = createGhostPreview(task);

    // Set drag data with multiple MIME types for compatibility
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/task-id', task.key);
    e.dataTransfer.setData('text/plain', task.key);
    e.dataTransfer.setData('application/json', JSON.stringify({ taskKey: task.key, taskText: task.normalizedText, priority: task.metadata.priority }));

    // Set drag image to ghost
    if (e.dataTransfer.setDragImage) {
      e.dataTransfer.setDragImage(ghostElement, 0, 0);
    }

    element.classList.add('task-manager-list-item-dragging');
  };

  const handleDrag = (e: DragEvent): void => {
    if (ghostElement) {
      updateGhostPreviewPosition(ghostElement, e.clientX, e.clientY);
    }
  };

  const handleDragEnd = (): void => {
    if (ghostElement) {
      cleanupGhostPreview(ghostElement);
      ghostElement = null;
    }
    element.classList.remove('task-manager-list-item-dragging');
  };

  element.addEventListener('dragstart', handleDragStart);
  element.addEventListener('drag', handleDrag);
  element.addEventListener('dragend', handleDragEnd);

  // Return cleanup function
  return () => {
    element.removeEventListener('dragstart', handleDragStart);
    element.removeEventListener('drag', handleDrag);
    element.removeEventListener('dragend', handleDragEnd);
    element.removeAttribute('draggable');
    // Clean up ghost if it's still around
    if (ghostElement) {
      cleanupGhostPreview(ghostElement);
      ghostElement = null;
    }
  };
}

/**
 * Setup calendar cell as a drop zone
 * Dragging tasks onto calendar cells updates the due date
 * @returns Cleanup function to remove all event listeners
 */
export function setupCalendarDropZone(
  element: HTMLElement,
  dateString: string,
  onTaskDropped?: (task: ParsedTask | DragTaskData, targetDate: string) => Promise<void>,
): () => void {
  const handleDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    element.classList.add('task-manager-calendar-cell-dragover');
  };

  const handleDragLeave = (e: DragEvent): void => {
    if (!hasPointerLeftElement(element, e)) return;
    element.classList.remove('task-manager-calendar-cell-dragover');
  };

  const handleDrop = (e: DragEvent): void => {
    e.preventDefault();
    element.classList.remove('task-manager-calendar-cell-dragover');

    if (!e.dataTransfer) return;

    const taskKey = e.dataTransfer.getData('application/task-id') || e.dataTransfer.getData('text/plain');
    if (!taskKey) return;

    // Try to extract full task data from JSON
    let taskData: DragTaskData = { taskKey, taskText: taskKey };
    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (jsonData) {
        const parsed = JSON.parse(jsonData) as unknown;
        if (isDragTaskData(parsed)) {
          taskData = parsed;
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    // Call the drop handler if provided
    if (onTaskDropped) {
      void onTaskDropped(taskData, dateString).catch((err: unknown) => {
        console.error('Error handling calendar drop:', err);
      });
    }
  };

  element.addEventListener('dragover', handleDragOver);
  element.addEventListener('dragleave', handleDragLeave);
  element.addEventListener('drop', handleDrop);

  // Return cleanup function
  return () => {
    element.removeEventListener('dragover', handleDragOver);
    element.removeEventListener('dragleave', handleDragLeave);
    element.removeEventListener('drop', handleDrop);
    element.classList.remove('task-manager-calendar-cell-dragover');
  };
}

/**
 * Setup timeline slot as a drop zone
 * Dragging tasks onto timeline slots updates the scheduled time
 * @returns Cleanup function to remove all event listeners
 */
export function setupTimelineDropZone(
  element: HTMLElement,
  slotStartTime: string,
  slotEndTime: string,
  onTaskDropped?: (task: ParsedTask | DragTaskData, startTime: string, endTime: string) => Promise<void>,
): () => void {
  const handleDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    element.classList.add('task-manager-timeline-slot-dragover');
  };

  const handleDragLeave = (e: DragEvent): void => {
    if (!hasPointerLeftElement(element, e)) return;
    element.classList.remove('task-manager-timeline-slot-dragover');
  };

  const handleDrop = (e: DragEvent): void => {
    e.preventDefault();
    element.classList.remove('task-manager-timeline-slot-dragover');

    if (!e.dataTransfer) return;

    const taskKey = e.dataTransfer.getData('application/task-id') || e.dataTransfer.getData('text/plain');
    if (!taskKey) return;

    // Try to extract full task data from JSON
    let taskData: DragTaskData = { taskKey, taskText: taskKey };
    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (jsonData) {
        const parsed = JSON.parse(jsonData) as unknown;
        if (isDragTaskData(parsed)) {
          taskData = parsed;
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    // Call the drop handler if provided
    if (onTaskDropped) {
      void onTaskDropped(taskData, slotStartTime, slotEndTime).catch((err: unknown) => {
        console.error('Error handling timeline drop:', err);
      });
    }
  };

  element.addEventListener('dragover', handleDragOver);
  element.addEventListener('dragleave', handleDragLeave);
  element.addEventListener('drop', handleDrop);

  // Return cleanup function
  return () => {
    element.removeEventListener('dragover', handleDragOver);
    element.removeEventListener('dragleave', handleDragLeave);
    element.removeEventListener('drop', handleDrop);
    element.classList.remove('task-manager-timeline-slot-dragover');
  };
}

/**
 * Setup kanban column as a drop zone for cross-view drops
 * Handles drops from list, calendar, timeline views
 * @returns Cleanup function to remove all event listeners
 */
export function setupKanbanDropZone(
  element: HTMLElement,
  statusName: string,
  onTaskDropped?: (task: ParsedTask | DragTaskData, targetStatus: string) => Promise<void>,
): () => void {
  const handleDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    element.classList.add('task-manager-kanban-column-dragover-external');
  };

  const handleDragLeave = (e: DragEvent): void => {
    if (!hasPointerLeftElement(element, e)) return;
    element.classList.remove('task-manager-kanban-column-dragover-external');
  };

  const handleDrop = (e: DragEvent): void => {
    e.preventDefault();
    element.classList.remove('task-manager-kanban-column-dragover-external');

    if (!e.dataTransfer) return;

    const taskKey = e.dataTransfer.getData('application/task-id') || e.dataTransfer.getData('text/plain');
    if (!taskKey) return;

    // Try to extract full task data from JSON
    let taskData: DragTaskData = { taskKey, taskText: taskKey };
    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (jsonData) {
        const parsed = JSON.parse(jsonData) as unknown;
        if (isDragTaskData(parsed)) {
          taskData = parsed;
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    // Call the drop handler if provided
    if (onTaskDropped) {
      void onTaskDropped(taskData, statusName).catch((err: unknown) => {
        console.error('Error handling kanban drop:', err);
      });
    }
  };

  element.addEventListener('dragover', handleDragOver);
  element.addEventListener('dragleave', handleDragLeave);
  element.addEventListener('drop', handleDrop);

  // Return cleanup function
  return () => {
    element.removeEventListener('dragover', handleDragOver);
    element.removeEventListener('dragleave', handleDragLeave);
    element.removeEventListener('drop', handleDrop);
    element.classList.remove('task-manager-kanban-column-dragover-external');
  };
}

/**
 * Setup heading element as a drop zone for moving tasks between sections
 * Dragging tasks onto a heading moves them to that section
 * @returns Cleanup function to remove all event listeners
 */
export function setupHeadingDropZone(
  element: HTMLElement,
  headingText: string,
  headingLevel: number,
  onTaskDropped?: (task: ParsedTask | DragTaskData, targetHeading: string) => Promise<void>,
): () => void {
  const handleDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    element.classList.add('task-manager-heading-dragover');
  };

  const handleDragLeave = (e: DragEvent): void => {
    if (!hasPointerLeftElement(element, e)) return;
    element.classList.remove('task-manager-heading-dragover');
  };

  const handleDrop = (e: DragEvent): void => {
    e.preventDefault();
    element.classList.remove('task-manager-heading-dragover');

    if (!e.dataTransfer) return;

    const taskKey = e.dataTransfer.getData('application/task-id') || e.dataTransfer.getData('text/plain');
    if (!taskKey) return;

    // Try to extract full task data from JSON
    let taskData: DragTaskData = { taskKey, taskText: taskKey };
    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (jsonData) {
        const parsed = JSON.parse(jsonData) as unknown;
        if (isDragTaskData(parsed)) {
          taskData = parsed;
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    // Call the drop handler if provided
    if (onTaskDropped) {
      void onTaskDropped(taskData, `${headingText} (h${headingLevel})`).catch((err: unknown) => {
        console.error('Error handling heading drop:', err);
      });
    }
  };

  element.addEventListener('dragover', handleDragOver);
  element.addEventListener('dragleave', handleDragLeave);
  element.addEventListener('drop', handleDrop);

  // Return cleanup function
  return () => {
    element.removeEventListener('dragover', handleDragOver);
    element.removeEventListener('dragleave', handleDragLeave);
    element.removeEventListener('drop', handleDrop);
    element.classList.remove('task-manager-heading-dragover');
  };
}

/**
 * Helper to extract task key from drag event
 */
export function extractTaskKeyFromDragEvent(dataTransfer: DataTransfer): string | null {
  return dataTransfer.getData('application/task-id') || dataTransfer.getData('text/plain') || null;
}

/**
 * Helper to extract full task data from drag event
 */
export function extractTaskDataFromDragEvent(dataTransfer: DataTransfer): DragTaskData | null {
  const taskKey = extractTaskKeyFromDragEvent(dataTransfer);
  if (!taskKey) return null;

  let taskData: DragTaskData = { taskKey, taskText: taskKey };
  try {
    const jsonData = dataTransfer.getData('application/json');
    if (jsonData) {
      taskData = JSON.parse(jsonData) as DragTaskData;
    }
  } catch {
    // Ignore JSON parse errors
  }

  return taskData;
}

/**
 * Format date for task metadata update
 * Input: Date object or ISO string like "2026-05-27"
 * Output: YYYY-MM-DD format
 */
export function formatDateForTask(date: Date | string): string {
  if (typeof date === 'string') {
    return date;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Format time block for timeline tasks
 * Returns HH:MM-HH:MM format
 */
export function formatTimeBlock(startTime: string, endTime: string): string {
  return `${startTime}-${endTime}`;
}
