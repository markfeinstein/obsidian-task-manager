import type { App, TFile } from 'obsidian';
import { filterTasks, parseTaskQuery, type TaskFileInfo, type TaskQuery, type TaskQueryOptions } from './task-query';
import type { MarkdownTask } from './task-model';
import type { TaskManagerSettings } from './types';
import { normalizeVaultRelativePath } from './vault-utils';

export type TaskQueryServiceSettings = Pick<TaskManagerSettings,
  | 'supportedStates'
  | 'savedQueries'
  | 'globalFilter'
  | 'globalQuery'
  | 'enableQueryDsl'
  | 'enableDslExpressions'
  | 'nlpQueryEnabled'
  | 'subtaskDateInheritance'
  | 'futureOccurrenceCount'
  | 'customPriorities'
  | 'fileDefaultsEnabled'
  | 'fileDefaultsPropertyPrefix'
  | 'defaultSort'
>;

export interface TaskQueryExecutionContext {
  /** Stable clock for previews, CLI clients, and deterministic tests. */
  today?: string;
  sourcePath?: string;
  includeQueryFileDefaults?: boolean;
  includeGlobalQuery?: boolean;
  includeDefaultSort?: boolean;
}

export interface TaskQueryExecution<T extends MarkdownTask> {
  query: TaskQuery;
  tasks: T[];
}

export function obsidianTaskFileInfoProvider(app: App): (path: string) => TaskFileInfo {
  return (path: string): TaskFileInfo => {
    const abstractFile = app.vault.getAbstractFileByPath(path);
    const file = abstractFile && typeof abstractFile === 'object' && 'extension' in abstractFile ? abstractFile as TFile : null;
    const metadataCache = app.metadataCache as unknown as {
      getFileCache?: (target: TFile) => { frontmatter?: Record<string, unknown>; links?: Array<{ link: string }>; embeds?: Array<{ link: string }> } | null;
      getCache?: (target: string) => { frontmatter?: Record<string, unknown>; links?: Array<{ link: string }>; embeds?: Array<{ link: string }> } | null;
    };
    const cache = file ? metadataCache.getFileCache?.(file) : metadataCache.getCache?.(path);
    const rawLinks = [...(cache?.links ?? []), ...(cache?.embeds ?? [])]
      .map((link) => link.link)
      .filter((link): link is string => typeof link === 'string' && link.length > 0);
    return {
      properties: cache?.frontmatter ?? {},
      outlinks: Array.from(new Set(rawLinks.flatMap((link) => [link, `[[${link}]]`]))),
    };
  };
}

export class TaskQueryService {
  constructor(
    private readonly getSettings: () => TaskQueryServiceSettings,
    private readonly fileInfoProvider: (path: string) => TaskFileInfo,
  ) {}

  private options(sourcePath?: string): TaskQueryOptions {
    const settings = this.getSettings();
    return {
      states: settings.supportedStates,
      ...(sourcePath ? { sourcePath } : {}),
      savedQueries: settings.savedQueries,
      globalFilter: settings.globalFilter,
      enableQueryDsl: settings.enableQueryDsl,
      enableDslExpressions: settings.enableDslExpressions !== false,
      fileInfoProvider: this.fileInfoProvider,
      subtaskDateInheritance: settings.subtaskDateInheritance,
      futureOccurrenceCount: settings.futureOccurrenceCount,
      customPriorities: settings.customPriorities,
      fileDefaultsEnabled: settings.fileDefaultsEnabled,
      fileDefaultsPropertyPrefix: settings.fileDefaultsPropertyPrefix,
      nlpQueryEnabled: settings.nlpQueryEnabled,
    };
  }

