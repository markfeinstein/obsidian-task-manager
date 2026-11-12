/**
 * Progress bar decorator for parent tasks
 * Renders inline progress indicators (e.g. [████░░] 4/8) on parent task lines
 * Implemented via CodeMirror ViewPlugin and post-processor decorations
 */

import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate, Decoration, WidgetType } from '@codemirror/view';
import type { ParsedTask } from './task-scanner';
import type { TaskManagerSettings } from './types';

export interface ParentTaskProgress {
  lineNumber: number; // 1-based
  completed: number;
  total: number;
  filePath: string;
}

/**
 * Calculate progress for all parent tasks in a file
 */
export function calculateProgressForFile(
  filePath: string,
  allTasks: ParsedTask[],
  _getSettings: () => TaskManagerSettings,
): Map<string, ParentTaskProgress> {
  const progress = new Map<string, ParentTaskProgress>();

  // Filter tasks for this file and normalize order by source line.
  // Callers may pass a user-sorted task list (priority/due/etc.); parent-child
  // detection must still follow document structure, not the incoming array order.
  const fileTasks = allTasks
    .filter((t) => t.filePath === filePath)
    .sort((a, b) => a.lineNumber - b.lineNumber);
  if (fileTasks.length === 0) return progress;

  // For each task, check if it's a parent by looking for children
  for (let taskIndex = 0; taskIndex < fileTasks.length; taskIndex++) {
    const task = fileTasks[taskIndex];
    const parentIndent = task.indentation.length;
    let completed = 0;
    let total = 0;

    // Find all children (next lines with greater indentation until we hit same or lower indent).
    // Determine the direct-child indentation level from the first child encountered, so that
    // any indentation size (2-space, 4-space, tab, etc.) is handled correctly.
    let directChildIndent = -1;
    for (let i = taskIndex + 1; i < fileTasks.length; i++) {
      const childTask = fileTasks[i];
      const childIndent = childTask.indentation.length;

      // Stop if we reach a task at same or lower indentation level (no longer a child)
      if (childIndent <= parentIndent) break;

      // The first descendant determines the direct-child indentation level.
      if (directChildIndent === -1) directChildIndent = childIndent;

      // Only count direct children (tasks at the first child's indentation level)
      if (childIndent === directChildIndent) {
        total++;
        if (childTask.status === 'done' || childTask.status === 'cancelled') {
          completed++;
        }
      }
    }

    // Only add progress for tasks with children
    if (total > 0) {
      const key = `${filePath}:${task.lineNumber}`;
      progress.set(key, {
        lineNumber: task.lineNumber,
        completed,
        total,
        filePath,
      });
    }
  }

  return progress;
}

/**
 * Render progress bar HTML element
 */
export function renderProgressBar(completed: number, total: number): HTMLElement {
  const bar = document.createElement('span');
  bar.className = 'task-manager-progress-bar';
  bar.setAttribute('aria-label', `${completed} of ${total} subtasks completed`);

  const barWidth = 10;
  const filledWidth = Math.round((completed / total) * barWidth);
  const emptyWidth = barWidth - filledWidth;

  const barText = `[${String('█').repeat(filledWidth)}${String('░').repeat(emptyWidth)}] ${completed}/${total}`;
  bar.textContent = barText;
  bar.style.fontSize = '0.85em';
  bar.style.opacity = '0.7';
  bar.style.marginLeft = '4px';
  bar.style.fontFamily = 'monospace';
  bar.style.fontFeatureSettings = '"tnum" 1'; // Tabular numbers for alignment

  return bar;
}

/**
 * Get CSS for progress bar styling
 */
export function getProgressBarStyles(): string {
  return `
.task-manager-progress-bar {
  display: inline-block;
  font-size: 0.85em;
  opacity: 0.7;
  margin-left: 4px;
  font-family: monospace;
  font-feature-settings: "tnum" 1;
  color: var(--text-muted);
}

.task-manager-progress-bar-container {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
`;
}

/**
 * Widget for rendering a progress bar inline
 */
class ProgressBarWidget extends WidgetType {
  constructor(
    private completed: number,
    private total: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'task-manager-progress-bar';
    span.setAttribute('role', 'img');
    span.setAttribute(
      'aria-label',
      `${this.completed} of ${this.total} subtasks completed`,
    );

    const barWidth = 10;
    const filledWidth = Math.round((this.completed / this.total) * barWidth);
    const emptyWidth = barWidth - filledWidth;

    const barText = `[${String('█').repeat(filledWidth)}${String('░').repeat(emptyWidth)}] ${this.completed}/${this.total}`;
    span.textContent = barText;

    span.style.fontSize = '0.85em';
    span.style.opacity = '0.7';
    span.style.marginLeft = '4px';
    span.style.fontFamily = 'monospace';
    span.style.fontFeatureSettings = '"tnum" 1';
    span.style.color = 'var(--text-muted)';

    return span;
  }

  // Required WidgetType methods
  eq(other: WidgetType): boolean {
    return other instanceof ProgressBarWidget
      && other.completed === this.completed
      && other.total === this.total;
  }

  updateDOM(dom: HTMLElement): boolean {
    const barWidth = 10;
    const filledWidth = Math.round((this.completed / this.total) * barWidth);
    const emptyWidth = barWidth - filledWidth;
    const barText = `[${String('█').repeat(filledWidth)}${String('░').repeat(emptyWidth)}] ${this.completed}/${this.total}`;
    dom.textContent = barText;
    dom.setAttribute('aria-label', `${this.completed} of ${this.total} subtasks completed`);
    return true;
  }

