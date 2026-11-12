/**
 * Obsidian Kanban Board Format Parser and Generator
 *
 * Parses, generates, imports, and exports Obsidian Kanban-style Markdown boards.
 * Obsidian Kanban is a community plugin that uses a specific YAML/Markdown hybrid format.
 *
 * Formats supported:
 * 1. YAML frontmatter format with kanban-plugin marker
 * 2. Simple Markdown format with ## Column headers and - [ ] task lists
 * 3. Plain markdown task lists with status grouping
 */

import type { MarkdownTask as ParsedTask } from './task-model';
import type { TaskStatus } from './types';

/**
 * Represents a single card/task in a Kanban board
 */
export interface KanbanCard {
  /** Unique identifier for this card */
  id: string;
  /** Task text/title */
  title: string;
  /** Task description/body */
  description?: string;
  /** Checkbox state (space, x, /, !, ?, >, -) */
  status: string;
  /** Metadata from task (priority, due date, etc.) */
  metadata?: Record<string, unknown>;
  /** Original ParsedTask if available */
  sourceTask?: ParsedTask;
}

/**
 * Represents a column in a Kanban board
 */
export interface KanbanColumn {
  /** Column name/title */
  title: string;
  /** Array of cards in this column */
  cards: KanbanCard[];
  /** Optional limit on number of cards (WIP limit) */
  wipLimit?: number;
  /** Column ID for persistence */
  id: string;
}

/**
 * Represents a complete Kanban board
 */
export interface KanbanBoard {
  /** Board title */
  title: string;
  /** Array of columns */
  columns: KanbanColumn[];
  /** Board metadata (creation date, author, etc.) */
  metadata?: Record<string, unknown>;
  /** Optional board description */
  description?: string;
}

/**
 * Parse Obsidian Kanban markdown format into a KanbanBoard object
 *
 * Supports both:
 * - YAML format: `---kanban-plugin: basic---` followed by columns as YAML
 * - Markdown format: `## Column Title` followed by markdown task list
 *
 * @param markdown - Raw markdown content
 * @param boardTitle - Title for the board
 * @returns Parsed KanbanBoard object
 */
export function parseKanbanMarkdown(markdown: string, boardTitle = 'Kanban Board'): KanbanBoard {
  const board: KanbanBoard = {
    title: boardTitle,
    columns: [],
    metadata: {},
  };

  // Check for kanban-plugin marker — match the collapsed single-line form
  // (---kanban-plugin: basic---) OR standard multi-line YAML frontmatter that
  // starts at the very beginning of the file (no `m` flag on the second clause
  // so `^` is anchored to the string start, not to arbitrary line starts).
  const standardFrontmatterMatch = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
  const hasKanbanMarker =
    /^---\s*kanban-plugin:\s*\w+\s*---/u.test(markdown) ||
    Boolean(standardFrontmatterMatch?.[1].match(/(?:^|\r?\n)kanban-plugin\s*:/u));

  if (hasKanbanMarker) {
    // YAML format parsing
    parseYamlKanbanFormat(markdown, board);
  } else {
    // Markdown format parsing (## Column headers)
    parseMarkdownKanbanFormat(markdown, board);
  }

  return board;
}

/**
 * Parse YAML-format Kanban markdown
 */
