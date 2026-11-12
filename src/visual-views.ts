import { ItemView, type MarkdownPostProcessorContext, type WorkspaceLeaf } from 'obsidian';
import type { TaskQueryRenderer } from './query-renderer';

export const VIEW_TYPE_TASK_TABLE = 'task-manager-table-view';
export const VIEW_TYPE_TASK_KANBAN = 'task-manager-kanban-view';
export const VIEW_TYPE_TASK_CALENDAR = 'task-manager-calendar-view';

export type VisualTaskViewMode = 'table' | 'kanban' | 'calendar';

const VIEW_LABELS: Record<VisualTaskViewMode, string> = {
  table: 'Task Table',
  kanban: 'Task Kanban',
  calendar: 'Task Calendar',
};

const VIEW_ICONS: Record<VisualTaskViewMode, string> = {
  table: 'table',
  kanban: 'kanban',
  calendar: 'calendar-days',
};

const VIEW_TYPES: Record<VisualTaskViewMode, string> = {
  table: VIEW_TYPE_TASK_TABLE,
  kanban: VIEW_TYPE_TASK_KANBAN,
  calendar: VIEW_TYPE_TASK_CALENDAR,
};

const VISUAL_VIEW_RENDER_CONTEXT: MarkdownPostProcessorContext = {
  docId: 'task-manager-visual-view',
  sourcePath: '',
  frontmatter: undefined,
  addChild: () => {},
  getSectionInfo: () => null,
};

export class VisualTaskView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly mode: VisualTaskViewMode,
    private readonly getRenderer: () => TaskQueryRenderer,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPES[this.mode];
  }

  getDisplayText(): string {
    return VIEW_LABELS[this.mode];
  }

  getIcon(): string {
    return VIEW_ICONS[this.mode];
  }

  async onOpen(): Promise<void> {
    await this.renderView();
  }

  async refresh(): Promise<void> {
    await this.renderView();
  }

  private async renderView(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-manager-visual-view-host');
    const header = contentEl.createDiv({ cls: 'task-manager-visual-view-header' });
    header.createEl('h3', { text: VIEW_LABELS[this.mode] });
    header.createEl('p', { text: 'Global unfinished tasks, sorted by smart priority.', cls: 'task-manager-visual-view-scope' });
    const refresh = header.createEl('button', { text: 'Refresh', cls: 'task-manager-visual-view-refresh' });
    refresh.addEventListener('click', () => { void this.renderView(); });

    const mount = contentEl.createDiv({ cls: 'task-manager-visual-view-content' });
    await this.getRenderer().render(`not done\nview: ${this.mode}\nsort by smart`, mount, VISUAL_VIEW_RENDER_CONTEXT);
  }
}
