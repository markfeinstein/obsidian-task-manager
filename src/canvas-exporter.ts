/**
 * Canvas Format Export
 *
 * Export task query results as Obsidian Canvas cards.
 * Canvas format: JSON with nodes (text, file, link) and edges (connections).
 */

import { type App, TFile } from 'obsidian';
import type { ParsedTask } from './task-scanner';

export interface CanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Obsidian Canvas text-node content. */
  text?: string;
  /** Legacy/internal fallback accepted when updating older exported canvases. */
  content?: string;
  file?: string;
  url?: string;
  label?: string;
  color?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide: 'top' | 'bottom' | 'left' | 'right';
  toNode: string;
  toSide: 'top' | 'bottom' | 'left' | 'right';
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/**
 * Priority to color mapping for canvas cards
 */
function getPriorityColor(priority?: string): string | undefined {
  if (!priority) return undefined;
  const colorMap: Record<string, string> = {
    'highest': '#FF6B6B', // Red
    'high': '#FFA06B', // Orange
    'medium': '#FFD93D', // Yellow
    'low': '#6BCB77', // Green
    'lowest': '#4D96FF', // Blue
  };
  return colorMap[priority.toLowerCase()];
}

/**
 * Convert a task to canvas card content
 */
function taskToCardContent(task: ParsedTask): string {
  const parts: string[] = [];

  // Status + description
  const statusIcon = getStatusIcon(task.checkbox);
  parts.push(`${statusIcon} ${task.body}`);

  // Add metadata as separate lines
  if (task.metadata.dates.due) parts.push(`📅 Due: ${task.metadata.dates.due}`);
  const priorityStr = typeof task.metadata.priority === 'string' ? task.metadata.priority : '';
  if (priorityStr) parts.push(`🎯 Priority: ${priorityStr}`);
  if (task.metadata.effort) parts.push(`⏱️ Effort: ${task.metadata.effort}`);
  if (task.tags.length > 0) parts.push(`🏷️ Tags: ${task.tags.join(', ')}`);
  if (task.metadata.id) parts.push(`🔗 ID: ${task.metadata.id}`);

  return parts.join('\n');
}

/**
 * Get status emoji icon for task
 */
function getStatusIcon(checkbox: string): string {
  const iconMap: Record<string, string> = {
    ' ': '☐',
    'x': '☑',
    '/': '◐',
    '-': '✗',
    '!': '⚠',
    '?': '❓',
    '>': '⏭',
  };
  return iconMap[checkbox] || '•';
}

/**
 * Generate canvas layout grid (x, y positioning)
 */
function layoutCanvasNodes(taskCount: number): Array<{ x: number; y: number }> {
  const cols = Math.ceil(Math.sqrt(taskCount));
  const positions: Array<{ x: number; y: number }> = [];

  const xSpacing = 350;
  const ySpacing = 200;

  let idx = 0;
  for (let row = 0; row < Math.ceil(taskCount / cols); row++) {
    for (let col = 0; col < cols && idx < taskCount; col++) {
      positions.push({
        x: col * xSpacing,
        y: row * ySpacing,
      });
      idx++;
    }
  }

  return positions;
}

/**
 * Create a Canvas data structure from task query results
 */
export function tasksToCanvas(tasks: ParsedTask[], title: string = 'Tasks'): CanvasData {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  // Layout positions
  const positions = layoutCanvasNodes(tasks.length + 1);

  // Create title node
  nodes.push({
    id: 'title',
    type: 'text',
    x: positions[0].x,
    y: positions[0].y,
    width: 300,
    height: 100,
    text: `# ${title}\n\n${tasks.length} tasks`,
  });

  // Create task cards
  for (let idx = 0; idx < tasks.length; idx++) {
    const task = tasks[idx];
    const posIdx = idx + 1;
    const position = positions[posIdx] || { x: idx * 350, y: 200 };

    const nodeId = `task-${idx}`;
    const priorityStr = typeof task.metadata.priority === 'string' ? task.metadata.priority : '';
    const color = getPriorityColor(priorityStr);

    nodes.push({
      id: nodeId,
      type: 'text',
      x: position.x,
      y: position.y,
      width: 300,
      height: 150,
      text: taskToCardContent(task),
      color,
    });

    // Link from title to first task
    if (idx === 0) {
      edges.push({
        id: `edge-title-${nodeId}`,
        fromNode: 'title',
        fromSide: 'bottom',
        toNode: nodeId,
        toSide: 'top',
      });
    }

    // Link between consecutive tasks
    if (idx > 0) {
      edges.push({
        id: `edge-${idx - 1}-${idx}`,
        fromNode: `task-${idx - 1}`,
        fromSide: 'right',
        toNode: nodeId,
        toSide: 'left',
      });
    }
  }

  return { nodes, edges };
}