function parseYamlKanbanFormat(markdown: string, board: KanbanBoard): void {
  // Extract YAML frontmatter. Obsidian Kanban files normally use a standard
  // multi-line frontmatter block, but older fixtures may collapse the marker
  // onto a single line (`---kanban-plugin: basic---`). Keep supporting that
  // form so marker detection and parsing stay in sync.
  const standardFrontmatterMatch = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
  const collapsedFrontmatterMatch = standardFrontmatterMatch
    ? null
    : markdown.match(/^---\s*([^\r\n]*?kanban-plugin:[^\r\n]*?)\s*---\s*(?:\r?\n|$)/iu);
  const frontmatterMatch = standardFrontmatterMatch ?? collapsedFrontmatterMatch;
  if (!frontmatterMatch) return;

  const frontmatter = frontmatterMatch[1];
  const contentAfter = markdown.substring(frontmatterMatch[0].length);

  // Parse metadata from frontmatter
  const metadata = board.metadata ?? (board.metadata = {});
  const metadataLines = frontmatter.split('\n').filter((l) => l.trim());
  for (const line of metadataLines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key && value) {
      metadata[key] = parseKanbanFrontmatterValue(value);
    }
  }

  // Parse columns from content after frontmatter
  parseMarkdownKanbanFormat(contentAfter, board);
}

function parseKanbanFrontmatterValue(value: string): unknown {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value === 'true' ? true : value === 'false' ? false : value;
}

function formatKanbanFrontmatterValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return JSON.stringify(String(value));
}

/**
 * Parse Markdown format Kanban with ## column headers
 */
function parseMarkdownKanbanFormat(markdown: string, board: KanbanBoard): void {
  // Split by column headers (##)
  const sections = markdown.split(/^##\s+/m);

  // First section before any ## is just metadata, skip
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const lines = section.split('\n');
    const columnTitle = lines[0].trim();

    const column: KanbanColumn = {
      title: columnTitle,
      cards: [],
      id: columnTitle.toLowerCase().replace(/\s+/g, '-'),
    };

    // Parse cards from remaining lines
    for (let j = 1; j < lines.length; j++) {
      const line = lines[j].trim();

      // Stop if we hit another column header (shouldn't happen due to split, but be safe)
      if (line.startsWith('#')) break;

      // Parse task lists with single- or multi-character checkbox states.
      if (line.match(/^-\s+\[([^\]]+)\]\s+/)) {
        const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+)$/);
        if (match) {
          const status = match[1];
          const title = match[2];

          const card: KanbanCard = {
            id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            title,
            status,
            description: '',
          };

          column.cards.push(card);
        }
      }
    }

    if (column.cards.length > 0 || columnTitle) {
      board.columns.push(column);
    }
  }
}

/**
 * Generate Obsidian Kanban markdown from a KanbanBoard object
 * Uses simple Markdown format for maximum compatibility
 *
 * @param board - The KanbanBoard to convert
 * @returns Markdown string in Obsidian Kanban format
 */
export interface KanbanCardMoveResult {
  markdown: string;
  moved: boolean;
  reason?: string;
}

interface MarkdownHeading {
  index: number;
  level: number;
  text: string;
}

function rewriteTaskLineCheckbox(line: string, checkbox: string): string {
  return line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)[^\]]+(\]\s+)/u, `$1${checkbox}$2`);
}

function markdownHeadings(lines: readonly string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (!match) return;
    headings.push({ index, level: match[1].length, text: match[2].trim() });
  });
  return headings;
}

function headingParentKey(headings: readonly MarkdownHeading[], index: number, childLevel: number): string {
  for (let i = headings.length - 1; i >= 0; i -= 1) {
    const heading = headings[i];
    if (heading.index >= index || heading.level >= childLevel) continue;
    return `${heading.index}:${heading.level}:${heading.text.toLowerCase()}`;
  }
  return 'root';
}

/**
 * Safely move exactly one markdown task/card line under an existing heading.
 * The helper refuses ambiguous source lines or missing target headings and never
 * creates headings, so callers do not accidentally restructure arbitrary notes.
 */