  queryFileDefaultInstructions(sourcePath: string): string[] {
    const props = this.fileInfoProvider(sourcePath).properties;
    const lines: string[] = [];
    const addBoolean = (key: string, instruction: string): void => {
      if (typeof props[key] === 'boolean') lines.push(`${props[key] ? 'show' : 'hide'} ${instruction}`);
    };
    if (props.TQ_explain === true) lines.push('explain');
    if (typeof props.TQ_short_mode === 'boolean') lines.push(props.TQ_short_mode ? 'short mode' : 'full mode');
    if (typeof props.TQ_extra_instructions === 'string' && props.TQ_extra_instructions.trim()) lines.push(props.TQ_extra_instructions.trim());
    addBoolean('TQ_show_backlink', 'backlink');
    addBoolean('TQ_show_created_date', 'created date');
    addBoolean('TQ_show_start_date', 'start date');
    addBoolean('TQ_show_scheduled_date', 'scheduled date');
    addBoolean('TQ_show_due_date', 'due date');
    addBoolean('TQ_show_done_date', 'done date');
    addBoolean('TQ_show_cancelled_date', 'cancelled date');
    addBoolean('TQ_show_reminder_date', 'reminder date');
    addBoolean('TQ_show_edit_button', 'edit button');
    addBoolean('TQ_show_postpone_button', 'postpone button');
    addBoolean('TQ_show_recurrence_rule', 'recurrence rule');
    addBoolean('TQ_show_on_completion', 'on completion');
    addBoolean('TQ_show_priority', 'priority');
    addBoolean('TQ_show_id', 'id');
    addBoolean('TQ_show_depends_on', 'depends on');
    addBoolean('TQ_show_tags', 'tags');
    addBoolean('TQ_show_tree', 'tree');
    addBoolean('TQ_show_toolbar', 'toolbar');
    addBoolean('TQ_show_urgency', 'urgency');
    addBoolean('TQ_show_task_count', 'task count');
    return lines;
  }

  parse(source: string, context: TaskQueryExecutionContext = {}): TaskQuery {
    const settings = this.getSettings();
    const sourcePath = context.sourcePath ? normalizeVaultRelativePath(context.sourcePath, 'Query source path') : undefined;
    const queryFileDefaults = sourcePath && context.includeQueryFileDefaults !== false
      ? this.queryFileDefaultInstructions(sourcePath)
      : [];
    const withFileDefaults = queryFileDefaults.length > 0 ? `${queryFileDefaults.join('\n')}\n${source}` : source;
    const globalQuery = context.includeGlobalQuery === false ? '' : settings.globalQuery.trim();
    const ignoresGlobalQuery = /^\s*ignore\s+global\s+query\s*$/imu.test(withFileDefaults);
    const effectiveSource = globalQuery && !ignoresGlobalQuery
      ? `${globalQuery}\n${withFileDefaults}`
      : withFileDefaults.replace(/^\s*ignore\s+global\s+query\s*$/gimu, '');
    const query = parseTaskQuery(effectiveSource, { ...this.options(sourcePath), today: context.today });
    query.explainSources = {
      queryFileDefaults,
      ...(query.explainSources?.expandedQuery ? { expandedQuery: query.explainSources.expandedQuery } : {}),
      ...(globalQuery && !ignoresGlobalQuery ? { globalQuery } : {}),
    };
    if (context.includeDefaultSort !== false && query.sort.length === 0) query.sort = [{ field: settings.defaultSort }];
    return query;
  }

  filter<T extends MarkdownTask>(tasks: readonly T[], query: TaskQuery, context: TaskQueryExecutionContext = {}): T[] {
    const sourcePath = context.sourcePath ? normalizeVaultRelativePath(context.sourcePath, 'Query source path') : undefined;
    return filterTasks(tasks, query, { ...this.options(sourcePath), today: context.today });
  }

  execute<T extends MarkdownTask>(tasks: readonly T[], source: string, context: TaskQueryExecutionContext = {}): TaskQueryExecution<T> {
    const query = this.parse(source, context);
    return { query, tasks: this.filter(tasks, query, context) };
  }
}