/**
 * Export canvas to JSON string (ready to write to .canvas file)
 */
export function canvasToJSON(canvas: CanvasData): string {
  return JSON.stringify(canvas, null, 2);
}

async function ensureCanvasParentFolders(app: App, filePath: string): Promise<void> {
  const folder = filePath.split('/').slice(0, -1).join('/');
  if (!folder) return;

  let current = '';
  for (const part of folder.split('/').filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (app.vault.getAbstractFileByPath(current)) continue;
    try {
      await app.vault.createFolder(current);
    } catch (error) {
      if (!app.vault.getAbstractFileByPath(current)) {
        throw error;
      }
    }
  }
}

/**
 * Create a new canvas file with task cards
 */
export async function createCanvasFromTasks(
  app: App,
  tasks: ParsedTask[],
  canvasFilePath: string,
  title: string = 'Exported Tasks',
): Promise<TFile> {
  const canvas = tasksToCanvas(tasks, title);
  const json = canvasToJSON(canvas);

  // Ensure file has .canvas extension
  const filename = canvasFilePath.endsWith('.canvas') ? canvasFilePath : `${canvasFilePath}.canvas`;

  // Create or overwrite canvas file
  let file: TFile;
  const existingFile = app.vault.getAbstractFileByPath(filename);

  if (existingFile && existingFile instanceof TFile) {
    // Update existing file
    await app.vault.modify(existingFile, json);
    file = existingFile;
  } else {
    await ensureCanvasParentFolders(app, filename);
    // Create new file
    file = await app.vault.create(filename, json);
  }

  return file;
}

/**
 * Open canvas file in workspace
 */
export async function openCanvasInWorkspace(app: App, file: TFile): Promise<void> {
  const leaf = app.workspace.getLeaf('tab');
  if (leaf) {
    await leaf.openFile(file);
  }
}

/**
 * Export tasks to canvas and open in workspace
 */
export async function exportAndOpenTasksAsCanvas(
  app: App,
  tasks: ParsedTask[],
  canvasFilePath: string,
  title: string = 'Exported Tasks',
): Promise<void> {
  const file = await createCanvasFromTasks(app, tasks, canvasFilePath, title);
  await openCanvasInWorkspace(app, file);
}

/**
 * Update a checkbox task embedded in an Obsidian Canvas text node.
 *
 * `virtualLineNumber` is the 1-based line number emitted by the Canvas scanner as it
 * walks all text-node lines in file order. We keep that convention here so writeback
 * targets the same virtual source that query results reference.
 */
const CANVAS_TASK_CHECKBOX_RE = /^((?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[)[^\]]+(\])/u;

export async function updateCanvasTaskCheckbox(
  app: App,
  filePath: string,
  nodeId: string,
  virtualLineNumber: number,
  newCheckbox: string,
  expectedRawLine?: string,
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) throw new Error(`Canvas file not found: ${filePath}`);
  if (!Number.isInteger(virtualLineNumber) || virtualLineNumber < 1) {
    throw new Error(`Invalid Canvas task line: ${virtualLineNumber}`);
  }

  await app.vault.process(file, (content) => {
    let canvas: CanvasData & { nodes?: Array<CanvasNode & { text?: string }> };
    try {
      canvas = JSON.parse(content) as CanvasData & { nodes?: Array<CanvasNode & { text?: string }> };
    } catch (error) {
      throw new Error(`Invalid Canvas JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!Array.isArray(canvas.nodes)) throw new Error('Invalid Canvas JSON: nodes must be an array');

    let currentVirtualLine = 1;
    for (const node of canvas.nodes) {
      const textValue = typeof node.text === 'string'
        ? node.text
        : typeof node.content === 'string'
        ? node.content
        : null;
      if (node.type !== 'text' || textValue === null) continue;

      const lines = textValue.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        if (String(node.id) === nodeId && currentVirtualLine === virtualLineNumber) {
          if (expectedRawLine && canvasTaskLineIdentity(lines[index]) !== canvasTaskLineIdentity(expectedRawLine)) {
            throw new Error('Canvas task is stale: line no longer matches the rendered task');
          }
          const updatedLine = lines[index].replace(CANVAS_TASK_CHECKBOX_RE, `$1${newCheckbox}$2`);
          if (updatedLine === lines[index]) throw new Error('Canvas line is no longer a checkbox task');
          lines[index] = updatedLine;
          if (typeof node.text === 'string') node.text = lines.join('\n');
          else node.content = lines.join('\n');
          return JSON.stringify(canvas, null, 2);
        }
        currentVirtualLine += 1;
      }
    }

    throw new Error(`Canvas task not found: ${nodeId}:${virtualLineNumber}`);
  });
}

function canvasTaskLineIdentity(line: string): string {
  return line
    .replace(CANVAS_TASK_CHECKBOX_RE, '$1$2')
    .trim();
}