export function moveKanbanCardLine(
  markdown: string,
  rawTaskLine: string,
  targetHeading: string,
  checkbox: string,
  sourceLineNumber?: number,
): KanbanCardMoveResult {
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/u);
  let sourceIndexes: number[];
  if (typeof sourceLineNumber === 'number' && Number.isInteger(sourceLineNumber) && sourceLineNumber > 0) {
    const sourceIndex = sourceLineNumber - 1;
    sourceIndexes = lines[sourceIndex] === rawTaskLine ? [sourceIndex] : [];
  } else {
    sourceIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line === rawTaskLine)
      .map(({ index }) => index);
  }
  if (sourceIndexes.length !== 1) return { markdown, moved: false, reason: sourceIndexes.length === 0 ? 'source-not-found' : 'ambiguous-source' };

  const sourceIndex = sourceIndexes[0];
  const headingText = targetHeading.trim().toLowerCase();
  const headings = markdownHeadings(lines);
  const targetCandidates = headings.filter((heading) => heading.text.toLowerCase() === headingText);
  if (targetCandidates.length === 0) return { markdown, moved: false, reason: 'target-heading-not-found' };

  const sameSectionCandidates = targetCandidates.filter((heading) => (
    headingParentKey(headings, heading.index, heading.level) === headingParentKey(headings, sourceIndex, heading.level)
  ));
  if (sameSectionCandidates.length !== 1) {
    return { markdown, moved: false, reason: sameSectionCandidates.length === 0 ? 'target-heading-not-found-in-section' : 'ambiguous-target-heading' };
  }

  const updatedLine = rewriteTaskLineCheckbox(rawTaskLine, checkbox);
  const withoutSource = [...lines.slice(0, sourceIndex), ...lines.slice(sourceIndex + 1)];
  const targetIndex = sameSectionCandidates[0].index > sourceIndex ? sameSectionCandidates[0].index - 1 : sameSectionCandidates[0].index;

  let insertIndex = targetIndex + 1;
  while (insertIndex < withoutSource.length && withoutSource[insertIndex].trim() === '') insertIndex += 1;
  withoutSource.splice(insertIndex, 0, updatedLine);
  return { markdown: withoutSource.join(newline), moved: true };
}

export function generateKanbanMarkdown(board: KanbanBoard): string {
  let markdown = '';

  // Frontmatter MUST be the very first content in the file — Obsidian (and every
  // standard YAML-frontmatter parser) ignores a "---" block that is preceded by
  // any other content such as a heading.  Placing the title first broke the
  // round-trip: generated files with metadata were never re-parsed via the YAML
  // path, and Obsidian would not recognise the kanban-plugin marker.
  if (board.metadata && Object.keys(board.metadata).length > 0) {
    markdown += '---\n';
    markdown += 'kanban-plugin: basic\n';
    for (const [key, value] of Object.entries(board.metadata)) {
      // Skip kanban-plugin — it is already written above as the required marker.
      // Without this guard, a board round-tripped through parseKanbanMarkdown →
      // generateKanbanMarkdown emits the key twice, producing invalid YAML.
      if (key === 'kanban-plugin') continue;
      markdown += `${key}: ${formatKanbanFrontmatterValue(value)}\n`;
    }
    markdown += '---\n\n';
  }

  markdown += `# ${board.title}\n\n`;

  if (board.description) {
    markdown += `${board.description}\n\n`;
  }

  // Generate columns and cards
  for (const column of board.columns) {
    markdown += `## ${column.title}\n\n`;

    if (column.wipLimit) {
      markdown += `<!-- WIP Limit: ${column.wipLimit} -->\n\n`;
    }

    for (const card of column.cards) {
      markdown += `- [${card.status}] ${card.title}\n`;
      if (card.description) {
        const descLines = card.description.split('\n');
        for (const descLine of descLines) {
          markdown += `  ${descLine}\n`;
        }
      }
    }

    markdown += '\n';
  }

  return markdown;
}

/**
 * Import tasks from a Kanban board representation
 * Converts KanbanCards back to a format compatible with ParsedTask-like objects
 *
 * @param kanbanBoard - The KanbanBoard to import
 * @param filePath - Optional file path for sourcing
 * @returns Array of task-like objects
 */
