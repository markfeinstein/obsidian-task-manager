/**
 * Project Workspace/Database Mode
 *
 * Lightweight project workspace system that combines:
 * - Saved task queries
 * - Project notes and frontmatter
 * - Templates
 * - Generated views (without mutating original notes)
 *
 * A workspace is a special markdown file that references queries, templates,
 * and notes, but does not modify them. Views are generated dynamically.
 */

import type { ParsedTask } from './task-scanner';
import { generateKanbanMarkdown } from './kanban-board';

export const PROJECT_WORKSPACE_FRONTMATTER_KEY = 'task-manager-workspace';
export const GENERATED_VIEWS_START_MARKER = '<!-- task-manager-generated-views:start -->';
export const GENERATED_VIEWS_END_MARKER = '<!-- task-manager-generated-views:end -->';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function uniqueSlugForName(name: string, usedIds: Set<string>): string {
  const baseId = name.toLowerCase().replace(/\s+/gu, '-');
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

/**
 * Project metadata stored in frontmatter
 */
export interface ProjectFrontmatter {
  /** Project name */
  name: string;
  /** Project description */
  description?: string;
  /** Project owner/creator */
  owner?: string;
  /** Creation date */
  created?: string;
  /** Last modified date */
  modified?: string;
  /** Tags for organizing projects */
  tags?: string[];
  /** Marker identifying notes that are safe for workspace refresh. */
  taskManagerWorkspace?: boolean;
  /** Custom metadata */
  [key: string]: unknown;
}

/**
 * Template for generating workspace views
 */
export interface WorkspaceTemplate {
  /** Template name */
  name: string;
  /** Template ID */
  id: string;
  /** Template description */
  description?: string;
  /** Template content/format */
  content: string;
  /** Type of template */
  type: 'kanban' | 'list' | 'table' | 'timeline' | 'calendar' | 'custom';
}

/**
 * A saved reference to a query or view
 */
export interface WorkspaceQuery {
  /** Query name */
  name: string;
  /** Query ID */
  id: string;
  /** The actual query string */
  query: string;
  /** Auto-refresh interval in minutes (0 = manual) */
  refreshInterval?: number;
}

/**
 * A project workspace combining queries, notes, and templates
 */
export interface ProjectWorkspace {
  /** Workspace metadata */
  metadata: ProjectFrontmatter;
  /** Queries to include in workspace */
  queries: WorkspaceQuery[];
  /** Templates for generating views */
  templates: WorkspaceTemplate[];
  /** Project notes content */
  notes?: string;
  /** Generated views (not persisted, created on demand) */
  generatedViews?: Map<string, string>;
  /** Linked file paths (referenced but not modified) */
  linkedFiles?: string[];
}

/**
 * Generate a default workspace template with common sections
 */
export function createDefaultWorkspace(projectName: string): ProjectWorkspace {
  const now = localDateString();

  return {
    metadata: {
      name: projectName,
      description: `Project workspace for ${projectName}`,
      created: now,
      modified: now,
      tags: ['project', 'workspace'],
      taskManagerWorkspace: true,
    },
    queries: [
      {
        name: 'Active Tasks',
        id: 'active-tasks',
        query: '(status.type is TODO) OR (status.type is IN_PROGRESS)',
      },
      {
        name: 'High Priority',
        id: 'high-priority',
        query: '(status.type is TODO) AND (priority is highest)',
      },
      {
        name: 'This Week',
        id: 'this-week',
        query: 'due this week',
      },
    ],
    templates: [
      {
        name: 'Daily Standup',
        id: 'daily-standup',
        description: 'Template for daily standup report',
        type: 'list',
        content: `# Daily Standup - {{date}}

## Completed Yesterday
<!-- Generated from query: (status.type is DONE) AND (done yesterday) -->

## In Progress
<!-- Generated from query: status.type is IN_PROGRESS -->

## Blocked
<!-- Generated from query: status.type is BLOCKED -->

## Today's Plan
<!-- Manually added tasks -->
`,
      },
      {
        name: 'Sprint Board',
        id: 'sprint-board',
        description: 'Kanban-style sprint board',
        type: 'kanban',
        content: `# Sprint Board

## Backlog
<!-- Generated from query: (status.type is TODO) AND (priority is lowest) -->

## In Progress
<!-- Generated from query: status.type is IN_PROGRESS -->

## Done
<!-- Generated from query: (status.type is DONE) AND (done this week) -->
`,
      },
      {
        name: 'Weekly Report',
        id: 'weekly-report',
        description: 'Weekly project summary',
        type: 'list',
        content: `# Weekly Report - Week {{week}}

## Overview
- Tasks completed: {{count-done}}
- Tasks in progress: {{count-in-progress}}
- Blocked issues: {{count-blocked}}

## Completed Tasks
<!-- Generated from query: (status.type is DONE) AND (done this week) -->

## Next Week Priorities
<!-- Generated from query: (status.type is TODO) AND (priority is highest) -->

## Risks/Issues
<!-- Manual entry for blockers -->
`,
      },
    ],
    notes: '',
    linkedFiles: [],
  };
}

/**
 * Parse workspace from markdown file content
 */
export function parseWorkspaceMarkdown(markdown: string): ProjectWorkspace {
  // Extract frontmatter
  const frontmatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  const metadata: ProjectFrontmatter = {
    name: 'Untitled Workspace',
  };

  if (frontmatterMatch) {
    const frontmatterLines = frontmatterMatch[1].split(/\r?\n/u);
    for (const line of frontmatterLines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) {
        if (key === 'tags') {
          metadata.tags = value.split(',').map((t) => t.trim());
        } else if (key === PROJECT_WORKSPACE_FRONTMATTER_KEY) {
          metadata.taskManagerWorkspace = /^(true|yes|1)$/iu.test(value);
        } else {
          (metadata as Record<string, unknown>)[key] = value;
        }
      }
    }
  }

  const workspace: ProjectWorkspace = {
    metadata,
    queries: [],
    templates: [],
    notes: '',
    linkedFiles: [],
  };

  // Parse queries section
  const queriesMatch = markdown.match(/(?:^|\r?\n)## Queries?\r?\n([\s\S]*?)(?=\r?\n##(?!#)|$)/u);
  if (queriesMatch) {
    const queriesContent = queriesMatch[1];
    const queryBlocks = queriesContent.match(/(?:^|\r?\n)###.*?\r?\n([\s\S]*?)(?=\r?\n###|\r?\n##(?!#)|$)/gu) || [];
    const usedQueryIds = new Set<string>();

    for (const block of queryBlocks) {
      const titleMatch = block.match(/### (.*)\r?\n/u);
      const queryMatch = block.match(/query:\s*`(.*?)`/);

      if (titleMatch && queryMatch) {
        const name = titleMatch[1].trim();
        workspace.queries.push({
          name,
          id: uniqueSlugForName(name, usedQueryIds),
          query: queryMatch[1],
        });
      }
    }
  }

  // Parse templates section
  const templatesMatch = markdown.match(/(?:^|\r?\n)## Templates?\r?\n([\s\S]*?)(?=\r?\n##(?!#)|$)/u);
  if (templatesMatch) {
    const templatesContent = templatesMatch[1];
    const templateBlocks = templatesContent.match(/(?:^|\r?\n)###.*?\r?\n([\s\S]*?)(?=\r?\n###|\r?\n##(?!#)|$)/gu) || [];
    const usedTemplateIds = new Set<string>();

    for (const block of templateBlocks) {
      const titleMatch = block.match(/### (.*)\r?\n/u);
      const typeMatch = block.match(/type:\s*(\w+)/);
      const descMatch = block.match(/description:\s*(.*)\r?\n/u);

      if (titleMatch) {
        const name = titleMatch[1].trim();
        // Remove structural headers and fields from the block to isolate user template content
        const lines = block.split(/\r?\n/u);
        const filteredLines = lines.filter((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('###')) return false;
          if (trimmed.startsWith('type:')) return false;
          if (trimmed.startsWith('description:')) return false;
          return true;
        });
        const content = filteredLines.join('\n').trim();

        workspace.templates.push({
          name,
          id: uniqueSlugForName(name, usedTemplateIds),
          type: (typeMatch ? typeMatch[1] : 'custom') as WorkspaceTemplate['type'],
          description: descMatch ? descMatch[1].trim() : undefined,
          content,
        });
      }
    }
  }

  // Extract notes section content when present; otherwise fall back to any
  // remaining trailing content after the last structured section.
  const notesMatch = markdown.match(/(?:^|\r?\n)## Notes\r?\n([\s\S]*?)(?=\r?\n##(?!#)|$)/u);
  if (notesMatch) {
    workspace.notes = notesMatch[1].trim();
  } else {
    const notesStart = Math.max(
      frontmatterMatch ? frontmatterMatch[0].length : 0,
      queriesMatch ? (queriesMatch.index ?? 0) + queriesMatch[0].length : 0,
      templatesMatch ? (templatesMatch.index ?? 0) + templatesMatch[0].length : 0,
    );
    workspace.notes = markdown.substring(notesStart).trim();
  }

  return workspace;
}

/**
 * Generate markdown from workspace
 * Does not mutate original notes or queries
 */
export function generateWorkspaceMarkdown(workspace: ProjectWorkspace): string {
  let markdown = '---\n';

  // Write frontmatter
  markdown += `${PROJECT_WORKSPACE_FRONTMATTER_KEY}: true\n`;
  markdown += `name: ${workspace.metadata.name}\n`;
  if (workspace.metadata.description) {
    markdown += `description: ${workspace.metadata.description}\n`;
  }
  if (workspace.metadata.owner) {
    markdown += `owner: ${workspace.metadata.owner}\n`;
  }
  if (workspace.metadata.created) {
    markdown += `created: ${workspace.metadata.created}\n`;
  }
  if (workspace.metadata.modified) {
    markdown += `modified: ${workspace.metadata.modified}\n`;
  }
  if (workspace.metadata.tags && workspace.metadata.tags.length > 0) {
    markdown += `tags: ${workspace.metadata.tags.join(', ')}\n`;
  }

  markdown += '---\n\n';

  // Write queries
  if (workspace.queries.length > 0) {
    markdown += '## Queries\n\n';
    for (const query of workspace.queries) {
      markdown += `### ${query.name}\n\n`;
      markdown += `query: \`${query.query}\`\n`;
      if (query.refreshInterval) {
        markdown += `refreshInterval: ${query.refreshInterval}\n`;
      }
      markdown += '\n';
    }
  }

  // Write templates
  if (workspace.templates.length > 0) {
    markdown += '## Templates\n\n';
    for (const template of workspace.templates) {
      markdown += `### ${template.name}\n\n`;
      markdown += `type: ${template.type}\n`;
      if (template.description) {
        markdown += `description: ${template.description}\n`;
      }
      markdown += `\n${template.content}\n\n`;
    }
  }

  // Write notes
  if (workspace.notes) {
    markdown += '## Notes\n\n';
    markdown += workspace.notes;
  }

  return markdown;
}

/**
 * Generate views from workspace queries and templates
 * Returns a map of view names to generated markdown
 */
export function generateWorkspaceViews(
  workspace: ProjectWorkspace,
  tasks: ParsedTask[],
  evaluateQuery: (query: string, tasks: ParsedTask[]) => ParsedTask[],
): Map<string, string> {
  const views = new Map<string, string>();

  for (const query of workspace.queries) {
    const queryResults = evaluateQuery(query.query, tasks);
    let viewMarkdown = `# ${query.name}\n\n`;

    // Format results as simple list
    viewMarkdown += `Generated from: \`${query.query}\`\n\n`;
    for (const task of queryResults) {
      viewMarkdown += `- [${task.checkbox}] ${task.body}\n`;
    }

    views.set(query.id, viewMarkdown);
  }

  return views;
}

/**
 * Create a Kanban board view from workspace queries
 */
export function generateKanbanBoardFromWorkspace(
  workspace: ProjectWorkspace,
  tasks: ParsedTask[],
  evaluateQuery: (query: string, tasks: ParsedTask[]) => ParsedTask[],
): string {
  const kanbanTemplate = workspace.templates.find((t) => t.type === 'kanban');
  if (!kanbanTemplate) {
    return '';
  }

  // Parse queries from template comments
  const queryMatches = kanbanTemplate.content.match(/query:\s*`(.*?)`/g) || [];
  const columns = [];

  for (const match of queryMatches) {
    const queryMatch = match.match(/`(.*?)`/);
    if (queryMatch) {
      const query = queryMatch[1];
      const results = evaluateQuery(query, tasks);
      columns.push(results);
    }
  }

  return generateKanbanMarkdown({
    title: workspace.metadata.name,
    description: workspace.metadata.description || '',
    columns: columns.map((col, idx) => ({
      title: `Column ${idx + 1}`,
      id: `col-${idx}`,
      cards: col.map((task) => ({
        id: task.key,
        title: task.body,
        status: task.checkbox,
      })),
    })),
  });
}

/**
 * Update workspace metadata
 */
export function updateWorkspaceMetadata(
  workspace: ProjectWorkspace,
  updates: Partial<ProjectFrontmatter>,
): ProjectWorkspace {
  return {
    ...workspace,
    metadata: {
      ...workspace.metadata,
      ...updates,
      modified: localDateString(),
    },
  };
}

/**
 * Add a query to the workspace
 */
export function addWorkspaceQuery(workspace: ProjectWorkspace, query: WorkspaceQuery): ProjectWorkspace {
  return {
    ...workspace,
    queries: [...workspace.queries, query],
  };
}

/**
 * Add a template to the workspace
 */
export function addWorkspaceTemplate(workspace: ProjectWorkspace, template: WorkspaceTemplate): ProjectWorkspace {
  return {
    ...workspace,
    templates: [...workspace.templates, template],
  };
}

/**
 * Link an external file to the workspace
 * The workspace references it but does not modify it
 */
export function linkFileToWorkspace(workspace: ProjectWorkspace, filePath: string): ProjectWorkspace {
  return {
    ...workspace,
    linkedFiles: [...(workspace.linkedFiles || []), filePath],
  };
}

export interface WorkspaceRefreshResult {
  markdown: string;
  viewCount: number;
  generatedAtIso: string;
}

export function isProjectWorkspaceMarkdown(markdown: string): boolean {
  if (markdown.includes(GENERATED_VIEWS_START_MARKER) && markdown.includes(GENERATED_VIEWS_END_MARKER)) return true;
  const workspaceMarker = new RegExp(String.raw`^${PROJECT_WORKSPACE_FRONTMATTER_KEY}:\s*(?:true|yes|1)\s*$`, 'imu');
  if (workspaceMarker.test(markdown)) return true;

  // Legacy workspaces generated before the explicit marker had project/workspace
  // frontmatter plus a Queries section with query references.
  const hasWorkspaceTag = /^tags:\s*.*\bworkspace\b.*$/imu.test(markdown);
  const hasProjectDescription = /^description:\s*Project workspace\b.*$/imu.test(markdown);
  const hasQuerySection = /(?:^|\r?\n)## Queries?\r?\n[\s\S]*?query:\s*`[^`]+`/u.test(markdown);
  return hasQuerySection && (hasWorkspaceTag || hasProjectDescription);
}

export function renderWorkspaceGeneratedViewsSection(views: Map<string, string>, generatedAtIso: string): string {
  const parts: string[] = [
    GENERATED_VIEWS_START_MARKER,
    '## Generated Views',
    '',
    `Generated: ${generatedAtIso}`,
    '',
  ];
  for (const [id, markdown] of views.entries()) {
    parts.push(`### ${id}`, '', markdown.trim(), '');
  }
  parts.push(GENERATED_VIEWS_END_MARKER);
  return parts.join('\n');
}

export function refreshWorkspaceMarkdown(
  markdown: string,
  tasks: ParsedTask[],
  evaluateQuery: (query: string, tasks: ParsedTask[]) => ParsedTask[],
  generatedAtIso = new Date().toISOString(),
): WorkspaceRefreshResult {
  if (!isProjectWorkspaceMarkdown(markdown)) {
    return { markdown, viewCount: 0, generatedAtIso };
  }
  const workspace = parseWorkspaceMarkdown(markdown);
  const views = generateWorkspaceViews(workspace, tasks, evaluateQuery);
  const generatedSection = renderWorkspaceGeneratedViewsSection(views, generatedAtIso);
  const generatedPattern = new RegExp(String.raw`\n?${escapeRegExp(GENERATED_VIEWS_START_MARKER)}[\s\S]*?${escapeRegExp(GENERATED_VIEWS_END_MARKER)}`, 'u');
  const baseMarkdown = generatedPattern.test(markdown)
    ? markdown.replace(generatedPattern, `\n\n${generatedSection}`)
    : `${markdown.trimEnd()}\n\n${generatedSection}`;
  return {
    markdown: `${baseMarkdown.trimEnd()}\n`,
    viewCount: views.size,
    generatedAtIso,
  };
}

/** Return today's date as a local-calendar YYYY-MM-DD string (not UTC). */
function localDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
