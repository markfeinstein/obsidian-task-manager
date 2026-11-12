import type { ParsedTask } from './task-scanner';

export const BASES_EXPORT_DIR = 'Task Manager Bases';
export const BASES_INDEX_DIR = `${BASES_EXPORT_DIR}/Task Index`;
export const BASES_INDEX_SUMMARY_PATH = `${BASES_EXPORT_DIR}/Task Index.md`;
export const BASES_GENERATED_MARKER = 'task-manager-bases-generated: true';

export interface BasesExportFile {
  path: string;
  content: string;
}

function hasGeneratedBasesFrontmatter(content: string): boolean {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  if (lines[0] !== '---') return false;
  const closing = lines.indexOf('---', 1);
  if (closing < 0) return false;
  const frontmatter = lines.slice(1, closing);
  const ownershipEntries = frontmatter.filter((line) => /^task-manager-bases-(?:generated|task|index)\s*:/u.test(line));
  if (ownershipEntries.some((line) => !/^(?:task-manager-bases-generated|task-manager-bases-task|task-manager-bases-index): true$/u.test(line))) return false;
  const generatedCount = frontmatter.filter((line) => line === BASES_GENERATED_MARKER).length;
  const taskCount = frontmatter.filter((line) => line === 'task-manager-bases-task: true').length;
  const indexCount = frontmatter.filter((line) => line === 'task-manager-bases-index: true').length;
  if (generatedCount > 1 || taskCount > 1 || indexCount > 1 || taskCount + indexCount > 1) return false;
  return generatedCount + taskCount + indexCount > 0;
}

function hasGeneratedBasesViewHeader(content: string): boolean {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const marker = `# ${BASES_GENERATED_MARKER}`;
  const legacy = /^name:\s+\S/u.test(lines[0] ?? '') && lines[1] === marker;
  const current = lines[0] === marker && lines[1] === '# task-manager-bases-schema: 2' && lines[2] === '{';
  return (legacy || current) && lines.filter((line) => line === marker).length === 1;
}

export function isGeneratedBasesFileContent(content: string): boolean {
  return hasGeneratedBasesFrontmatter(content) || hasGeneratedBasesViewHeader(content);
}

/** Exact path/extension plus anchored marker ownership required before cleanup. */
export function isOwnedGeneratedBasesFile(path: string, content: string): boolean {
  if (!path.startsWith(`${BASES_EXPORT_DIR}/`)) return false;
  if (path.endsWith('.md')) return hasGeneratedBasesFrontmatter(content);
  if (path.endsWith('.base')) return hasGeneratedBasesViewHeader(content);
  return false;
}

/** Generation times describe the last material update, not every scan. */
export function equivalentBasesContent(current: string, next: string): boolean {
  const stable = (content: string): string => content.replace(/^---\r?\n([\s\S]*?)\r?\n---/u, (_all, frontmatter: string) => `---\n${frontmatter.split(/\r?\n/u).filter((line) => !/^(?:task_generated|generated): /u.test(line)).join('\n')}\n---`);
  return stable(current) === stable(next);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: readonly string[]): string {
  return `[${values.map((value) => yamlString(value)).join(', ')}]`;
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60) || 'task';
}

export function basesTaskNotePath(task: ParsedTask, index = 0): string {
  const id = task.metadata.id?.trim() || `${task.filePath}-${task.lineNumber}-${index}`;
  return `${BASES_INDEX_DIR}/${slugPart(id)}.md`;
}