export function importKanbanBoard(kanbanBoard: KanbanBoard, filePath = 'kanban-import.md'): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let lineNumber = 1;

  for (const column of kanbanBoard.columns) {
    // Use column as heading
    lineNumber++;

    for (const card of column.cards) {
      const task: Partial<ParsedTask> & { [key: string]: unknown } = {
        key: card.id,
        filePath,
        lineNumber,
        checkbox: card.status,
        normalizedText: card.title,
        body: card.title,
        rawLine: `- [${card.status}] ${card.title}`,
        heading: column.title,
        status: statusFromCheckbox(card.status),
        tags: [],
        metadata: {
          dates: {},
          invalidDates: {},
          priority: 'normal',
          effort: undefined,
          actual: undefined,
          cost: undefined,
          id: card.id,
          reminder: undefined,
          recurrence: undefined,
          pinned: false,
          dependsOn: [],
          onCompletion: undefined,
          followUp: undefined,
        },
      };

      tasks.push(task as ParsedTask);
      lineNumber++;
    }
  }

  return tasks;
}

/**
 * Export tasks as Obsidian Kanban markdown
 *
 * @param tasks - Array of ParsedTask objects to export
 * @param groupBy - Field to group tasks by (default: status)
 * @returns Markdown string in Kanban format
 */
export function exportTasksAsKanban(
  tasks: ParsedTask[],
  groupBy: 'status' | 'priority' | 'heading' = 'status',
): string {
  // Group tasks by specified field
  const grouped = new Map<string, ParsedTask[]>();

  for (const task of tasks) {
    let groupKey = '';

    if (groupBy === 'status') {
      const stateName = task.status || 'todo';
      groupKey = capitalizeFirst(stateName);
    } else if (groupBy === 'priority') {
      const priority = task.metadata?.priority || 'no priority';
      groupKey = String(priority);
    } else if (groupBy === 'heading') {
      groupKey = task.heading || 'Ungrouped';
    }

    let groupTasks = grouped.get(groupKey);
    if (!groupTasks) {
      groupTasks = [];
      grouped.set(groupKey, groupTasks);
    }
    groupTasks.push(task);
  }

  // Create board from grouped tasks
  const board: KanbanBoard = {
    title: 'Exported Task Board',
    columns: Array.from(grouped.entries()).map(([groupKey, groupTasks]) => ({
      title: groupKey,
      id: groupKey.toLowerCase().replace(/\s+/g, '-'),
      cards: groupTasks.map((task) => ({
        id: task.metadata?.id ? String(task.metadata.id) : task.key,
        title: task.body,
        description: task.metadata?.effort ? `Effort: ${task.metadata.effort}` : undefined,
        status: task.checkbox,
        sourceTask: task,
      })),
    })),
  };

  return generateKanbanMarkdown(board);
}

/**
 * Convert checkbox state to task status string
 */
function statusFromCheckbox(checkbox: string): TaskStatus {
  const statusMap: Record<string, TaskStatus> = {
    ' ': 'todo',
    'x': 'done',
    'X': 'done',
    '/': 'in_progress',
    '!': 'blocked',
    '?': 'deferred',
    '>': 'deferred',
    '-': 'cancelled',
  };
  return statusMap[checkbox] || 'todo';
}

/**
 * Capitalize first letter of string
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Validate Kanban board structure
 */
export function validateKanbanBoard(board: KanbanBoard): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!board.title) errors.push('Board must have a title');
  if (!Array.isArray(board.columns)) errors.push('Board must have a columns array');
  if (board.columns.length === 0) errors.push('Board must have at least one column');

  for (const column of board.columns) {
    if (!column.title) errors.push('Each column must have a title');
    if (!column.id) errors.push('Each column must have an id');
    if (!Array.isArray(column.cards)) errors.push(`Column ${column.title} must have a cards array`);

    for (const card of column.cards) {
      if (!card.id) errors.push(`Card in column ${column.title} must have an id`);
      if (!card.title) errors.push(`Card in column ${column.title} must have a title`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