  destroy(): void {
    // Cleanup if needed
  }

  get estimatedHeight(): number {
    return -1;
  }

  get lineBreaks(): number {
    return 0;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * CodeMirror ViewPlugin for inline progress bars
 * Renders progress indicators on parent task lines in the editor
 */
class ProgressBarPlugin implements PluginValue {
  decorations: ReturnType<typeof Decoration.set>;

  constructor(
    private view: EditorView,
    private filePath: string,
    private settings: TaskManagerSettings,
  ) {
    this.decorations = this.buildDecorations();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations();
    }
  }

  private buildDecorations() {
    if (!this.settings.inlineProgressBarsEnabled) {
      return Decoration.set([]);
    }

    try {
      // Get the document content
      const content = this.view.state.doc.toString();
      const lines = content.split('\n');

      // Parse tasks from the document
      const tasks = this.extractTasksFromLines(lines, this.filePath);

      // Calculate progress for parent tasks
      const progress = this.calculateProgress(tasks);

      // Build decorations - use builder pattern for proper type safety
      const ranges: Array<{ from: number; to: number; value: Decoration }> = [];
      let lineStart = 0;

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const lineEnd = lineStart + line.length;
        const lineNumber = lineNum + 1; // 1-based

        // Check if this line has progress to display
        const key = `${this.filePath}:${lineNumber}`;
        const progressData = progress.get(key);

        if (progressData) {
          // Find the end of the task text (before any metadata)
          const taskMatch = line.match(/^(\s*[-*]\s*\[(?!\[)[^\]]*\]\s+[^\n]*)/);
          if (taskMatch) {
            const taskTextEnd = lineStart + taskMatch[1].length;

            // Create a widget decoration for the progress bar
            const widget = new ProgressBarWidget(progressData.completed, progressData.total);
            const decoration = Decoration.widget({
              widget,
              side: 1, // Place after the matched text
            });

            ranges.push({
              from: taskTextEnd,
              to: taskTextEnd,
              value: decoration,
            });
          }
        }

        lineStart = lineEnd + 1; // +1 for newline
      }

      // Create the final decoration set from ranges
      return Decoration.set(
        ranges.map((r) => r.value.range(r.from, r.to)),
        true,
      );
    } catch {
      // Silently fail to avoid breaking the editor
      return Decoration.set([]);
    }
  }

  private extractTasksFromLines(
    lines: string[],
    _filePath: string,
  ): Array<{ lineNumber: number; indentation: string; status: string }> {
    const tasks: Array<{ lineNumber: number; indentation: string; status: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // The leading `(?!\[)` guard skips wikilink list items like `- [[Note#L5]] text` (a `[[wikilink]]`,
      // not a checkbox). The trailing `(?!\()` guard skips markdown-link list items like
      // `- [Label](https://…)` (where `]` is immediately followed by `(`) while still counting real
      // checkboxes, including multi-char markers.
      const taskMatch = line.match(/^(\s*)[-*]\s*\[(?!\[)([^\]]*)\](?!\()/u);

      if (taskMatch) {
        const indentation = taskMatch[1];
        const checkboxChar = taskMatch[2];
        // Mirror the logic in calculateProgressForFile: 'x'/'X' → done,
        // '-' → cancelled, space/empty → todo, everything else → in_progress.
        // Only done and cancelled should count as "completed" for progress.
        const status = (checkboxChar === 'x' || checkboxChar === 'X')
          ? 'done'
          : (checkboxChar === '-')
            ? 'cancelled'
            : (checkboxChar === ' ' || checkboxChar === '')
              ? 'todo'
              : 'in_progress';

        tasks.push({
          lineNumber: i + 1,
          indentation,
          status,
        });
      }
    }

    return tasks;
  }

  private calculateProgress(
    tasks: Array<{ lineNumber: number; indentation: string; status: string }>,
  ): Map<string, ParentTaskProgress> {
    const progress = new Map<string, ParentTaskProgress>();

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const parentIndent = task.indentation.length;
      let completed = 0;
      let total = 0;

      // Find all children (next lines with greater indentation).
      // Determine the direct-child indentation level from the first child encountered.
      let directChildIndent = -1;
      for (let j = i + 1; j < tasks.length; j++) {
        const childTask = tasks[j];
        const childIndent = childTask.indentation.length;

        // Stop if we reach a task at same or lower indentation
        if (childIndent <= parentIndent) break;

        if (directChildIndent === -1) directChildIndent = childIndent;

        // Only count direct children
        if (childIndent === directChildIndent) {
          total++;
          if (childTask.status === 'done' || childTask.status === 'cancelled') {
            completed++;
          }
        }
      }

      if (total > 0) {
        const key = `${this.filePath}:${task.lineNumber}`;
        progress.set(key, {
          lineNumber: task.lineNumber,
          completed,
          total,
          filePath: this.filePath,
        });
      }
    }

    return progress;
  }
}

/**
 * Create a ViewPlugin for progress bars
 */
export function createProgressBarViewPlugin(
  filePath: string,
  settings: TaskManagerSettings,
): ReturnType<typeof ViewPlugin.define> {
  return ViewPlugin.define(
    (view: EditorView) => new ProgressBarPlugin(view, filePath, settings),
    {
      decorations: (instance) => instance.decorations,
    },
  );
}