export function projectForBasesTask(task: ParsedTask): string {
  const explicit = task.metadata.project?.trim();
  if (explicit) return explicit;
  const projectTag = task.tags.find((tag) => tag.replace(/^#/u, '').startsWith('project/'));
  if (projectTag) return projectTag.replace(/^#?project\//u, '');
  const parts = task.filePath.split('/');
  return parts.length > 1 ? parts[0] : 'Inbox';
}

export function generateBasesTaskNote(task: ParsedTask, generatedAt: string): string {
  const due = task.metadata.dates.due ?? '';
  const scheduled = task.metadata.dates.scheduled ?? '';
  const start = task.metadata.dates.start ?? '';
  const done = task.metadata.dates.done ?? '';
  const happens = due || scheduled || start || '';
  const sourceLink = `obsidian://open?path=${encodeURIComponent(task.filePath)}&line=${task.lineNumber}`;
  return [
    '---',
    BASES_GENERATED_MARKER,
    'task-manager-bases-task: true',
    `task_id: ${yamlString(task.metadata.id ?? task.key)}`,
    `task_content: ${yamlString(task.normalizedText)}`,
    `task_status: ${yamlString(task.status)}`,
    `task_status_symbol: ${yamlString(task.checkbox)}`,
    `task_priority: ${yamlString(task.metadata.priority ?? 'normal')}`,
    `task_due: ${yamlString(due)}`,
    `task_scheduled: ${yamlString(scheduled)}`,
    `task_start: ${yamlString(start)}`,
    `task_done: ${yamlString(done)}`,
    `task_happens: ${yamlString(happens)}`,
    `task_project: ${yamlString(projectForBasesTask(task))}`,
    `task_tags: ${yamlList(task.tags)}`,
    `task_source_file: ${yamlString(task.filePath)}`,
    `task_source_line: ${task.lineNumber}`,
    `task_source_url: ${yamlString(sourceLink)}`,
    `task_generated: ${yamlString(generatedAt)}`,
    '---',
    '',
    `# ${task.normalizedText || 'Task'}`,
    '',
    `Source: [${task.filePath}:${task.lineNumber}](${sourceLink})`,
    '',
    '```task-manager-source',
    task.rawLine,
    '```',
    '',
  ].join('\n');
}

export function generateBasesSummary(tasks: readonly ParsedTask[], generatedAt: string): string {
  return [
    '---',
    BASES_GENERATED_MARKER,
    'task-manager-bases-index: true',
    `task_count: ${tasks.length}`,
    `generated: ${yamlString(generatedAt)}`,
    'tags: [task-index]',
    '---',
    '',
    '# Task Index',
    '',
    '> Generated by Task Manager. Each exported task note in `Task Manager Bases/Task Index/` has YAML/frontmatter properties used by the generated `.base` views.',
    '',
    '| Task | Status | Priority | Due | Project | File |',
    '|------|--------|----------|-----|---------|------|',
    ...tasks.slice(0, 500).map((task) => {
      const desc = task.normalizedText.replace(/\|/gu, '\\|').slice(0, 80);
      const due = task.metadata.dates.due ?? '';
      const fileBase = task.filePath.replace(/\.md$/u, '');
      return `| ${desc} | ${task.status} | ${task.metadata.priority} | ${due} | ${projectForBasesTask(task)} | [[${fileBase}]] |`;
    }),
    '',
  ].join('\n');
}

export function generateBasesViewFiles(): BasesExportFile[] {
  const definitions = [
    { name: 'Today', columns: ['content', 'priority', 'due', 'scheduled', 'project'], filters: ['note.task_status != "done"', 'note.task_status != "cancelled"', 'note.task_happens != ""', 'date(note.task_happens) <= today()'], sort: 'happens' },
    { name: 'Upcoming', columns: ['content', 'happens', 'priority', 'project'], filters: ['note.task_status != "done"', 'note.task_status != "cancelled"', 'note.task_happens != ""', 'date(note.task_happens) > today()'], sort: 'happens' },
    { name: 'Projects', columns: ['content', 'project', 'status', 'priority'], filters: ['note.task_status != "done"', 'note.task_status != "cancelled"'], groupBy: 'project' },
    { name: 'Completed', columns: ['content', 'done', 'project'], filters: ['note.task_status == "done"'], sort: 'done' },
  ];
  return definitions.map((definition) => {
    const config = {
      filters: { and: [`file.folder == ${yamlString(BASES_INDEX_DIR)}`, 'note["task-manager-bases-task"] == true'] },
      properties: Object.fromEntries(definition.columns.map((column) => [`note.task_${column}`, { displayName: column === 'content' ? 'Task' : column.charAt(0).toUpperCase() + column.slice(1) }])),
      views: [{
        type: 'table', name: definition.name,
        filters: { and: definition.filters },
        order: definition.columns.map((column) => `note.task_${column}`),
        ...(definition.sort ? { sort: [{ property: `note.task_${definition.sort}`, direction: definition.name === 'Completed' ? 'DESC' : 'ASC' }] } : {}),
        ...(definition.groupBy ? { groupBy: { property: `note.task_${definition.groupBy}`, direction: 'ASC' } } : {}),
      }],
    };
    // JSON is a strict YAML subset: no ad-hoc quoting or ambiguous YAML scalars.
    return { path: `${BASES_EXPORT_DIR}/${definition.name}.base`, content: `# ${BASES_GENERATED_MARKER}\n# task-manager-bases-schema: 2\n${JSON.stringify(config, null, 2)}\n` };
  });
}

export function generateBasesExportFiles(tasks: readonly ParsedTask[], generatedAt = new Date().toISOString()): BasesExportFile[] {
  const files: BasesExportFile[] = [
    { path: BASES_INDEX_SUMMARY_PATH, content: generateBasesSummary(tasks, generatedAt) },
    ...generateBasesViewFiles(),
  ];
  const taskNotePaths = new Set<string>();
  tasks.slice(0, 1000).forEach((task, index) => {
    const basePath = basesTaskNotePath(task, index);
    let path = basePath;
    let suffix = 2;
    while (taskNotePaths.has(path)) {
      path = basePath.replace(/\.md$/u, `-${suffix}.md`);
      suffix += 1;
    }
    taskNotePaths.add(path);
    files.push({ path, content: generateBasesTaskNote(task, generatedAt) });
  });
  return files;
}
