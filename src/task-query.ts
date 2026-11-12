import { nextTaskCheckbox, type MarkdownTask, type TaskPriority } from './task-model';
import { DEFAULT_TASK_STATES, type CustomPriority, type SavedTaskQuery, type TaskStateDefinition, type TaskStatus } from './types';
import { containsUnexpandedTemplateText, resolveFlexibleDate as resolveFlexibleDateFromUtils } from './date-utils';
import { parseEffortMinutesForFilter } from './duration-utils';
import { naturalLanguageToTaskQuery } from './nlp-query';
import { ExplicitIdIndex } from './task-identity';
import { addIsoDays, daysInIsoMonth, isValidIsoDate } from './iso-date';
import { QUERY_RESULT_SAFETY_CEILING } from './query-result-paging';
import { compileQueryExpression, type QueryExpression } from './query-expression';

/** Safely convert an unknown value to string without risking [object Object]. */
function safeStr(v: unknown, fallback = ''): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // For objects: try their custom toString() first; fall back to JSON.stringify
  // only when toString would produce the unhelpful '[object Object]'.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const str = String(v);
  if (str !== '[object Object]') return str;
  try { return JSON.stringify(v); } catch { return fallback; }
}

export type DateField = 'due' | 'scheduled' | 'start' | 'done' | 'created' | 'cancelled' | 'reminder' | 'happens' | 'follow-up';
export type DateOperator = 'before' | 'on' | 'after' | 'on-or-before' | 'on-or-after' | 'in' | 'in-or-before' | 'in-or-after';
export type SortField =
  | 'smart' | 'urgency' | 'status' | 'status.name' | 'status.type' | 'status.symbol' | 'next-status.symbol'
  | 'id' | 'due' | 'scheduled' | 'start' | 'done' | 'created' | 'cancelled' | 'reminder' | 'happens'
  | 'description' | 'description-without-tags' | 'priority' | 'recurring' | 'recurrence' | 'on-completion' | 'depends-on' | 'tag' | 'tags'
  | 'original-markdown' | 'line-number' | 'random' | 'path' | 'root' | 'folder' | 'filename' | 'heading' | 'backlink'
  | 'effort' | 'actual' | 'cost' | 'pinned' | 'context' | 'dependency-order' | 'follow-up'
  | 'assignee' | 'reviewer' | 'project' | 'team' | 'series' | 'recurrence-series';
export type DateValue = string;

export interface TaskFileInfo {
  properties: Record<string, unknown>;
  outlinks: string[];
}

export interface TaskFilterContext {
  today: string;
  allTasks: readonly MarkdownTask[];
  states: readonly TaskStateDefinition[];
  sourcePath?: string;
  globalFilter?: string;
  enableQueryDsl?: boolean;
  fileInfoProvider?: (path: string) => TaskFileInfo | undefined;
  /** Pre-built index: task id → whether that task is actionable (for blocking checks). */
  _actionableIds?: ReadonlySet<string>;
  /** Pre-built reverse index: unique target id → unfinished dependent tasks. */
  _dependsOnIndex?: ReadonlyMap<string, readonly MarkdownTask[]>;
  /** Custom priority scale (overrides built-in six levels for sort weight). */
  customPriorities?: readonly CustomPriority[];
  /** Unique-only explicit-ID resolver shared by filtering, grouping, and sorting. */
  _explicitIds?: ExplicitIdIndex<MarkdownTask>;
  /** Scores precomputed once for urgency/smart sorting or grouping. */
  _urgencyScores?: ReadonlyMap<MarkdownTask, number>;
  /** Execution-local expression/facade cache; never shared between query executions. */
  _expressionCache?: ExpressionCache;
  /** Optional urgency weight overrides passed from plugin settings. */
  urgencyWeights?: { due?: number; priority?: number; scheduled?: number; start?: number };
}

export interface TaskFilter {
  type: string;
  description: string;
  predicate: (task: MarkdownTask, context: TaskFilterContext) => boolean;
}

export type TaskQueryExpression =
  | { type: 'filter'; filter: TaskFilter }
  | { type: 'and' | 'or' | 'xor'; children: TaskQueryExpression[] }
  | { type: 'not'; child: TaskQueryExpression };

export interface SortCriterion {
  field: SortField;
  reverse?: boolean;
  tagIndex?: number;
  functionExpression?: string;
  /** Internal renderer/query default: keep done/cancelled after active tasks without exposing a user sort field. */
  closedTasksLast?: boolean;
}

export interface GroupCriterion {
  field: SortField;
  reverse?: boolean;
  limit?: number;
  tagIndex?: number;
  functionExpression?: string;
}

export interface TaskQueryLayout {
  hidden: Set<string>;
  shown: Set<string>;
  shortMode?: boolean;
}

export interface TaskQueryExplainSources {
  globalQuery?: string;
  queryFileDefaults: string[];
  expandedQuery?: string;
}

export const MAX_EXPLICIT_QUERY_LIMIT = QUERY_RESULT_SAFETY_CEILING;

export interface TaskQuery {
  filters: TaskFilter[];
  expression?: TaskQueryExpression;
  sort: SortCriterion[];
  groups: GroupCriterion[];
  layout: TaskQueryLayout;
  explain: boolean;
  /** When true, show tree only displays children that also pass the query filters. */
  treeFiltered?: boolean;
  limit?: number;
  limitGroups?: number;
  errors: string[];
  instructions: string[];
  explainSources?: TaskQueryExplainSources;
  viewMode?: import('./types').TaskViewMode;
  asOfDate?: string;
  /** When true, append projected future occurrences for recurring tasks. */
  showFutureOccurrences?: boolean;
  /**
   * When true, apply sequential-task filtering: within each contiguous block of
   * tasks at the same (filePath, indent) level, show only the first not-done
   * task. Done/cancelled tasks are always shown.
   */
  sequential?: boolean;
  /** Optional CSS class(es) added to the query container element (from `css-class: my-class`). */
  cssClass?: string;
  /** Optional work-in-progress limit shown by board renderers. */
  wipLimit?: number;
  /** Execution time in milliseconds — populated by the renderer after the query runs. */
  executionTimeMs?: number;
}

export interface TaskQueryOptions {
  today?: string;
  states?: readonly TaskStateDefinition[];
  sourcePath?: string;
  savedQueries?: readonly SavedTaskQuery[];
  globalFilter?: string;
  enableQueryDsl?: boolean;
  /** When false, `filter/sort/group by function` DSL expressions are blocked (security toggle). Default true. */
  enableDslExpressions?: boolean;
  fileInfoProvider?: (path: string) => TaskFileInfo | undefined;
  /** Propagate due/scheduled/start dates from parent tasks to undated subtasks before filtering. */
  subtaskDateInheritance?: boolean;
  /** Number of projected future occurrences to append to results (0 = off). Default: 0. */
  futureOccurrenceCount?: number;
  /** Custom priority scale — overrides built-in six levels for sort comparisons. */
  customPriorities?: readonly CustomPriority[];
  /** When true, apply file-scoped YAML-frontmatter task defaults before filtering. */
  fileDefaultsEnabled?: boolean;
  /** Frontmatter property prefix used for file-scoped task defaults (default: 'task_'). */
  fileDefaultsPropertyPrefix?: string;
  /** Enable conservative natural-language query fallback for otherwise plain-language inputs. */
  nlpQueryEnabled?: boolean;
}

const PRIORITY_ORDER: Readonly<Record<TaskPriority, number>> = {
  highest: 0,
  high: 1,
  medium: 2,
  normal: 3,
  low: 4,
  lowest: 5,
};

const PRIORITY_NUMBER: Readonly<Record<TaskPriority, number>> = PRIORITY_ORDER;

const PRIORITY_ALIASES: Readonly<Record<string, TaskPriority>> = {
  '🔺': 'highest',
  highest: 'highest',
  urgent: 'highest',
  '⏫': 'high',
  high: 'high',
  '🔼': 'medium',
  medium: 'medium',
  normal: 'normal',
  none: 'normal',
  '': 'normal',
  '🔽': 'low',
  low: 'low',
  '⏬': 'lowest',
  lowest: 'lowest',
};

const STATUS_TYPE_ALIASES: Readonly<Record<string, TaskStatus[]>> = {
  todo: ['todo'],
  done: ['done'],
  in_progress: ['in_progress'],
  inprogress: ['in_progress'],
  'in-progress': ['in_progress'],
  on_hold: ['on_hold', 'blocked', 'deferred'],
  onhold: ['on_hold', 'blocked', 'deferred'],
  'on-hold': ['on_hold', 'blocked', 'deferred'],
  blocked: ['blocked'],
  deferred: ['deferred'],
  cancelled: ['cancelled'],
  canceled: ['cancelled'],
  non_task: ['untracked'],
  nontask: ['untracked'],
  'non-task': ['untracked'],
};

const SUPPORTED_SORT_FIELDS: readonly SortField[] = [
  'smart', 'urgency', 'status', 'status.name', 'status.type', 'status.symbol', 'next-status.symbol', 'id',
  'due', 'scheduled', 'start', 'done', 'created', 'cancelled', 'reminder', 'happens', 'description', 'description-without-tags',
  'priority', 'recurring', 'recurrence', 'on-completion', 'depends-on', 'tag', 'tags', 'original-markdown', 'line-number', 'random', 'path', 'root', 'folder', 'filename', 'heading', 'backlink',
  'effort', 'actual', 'cost', 'pinned', 'context', 'dependency-order', 'follow-up',
  'assignee', 'reviewer', 'project', 'team', 'series', 'recurrence-series',
];

const SORT_FIELD_ALIASES: Readonly<Record<string, SortField>> = {
  smart: 'smart',
  urgency: 'urgency',
  status: 'status',
  'status.name': 'status.name',
  'status name': 'status.name',
  'status.type': 'status.type',
  'status type': 'status.type',
  'status.symbol': 'status.symbol',
  'status symbol': 'status.symbol',
  'next status symbol': 'next-status.symbol',
  'next-status.symbol': 'next-status.symbol',
  id: 'id',
  due: 'due',
  scheduled: 'scheduled',
  start: 'start',
  starts: 'start',
  done: 'done',
  completed: 'done',
  completion: 'done',
  created: 'created',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  reminder: 'reminder',
  'follow-up': 'follow-up',
  'follow up': 'follow-up',
  followup: 'follow-up',
  happens: 'happens',
  description: 'description',
  title: 'description',
  text: 'description',
  'description without tags': 'description-without-tags',
  'description-without-tags': 'description-without-tags',
  priority: 'priority',
  recurring: 'recurring',
  recurrence: 'recurrence',
  'on completion': 'on-completion',
  'on-completion': 'on-completion',
  oncompletion: 'on-completion',
  'depends on': 'depends-on',
  'depends-on': 'depends-on',
  dependency: 'depends-on',
  dependencies: 'depends-on',
  depends: 'depends-on',
  tag: 'tag',
  tags: 'tags',
  'original markdown': 'original-markdown',
  'original-markdown': 'original-markdown',
  line: 'line-number',
  'line number': 'line-number',
  'line-number': 'line-number',
  random: 'random',
  path: 'path',
  root: 'root',
  folder: 'folder',
  filename: 'filename',
  file: 'filename',
  heading: 'heading',
  backlink: 'backlink',
  effort: 'effort',
  estimate: 'effort',  // PRD Task 7: 'estimate' is an alias for 'effort' in sort/group
  actual: 'actual',
  cost: 'cost',
  pin: 'pinned',
  pinned: 'pinned',
  context: 'context',
  '@context': 'context',
  contexts: 'context',
  'dependency order': 'dependency-order',
  'dependency-order': 'dependency-order',
  'topological': 'dependency-order',
  assignee: 'assignee',
  reviewer: 'reviewer',
  project: 'project',
  team: 'team',
  series: 'series',
  'recurrence series': 'recurrence-series',
  'recurrence-series': 'recurrence-series',
  'series id': 'series',
  'series-id': 'series',
};

const LAYOUT_ELEMENTS = new Set([
  'id', 'depends on', 'priority', 'cancelled date', 'created date', 'start date', 'scheduled date', 'due date', 'done date',
  'recurrence rule', 'on completion', 'block link', 'tags', 'toolbar', 'tree', 'edit button', 'defer button', 'postpone button', 'backlink',
  'backlinks', 'urgency', 'task count', 'reminder date', 'follow-up date', 'cost', 'cost column', 'pinned', 'pinned column',
  'effort', 'actual', 'timer', 'focus timer',
  // Subtask progress badge (show/hide the [done/total] counter next to parent tasks)
  'progress',
  // Compact stats bar rendered below query results (show stats / hide stats)
  'stats',
]);

export function parseTaskQuery(source: string, options: TaskQueryOptions = {}): TaskQuery {
  const filters: TaskFilter[] = [];
  const expressions: TaskQueryExpression[] = [];
  const sort: SortCriterion[] = [];
  const groups: GroupCriterion[] = [];
  const layout: TaskQueryLayout = { hidden: new Set(), shown: new Set() };
  const errors: string[] = [];
  const instructions: string[] = [];
  let limit: number | undefined;
  let limitGroups: number | undefined;
  let explain = false;
  let treeFiltered = false;
  let sequential = false;
  let cssClass: string | undefined;
  let viewMode: import('./types').TaskViewMode | undefined;
  let asOfDate: string | undefined;
  let showFutureOccurrences: boolean | undefined;
  let wipLimit: number | undefined;

  const nlpTranslatedSource = options.nlpQueryEnabled === true
    ? naturalLanguageToTaskQuery(source, options.today ?? getTodayString()) ?? source
    : source;
  const continuedSource = applyLineContinuations(nlpTranslatedSource);
  const expandedSource = expandQueryMacros(continuedSource, options);
  const lines = expandedSource.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (!line) {
      continue;
    }
    instructions.push(line);

    if (/^explain$/iu.test(line)) {
      explain = true;
      continue;
    }

    if (/^sequential$/iu.test(line)) {
      sequential = true;
      continue;
    }

    if (/^show\s+tree\s+filtered$/iu.test(line)) {
      treeFiltered = true;
      // Also enable tree view when `show tree filtered` is used without explicit `show tree`
      layout.shown.add('tree');
      continue;
    }

    if (/^ignore\s+global\s+query$/iu.test(line)) {
      continue;
    }

    // view: <mode> — selects rendering mode
    const viewMatch = line.match(/^view\s*:\s*(list|checklist|table|grid|kanban|calendar|gantt|timeline|stats|graph|eisenhower)$/iu);
    if (viewMatch) {
      const parsedMode = viewMatch[1].toLowerCase();
      viewMode = (parsedMode === 'grid' ? 'table' : parsedMode) as import('./types').TaskViewMode;
      continue;
    }

    // style: checklist — alias for the native-looking checklist view
    const styleMatch = line.match(/^style\s*:\s*(checklist)$/iu);
    if (styleMatch) {
      viewMode = 'checklist';
      continue;
    }

    // shows/hides future occurrences — project upcoming recurring instances
    if (/^shows?\s+future\s+occurrences$/iu.test(line)) {
      showFutureOccurrences = true;
      continue;
    }
    if (/^hides?\s+future\s+occurrences$/iu.test(line)) {
      showFutureOccurrences = false;
      continue;
    }

    // as of / today is — date context override
    const asOfMatch = line.match(/^(?:as\s+of|today\s+is)\s+(\d{4}-\d{2}-\d{2})$/iu);
    if (asOfMatch) {
      asOfDate = asOfMatch[1];
      continue;
    }

    // css-class — apply custom CSS class(es) to the query container
    const cssClassMatch = line.match(/^css-class\s*:\s*(.+)$/iu);
    if (cssClassMatch) {
      cssClass = cssClassMatch[1].trim();
      continue;
    }

    const wipMatch = line.match(/^wip\s+limit\s+(\d+)$/iu);
    if (wipMatch) {
      wipLimit = Math.max(1, Number.parseInt(wipMatch[1], 10));
      continue;
    }

    const sortMatch = line.match(/^sort\s+by\s+(.+)$/iu);
    if (sortMatch) {
      // options.enableDslExpressions is always passed explicitly from plugin settings (default: false).
      // When called without options (e.g. in unit tests), undefined → allow, which is intentional test behaviour.
      const allowFn = options.enableQueryDsl !== false && options.enableDslExpressions !== false;
      sort.push(...parseSortCriteria(sortMatch[1], lineNumber, allowFn));
      continue;
    }

    const groupMatch = line.match(/^group\s+by\s+(.+)$/iu);
    if (groupMatch) {
      const allowFn = options.enableQueryDsl !== false && options.enableDslExpressions !== false;
      groups.push(parseGroupCriterion(groupMatch[1], lineNumber, allowFn));
      continue;
    }

    const limitMatch = line.match(/^limit\s+(groups?\s+)?(?:to\s+)?(\d+)(?:\s+tasks?)?$/iu);
    if (limitMatch) {
      const value = Math.max(0, Number.parseInt(limitMatch[2], 10));
      if (value > MAX_EXPLICIT_QUERY_LIMIT) throw new Error(`Query limit cannot exceed ${MAX_EXPLICIT_QUERY_LIMIT}.`);
      if (limitMatch[1]) limitGroups = value;
      else limit = value;
      continue;
    }

    const modeMatch = line.match(/^(short|full)\s+mode$/iu);
    if (modeMatch) {
      layout.shortMode = modeMatch[1].toLowerCase() === 'short';
      continue;
    }

    const layoutMatch = line.match(/^(hide|show)\s+(.+)$/iu);
    if (layoutMatch) {
      const element = normalizeLayoutElement(layoutMatch[2]);
      if (!LAYOUT_ELEMENTS.has(element)) {
        errors.push(`Unknown layout element on line ${lineNumber}: ${layoutMatch[2]}`);
      }
      if (layoutMatch[1].toLowerCase() === 'hide') {
        layout.hidden.add(element);
        layout.shown.delete(element);
      } else {
        layout.shown.add(element);
        layout.hidden.delete(element);
      }
      continue;
    }

    try {
      const allowFn = options.enableQueryDsl !== false && options.enableDslExpressions !== false;
      const expression = parseFilterExpression(line, allowFn);
      expressions.push(expression);
      filters.push(...collectFilters(expression));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unsupported task query line ${lineNumber}: ${line}. ${message}`);
    }
  }

  return {
    filters,
    expression: combineExpressions('and', expressions),
    sort,
    groups,
    layout,
    explain,
    treeFiltered,
    sequential,
    limit,
    limitGroups,
    errors,
    instructions,
    viewMode,
    asOfDate,
    showFutureOccurrences,
    cssClass,
    wipLimit,
    explainSources: expandedSource !== continuedSource ? { queryFileDefaults: [], expandedQuery: expandedSource } : undefined,
  };
}

export const DEFAULT_TASK_LIMIT = 100;

/**
 * Sequential-task filter: within each contiguous group of tasks that share the
 * same filePath and indent level, only the first *not-done* task is kept.  All
 * done/cancelled tasks always pass through so completed history remains visible.
 *
 * "Not done" means any status whose type is not 'done' and not 'cancelled'.
 * Tasks are iterated in the order they arrive (post-sort), so the first
 * actionable item in file order wins when no explicit sort has been applied.
 */
export function applySequentialFilter<T extends MarkdownTask>(
  tasks: readonly T[],
  states: readonly TaskStateDefinition[],
): T[] {
  // Build a set of done/cancelled raw checkbox markers for fast lookup.
  const terminalMarkers = new Set<string>(
    states
      .filter((s) => s.type === 'done' || s.type === 'cancelled')
      .map((s) => s.rawText),
  );
  // Track whether we've already seen the first pending task for the current contiguous block.
  // Including task.heading in the bucket key ensures tasks under different headings (i.e. different
  // sections) are treated as independent sequential groups.  Without this, the first pending task
  // in Section 1 would suppress all pending tasks at the same indent level in Section 2, violating
  // the documented "contiguous block" semantics.
  let currentBucket: string | undefined;
  let currentBlockHasPending = false;
  const result: T[] = [];
  for (const task of tasks) {
    const bucket = `${task.filePath}\0${task.indentation}\0${task.heading ?? ''}`;
    if (bucket !== currentBucket) {
      currentBucket = bucket;
      currentBlockHasPending = false;
    }

    const isTerminal = terminalMarkers.has(task.checkbox);
    if (isTerminal) {
      // Done/cancelled tasks always pass through.
      result.push(task);
      continue;
    }
    if (!currentBlockHasPending) {
      currentBlockHasPending = true;
      result.push(task);
    }
    // Subsequent pending tasks in the same contiguous block are suppressed.
  }
  return result;
}
export function filterTasks<T extends MarkdownTask>(tasks: readonly T[], query: string | TaskQuery, options: TaskQueryOptions = {}): T[] {
  const parsed = typeof query === 'string' ? parseTaskQuery(query, options) : query;
  const today = parsed.asOfDate ?? options.today ?? getTodayString();
  const states = options.states ?? DEFAULT_TASK_STATES;
  // Optionally inherit parent dates to undated subtasks before filtering.
  const inheritedTasks = options.subtaskDateInheritance ? applySubtaskDateInheritance(tasks) : tasks;
  // Optionally apply file-scoped YAML frontmatter defaults before filtering.
  const fileInfoProvider = options.fileInfoProvider;
  const effectiveTasks = (options.fileDefaultsEnabled && fileInfoProvider)
    ? inheritedTasks.map((task) => applyFileDefaults(task, fileInfoProvider(task.filePath)?.properties ?? {}, options.fileDefaultsPropertyPrefix ?? 'task_'))
    : inheritedTasks;
  const context: TaskFilterContext = {
    today,
    allTasks: effectiveTasks,
    states,
    sourcePath: options.sourcePath,
    globalFilter: options.globalFilter,
    enableQueryDsl: options.enableQueryDsl,
    fileInfoProvider: options.fileInfoProvider,
    customPriorities: options.customPriorities,
    ...buildDependencyIndices(effectiveTasks),
  };
  const filtered = effectiveTasks.filter((task) => matchesTaskQuery(task, parsed, context));
  // Apply sequential filtering: within each (filePath, indent) group, keep only
  // the first not-done task (plus all done/cancelled tasks).
  const sequentialFiltered = parsed.sequential ? applySequentialFilter(filtered, options.states ?? DEFAULT_TASK_STATES) : filtered;
  let withProjections: T[] = sequentialFiltered;
  if (parsed.showFutureOccurrences) {
    const count = options.futureOccurrenceCount ?? 3;
    const projections: T[] = [];
    for (const task of sequentialFiltered) {
      if (!isDoneLike(task.status) && task.metadata.recurrence) {
        projections.push(...projectOccurrences(task, count, today));
      }
    }
    withProjections = [...sequentialFiltered, ...projections];
  }

  const sorted = sortTasks(withProjections, withUpstreamDefaultSortFallbacks(parsed.sort), today, states, context);
  const effectiveLimit = typeof parsed.limit === 'number' ? parsed.limit : DEFAULT_TASK_LIMIT;
  return sorted.slice(0, effectiveLimit);
}

export function matchesTaskQuery(task: MarkdownTask, query: TaskQuery, todayOrContext: string | TaskFilterContext = getTodayString()): boolean {
  const context: TaskFilterContext = typeof todayOrContext === 'string'
    ? { today: todayOrContext, allTasks: [task], states: DEFAULT_TASK_STATES }
    : todayOrContext;
  if (query.expression) {
    return matchesExpression(task, query.expression, context);
  }
  return query.filters.every((filter) => filter.predicate(task, context));
}

function withUpstreamDefaultSortFallbacks(sort: readonly SortCriterion[]): SortCriterion[] {
  const fallbacks: SortCriterion[] = [{ field: 'status.type' }, { field: 'urgency' }, { field: 'due' }, { field: 'priority' }, { field: 'path' }];
  const closedLast: SortCriterion[] = primarySortIsStatus(sort) ? [] : [{ field: 'status.type', closedTasksLast: true }];
  return [...closedLast, ...sort, ...fallbacks];
}

function primarySortIsStatus(sort: readonly SortCriterion[]): boolean {
  const primary = sort[0];
  return Boolean(primary && isStatusSortField(primary.field));
}

function isStatusSortField(field: SortField): boolean {
  return field === 'status' || field === 'status.name' || field === 'status.type' || field === 'status.symbol' || field === 'next-status.symbol';
}

export function sortTasks<T extends MarkdownTask>(
  tasks: readonly T[],
  sort: readonly (SortCriterion | SortField)[],
  today = getTodayString(),
  states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES,
  baseContext?: Partial<TaskFilterContext>,
): T[] {
  const criteria = sort.map((criterion) => typeof criterion === 'string' ? { field: criterion } : criterion);
  if (criteria.length === 0) {
    return [...tasks];
  }
  let context = completeTaskContext(baseContext, tasks);
  if (criteria.some((criterion) => criterion.field === 'urgency' || criterion.field === 'smart')) {
    const scores = new Map<MarkdownTask, number>();
    for (const task of tasks) scores.set(task, calculateUrgency(task, today, context));
    context = { ...context, _urgencyScores: scores };
  }

  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      for (const criterion of criteria) {
        if (criterion.closedTasksLast) {
          const comparison = closedTaskSortBucket(left.task.status) - closedTaskSortBucket(right.task.status);
          if (comparison !== 0) return comparison;
          continue;
        }
        const comparison = compareByField(left.task, right.task, criterion, today, states, context);
        if (comparison !== 0) {
          return criterion.reverse ? -comparison : comparison;
        }
      }
      return left.index - right.index;
    })
    .map((entry) => entry.task);
}

// Default urgency coefficients — match the upstream obsidian-tasks formula.
// These can be overridden per-query via TaskFilterContext.urgencyWeights.
const URGENCY_DUE_COEFFICIENT = 12.0;
const URGENCY_SCHEDULED_COEFFICIENT = 5.0;
const URGENCY_STARTED_COEFFICIENT = -3.0;
const URGENCY_PRIORITY_COEFFICIENT = 6.0;

export function calculateUrgency(task: MarkdownTask, today = getTodayString(), context?: Partial<Pick<TaskFilterContext, 'allTasks' | '_dependsOnIndex' | '_explicitIds' | 'urgencyWeights'>>): number {
  let urgency = 0.0;

  // Use per-context weights if provided, otherwise fall back to compile-time defaults.
  const wDue = context?.urgencyWeights?.due ?? URGENCY_DUE_COEFFICIENT;
  const wScheduled = context?.urgencyWeights?.scheduled ?? URGENCY_SCHEDULED_COEFFICIENT;
  const wStart = context?.urgencyWeights?.start ?? URGENCY_STARTED_COEFFICIENT;
  const wPriority = context?.urgencyWeights?.priority ?? URGENCY_PRIORITY_COEFFICIENT;

  const due = task.metadata.dates.due;
  if (due && isValidIsoDate(due)) {
    const daysOverdue = diffDays(due, today); // positive = overdue
    let dueMultiplier: number;
    if (daysOverdue >= 7.0) {
      dueMultiplier = 1.0; // more than 1 week overdue
    } else if (daysOverdue >= -14.0) {
      // due between 7 days ago and 14 days from now
      dueMultiplier = ((daysOverdue + 14.0) * 0.8) / 21.0 + 0.2;
    } else {
      dueMultiplier = 0.2; // more than 2 weeks away
    }
    urgency += dueMultiplier * wDue;
  }

  const scheduled = task.metadata.dates.scheduled;
  if (scheduled && isValidIsoDate(scheduled)) {
    // Scheduled today or earlier contributes positively
    if (scheduled <= today) urgency += 1 * wScheduled;
  }

  const start = task.metadata.dates.start;
  if (start && isValidIsoDate(start)) {
    // Start date in the future reduces urgency
    if (start > today) urgency += 1 * wStart;
  }

  const priorityMultiplier: Readonly<Record<TaskPriority, number>> = {
    highest: 1.5,
    high: 1.0,
    medium: 0.65,
    normal: 0.325,
    low: 0.0,
    lowest: -0.3,
  };
  urgency += priorityMultiplier[task.metadata.priority] * wPriority;

  const allTasks = context?.allTasks ?? [];
  const explicitIds = context?._explicitIds ?? new ExplicitIdIndex(allTasks);
  // Reduce urgency only when a dependency resolves to exactly one unfinished task.
  // Missing and duplicate IDs are health errors, not file-order-dependent edges.
  if (task.status === 'blocked') {
    urgency -= 2.0;
  } else if (task.metadata.dependsOn.length > 0) {
    const hasUnresolved = task.metadata.dependsOn.some((depId) => {
      const depTask = explicitIds.unique(depId);
      return depTask ? (depTask.status !== 'done' && depTask.status !== 'cancelled') : false;
    });
    if (hasUnresolved) urgency -= 1.5;
  }
  // A duplicate explicit ID cannot safely be treated as the blocker.
  const taskId = task.metadata.id?.trim();
  if (taskId && explicitIds.unique(taskId) === task) {
    const isBlocking = context?._dependsOnIndex
      ? (context._dependsOnIndex.get(taskId)?.length ?? 0) > 0
      : allTasks.some(
        (candidate) => candidate !== task && candidate.status !== 'done' && candidate.status !== 'cancelled'
          && candidate.metadata.dependsOn.includes(taskId),
      );
    if (isBlocking) urgency += 1.0;
  }

  return urgency;
}

export function groupTasks<T extends MarkdownTask>(tasks: readonly T[], groups: readonly GroupCriterion[], today = getTodayString(), states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES, baseContext?: Partial<TaskFilterContext>): GroupedTaskNode<T>[] {
  if (groups.length === 0) {
    return [{ name: '', tasks: [...tasks] }];
  }
  let context = completeTaskContext(baseContext, tasks);
  if (groups.some((criterion) => criterion.field === 'urgency' || criterion.field === 'smart')) {
    const scores = new Map<MarkdownTask, number>();
    for (const task of tasks) scores.set(task, calculateUrgency(task, today, context));
    context = { ...context, _urgencyScores: scores };
  }
  return buildGroups(tasks, groups, 0, today, states, context);
}

export interface GroupedTaskNode<T extends MarkdownTask> {
  name: string;
  tasks?: T[];
  children?: GroupedTaskNode<T>[];
  /** Aggregation data for this group (effort sum, overdue count, etc.) */
  aggregations?: {
    effortSum?: string; // e.g., "5h 30m"
    overdueCount?: number;
  };
}

function buildGroups<T extends MarkdownTask>(tasks: readonly T[], groups: readonly GroupCriterion[], depth: number, today: string, states: readonly TaskStateDefinition[], baseContext?: Partial<TaskFilterContext>): GroupedTaskNode<T>[] {
  const criterion = groups[depth];
  const buckets = new Map<string, T[]>();
  for (const task of tasks) {
    const keys = groupKeys(task, criterion.field, today, states, criterion.functionExpression, baseContext, criterion.tagIndex);
    for (const key of keys) {
      const existing = buckets.get(key) ?? [];
      if (!existing.includes(task)) existing.push(task);
      buckets.set(key, existing);
    }
  }
  const names = Array.from(buckets.keys()).sort((a, b) => compareGroupNames(a, b, criterion.field, today));
  if (criterion.reverse) names.reverse();
  return names.map((name) => {
    const bucketTasks = buckets.get(name) ?? [];
    const limited = criterion.limit !== undefined ? bucketTasks.slice(0, criterion.limit) : bucketTasks;
    
    // Compute aggregations over the same limited task set that is rendered in the group.
    const aggregations = computeGroupAggregations(limited, today);
    
    if (depth + 1 < groups.length) {
      return { name, children: buildGroups(limited, groups, depth + 1, today, states, baseContext), aggregations };
    }
    return { name, tasks: limited, aggregations };
  });
}


function computeGroupAggregations<T extends MarkdownTask>(tasks: readonly T[], today: string): { effortSum?: string; overdueCount?: number } {
  let totalMinutes = 0;
  let overdueCount = 0;
  let hasEffort = false;
  
  for (const task of tasks) {
    // Sum effort
    if (task.metadata.effort) {
      const minutes = parseEffortMinutes(task.metadata.effort);
      // Skip unparseable effort values (Infinity) to avoid poisoning the sum
      if (Number.isFinite(minutes)) {
        totalMinutes += minutes;
        hasEffort = true;
      }
    }
    
    // Count overdue tasks
    if (task.metadata.dates.due && task.metadata.dates.due < today && task.status !== 'done' && task.status !== 'cancelled') {
      overdueCount += 1;
    }
  }
  
  const result: { effortSum?: string; overdueCount?: number } = {};
  if (hasEffort) {
    result.effortSum = formatEffortMinutes(totalMinutes);
  }
  if (overdueCount > 0) {
    result.overdueCount = overdueCount;
  }
  
  return Object.keys(result).length > 0 ? result : {};
}

function formatEffortMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) {
    return `${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${mins}m`;
}

function compareGroupNames(left: string, right: string, field: SortField, _today: string): number {
  if (field === 'urgency' || field === 'smart') {
    return urgencyGroupOrder(left) - urgencyGroupOrder(right);
  }
  if (field === 'priority') {
    return priorityGroupOrder(left) - priorityGroupOrder(right);
  }
  if (field === 'status.type') {
    return statusTypeGroupOrder(left) - statusTypeGroupOrder(right);
  }
  return left.localeCompare(right);
}

function priorityGroupOrder(value: string): number {
  const normalized = value.toLowerCase();
  if (normalized.startsWith('highest')) return 0;
  if (normalized.startsWith('high')) return 1;
  if (normalized.startsWith('medium')) return 2;
  if (normalized.startsWith('normal')) return 3;
  if (normalized.startsWith('lowest')) return 5;
  if (normalized.startsWith('low')) return 4;
  return 99;
}

function statusTypeGroupOrder(value: string): number {
  const normalized = value.replace(/%%\d+%%/gu, '').trim().toUpperCase();
  if (normalized === 'IN_PROGRESS') return 0;
  if (normalized === 'TODO') return 1;
  if (normalized === 'ON_HOLD') return 2;
  if (normalized === 'DONE') return 3;
  if (normalized === 'CANCELLED') return 4;
  if (normalized === 'NON_TASK') return 5;
  return 99;
}

interface BooleanDelimiterPair { open: string; close: string; }

function parseFilterExpression(line: string, enableQueryDsl: boolean): TaskQueryExpression {
  if (/^filter\s+by\s+function\s+/iu.test(line)) {
    return { type: 'filter', filter: parseAtomicFilter(line, enableQueryDsl) };
  }
  const family = chooseBooleanDelimiterFamily(line);
  const parser = new ExpressionParser(tokenizeExpression(line, family), enableQueryDsl, family);
  return parser.parse();
}

const BOOLEAN_DELIMITER_FAMILIES: readonly BooleanDelimiterPair[] = [
  { open: '(', close: ')' },
  { open: '[', close: ']' },
  { open: '{', close: '}' },
];

/**
 * Pick which delimiter family ((), [] or {}) is used to group boolean sub-filters on a line.
 * Mirrors upstream Tasks plugin's behaviour of accepting any of those three families,
 * preferring the one matched at the outermost characters after stripping leading unary operators.
 */
function chooseBooleanDelimiterFamily(line: string): BooleanDelimiterPair {
  // Strip wikilinks, embeds, and quoted strings so legitimate bracket use inside
  // filter values (such as `path includes [[Some/Note]]`) doesn't influence detection.
  const stripped = line
    .replace(/!?\[\[[^\]]*\]\]/gu, '')
    .replace(/"(?:[^"\\]|\\.)*"/gu, '')
    .replace(/'(?:[^'\\]|\\.)*'/gu, '');
  const trimmed = stripped.trim();
  if (!trimmed) return BOOLEAN_DELIMITER_FAMILIES[0];

  // Skip any leading unary boolean operators (NOT, AND, OR, XOR) and their whitespace
  // so they don't mask the outermost delimiter, mirroring upstream BooleanDelimiters.fromInstructionLine.
  const afterLeadingOps = trimmed.replace(/^(?:(?:NOT|AND|OR|XOR)\b\s*)+/iu, '');
  const first = afterLeadingOps[0];
  const last = trimmed[trimmed.length - 1];

  const chosen = BOOLEAN_DELIMITER_FAMILIES.find((family) => first === family.open && last === family.close);
  if (chosen) {
    assertNoMixedBooleanDelimiters(stripped, chosen);
    return chosen;
  }

  // No outermost grouping detected – default to parentheses, but still reject
  // expressions that obviously combine multiple families with boolean operators.
  assertNoMixedBooleanDelimiters(stripped, BOOLEAN_DELIMITER_FAMILIES[0]);
  return BOOLEAN_DELIMITER_FAMILIES[0];
}

function assertNoMixedBooleanDelimiters(stripped: string, chosen: BooleanDelimiterPair): void {
  const hasBoolean = /\b(?:and|or|xor|not)\b/iu.test(stripped);
  if (!hasBoolean) return;
  for (const other of BOOLEAN_DELIMITER_FAMILIES) {
    if (other.open === chosen.open) continue;
    const o = escapeRegExp(other.open);
    const c = escapeRegExp(other.close);
    // Detect closing-delim followed by a boolean operator, or a boolean operator followed by an opening-delim.
    const re = new RegExp(`(?:${c}\\s*(?:AND|OR|XOR)\\b)|(?:\\b(?:AND|OR|XOR|NOT)\\s*${o})`, 'iu');
    if (re.test(stripped)) {
      throw new Error("Mixed boolean operator delimiters detected. Use only one delimiter family per expression: '(...)', '[...]', or '{...}'.");
    }
  }
}

class ExpressionParser {
  private position = 0;

  constructor(private readonly tokens: readonly string[], private readonly enableQueryDsl: boolean, private readonly delimiter: BooleanDelimiterPair = { open: '(', close: ')' }) {}

  parse(): TaskQueryExpression {
    if (this.tokens.length === 0) {
      throw new Error('Empty filter expression.');
    }
    const expression = this.parseOr();
    const token = this.peek();
    if (token) {
      throw new Error(`Unexpected token '${token}'.`);
    }
    return expression;
  }

  private parseOr(): TaskQueryExpression {
    const children = [this.parseAnd()];
    while (this.consumeKeyword('or')) {
      children.push(this.parseAnd());
    }
    return combineExpressions('or', children) ?? children[0];
  }

  private parseAnd(): TaskQueryExpression {
    const children = [this.parseXor()];
    while (this.consumeKeyword('and')) {
      children.push(this.parseXor());
    }
    return combineExpressions('and', children) ?? children[0];
  }

  private parseXor(): TaskQueryExpression {
    const children = [this.parseUnary()];
    while (this.consumeKeyword('xor')) {
      children.push(this.parseUnary());
    }
    return combineExpressions('xor', children) ?? children[0];
  }

  private parseUnary(): TaskQueryExpression {
    if (this.consumeKeyword('not')) {
      return { type: 'not', child: this.parseUnary() };
    }
    return this.parseFactor();
  }

  private parseFactor(): TaskQueryExpression {
    if (this.consume(this.delimiter.open)) {
      const expression = this.parseOr();
      if (!this.consume(this.delimiter.close)) {
        throw new Error(`Missing closing '${this.delimiter.close}'.`);
      }
      return expression;
    }

    const term: string[] = [];
    while (this.peek() && this.peek() !== this.delimiter.close && !isBooleanToken(this.peek() ?? '')) {
      term.push(this.tokens[this.position]);
      this.position += 1;
    }

    if (term.length === 0) {
      throw new Error(`Expected a filter before '${this.peek() ?? 'end of line'}'.`);
    }

    return { type: 'filter', filter: parseAtomicFilter(term.join(' '), this.enableQueryDsl) };
  }

  private consumeKeyword(keyword: 'and' | 'or' | 'not' | 'xor'): boolean {
    const token = this.peek();
    if (token?.toLowerCase() === keyword) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private consume(value: string): boolean {
    if (this.peek() === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private peek(): string | undefined {
    return this.tokens[this.position];
  }
}

function tokenizeExpression(line: string, delimiter: BooleanDelimiterPair = { open: '(', close: ')' }): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  const flush = (): void => {
    if (current) {
      tokens.push(current);
      current = '';
    }
  };

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === '\\' && index + 1 < line.length) {
        current += line[index + 1];
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = undefined;
        continue;
      }
      current += character;
      continue;
    }

    // Only honour '"' or "'" as filter-text quotes when they are NOT the boolean grouping delimiter.
    if ((character === '"' || character === "'") && character !== delimiter.open && character !== delimiter.close) {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (character === delimiter.open || character === delimiter.close) {
      flush();
      tokens.push(character);
      continue;
    }
    current += character;
  }

  if (quote) {
    throw new Error('Unclosed quoted value.');
  }
  flush();
  return tokens;
}

function stripWikiLink(value: string): string {
  return value.replace(/^\[\[/u, '').replace(/\]\]$/u, '').split('|')[0];
}

function parseAtomicFilter(rawTerm: string, enableQueryDsl = true): TaskFilter {
  const line = rawTerm.trim();
  const lower = line.toLowerCase();

  const functionMatch = line.match(/^filter\s+by\s+function\s+(.+)$/iu);
  if (functionMatch) {
    if (!enableQueryDsl) {
      throw new Error("Function expressions are disabled. Enable 'Enable function expressions' in Task Manager settings to use 'filter by function'.");
    }
    const expression = functionMatch[1];
    return predicateFilter(line, (task, context) => Boolean(evaluateTaskExpression(expression, task, context)));
  }

  if (lower === 'done') {
    return predicateFilter(line, (task) => isDoneLike(task.status));
  }
  if (lower === 'not done') {
    return predicateFilter(line, (task) => !isDoneLike(task.status));
  }
  // `all` — match everything (useful for queries that only sort/group without filtering)
  if (lower === 'all') {
    return predicateFilter(line, () => true);
  }

  // Match upstream `is recurring`: only tasks with a parseable recurrence rule
  // count as recurring; unparseable rules (invalidRecurrence flag set) are
  // treated as not recurring, matching upstream's `recurrence !== null` check
  // where Recurrence.fromText returns null for invalid input.
  if (lower === 'is recurring') return predicateFilter(line, (task) => Boolean(task.metadata.recurrence) && !task.metadata.invalidRecurrence);
  if (lower === 'is not recurring') return predicateFilter(line, (task) => !task.metadata.recurrence || Boolean(task.metadata.invalidRecurrence));
  if (lower === 'is blocked') return predicateFilter(line, (task, context) => isTaskBlocked(task, context.allTasks, context));
  if (lower === 'is not blocked') return predicateFilter(line, (task, context) => !isTaskBlocked(task, context.allTasks, context));
  if (lower === 'is blocking') return predicateFilter(line, (task, context) => isTaskBlocking(task, context.allTasks, context));
  if (lower === 'is not blocking') return predicateFilter(line, (task, context) => !isTaskBlocking(task, context.allTasks, context));
  if (lower === 'exclude sub-items') return predicateFilter(line, (task) => task.indentation.length === 0);
  if (lower === 'is pinned' || lower === 'pinned') return predicateFilter(line, (task) => Boolean(task.metadata.pinned));
  if (lower === 'is not pinned' || lower === 'not pinned') return predicateFilter(line, (task) => !task.metadata.pinned);
  if (lower === 'has series' || lower === 'series exists') return predicateFilter(line, (task) => Boolean(task.metadata.recurrenceSeriesId));
  if (lower === 'no series' || lower === 'series missing' || lower === 'series absent') return predicateFilter(line, (task) => !task.metadata.recurrenceSeriesId);

  const statusTypeMatch = line.match(/^status(?:\.type)?\s+(is not|is)\s+(.+)$/iu);
  if (statusTypeMatch) {
    const types = normalizeStatusTypes(statusTypeMatch[2]);
    const negate = statusTypeMatch[1].toLowerCase() === 'is not';
    return predicateFilter(line, (task, context) => {
      const configuredType = context.states.find((state) => state.rawText === task.checkbox)?.type;
      const defaultType = DEFAULT_TASK_STATES.find((state) => state.rawText === task.checkbox)?.type;
      const effectiveType = configuredType && configuredType !== defaultType ? configuredType : task.status;
      return types.includes(effectiveType) !== negate;
    });
  }

  const statusNameMatch = line.match(/^status\.name\s+(includes|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (statusNameMatch) {
    return textPropertyFilter(line, statusNameMatch[1], statusNameMatch[2], (task, context) => statusName(task, context.states));
  }

  const statusSymbolMatch = line.match(/^(?:status\.symbol|status symbol)\s+(is not|is|includes|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (statusSymbolMatch) {
    return textPropertyFilter(line, statusSymbolMatch[1], statusSymbolMatch[2], (task) => task.checkbox);
  }

  const datePresence = parseDatePresenceFilter(line);
  if (datePresence) return datePresence;
  const dateFilter = parseDateFilter(line);
  if (dateFilter) return dateFilter;

  const priorityMatch =
    line.match(/^priority(?:\s+is)?\s+(above|below|not)\s+(.+)$/iu)
    ?? line.match(/^priority\s+is\s+(.+)$/iu)
    ?? line.match(/^priority\s+(.+)$/iu);
  if (priorityMatch) {
    const modifier = priorityMatch.length > 2 ? priorityMatch[1]?.toLowerCase() : undefined;
    const value = parsePriority(priorityMatch.length > 2 ? priorityMatch[2] : priorityMatch[1]);
    return predicateFilter(line, (task) => {
      if (modifier === 'above') return PRIORITY_ORDER[task.metadata.priority] < PRIORITY_ORDER[value];
      if (modifier === 'below') return PRIORITY_ORDER[task.metadata.priority] > PRIORITY_ORDER[value];
      if (modifier === 'not') return task.metadata.priority !== value;
      return task.metadata.priority === value;
    });
  }

  const textMatch = line.match(/^(text|description|description without tags|original markdown)\s+(includes|include|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (textMatch) {
    const property = textMatch[1].toLowerCase();
    return textPropertyFilter(line, textMatch[2], textMatch[3], (task, context) => {
      if (property === 'original markdown') return task.rawLine;
      const description = stripGlobalFilter(task.normalizedText, context.globalFilter);
      if (property === 'description without tags') return stripTags(description);
      return description;
    });
  }

  const metadataPresenceMatch = line.match(/^(recurrence|recurs|repeating|id|on completion|on-completion|oncompletion)\s+(exists|present|missing|absent)$/iu)
    ?? line.match(/^(has|no)\s+(recurrence|id|on completion|on-completion|oncompletion)$/iu);
  if (metadataPresenceMatch) {
    const hasStyle = metadataPresenceMatch[1].toLowerCase() === 'has' || metadataPresenceMatch[1].toLowerCase() === 'no';
    const field = normalizeMetadataField(hasStyle ? metadataPresenceMatch[2] : metadataPresenceMatch[1]);
    const present = hasStyle ? metadataPresenceMatch[1].toLowerCase() === 'has' : isPresenceWord(metadataPresenceMatch[2]);
    return predicateFilter(line, (task) => Boolean(metadataFieldValue(task, field)) === present);
  }

  const metadataValueMatch = line.match(/^(recurrence|recurs|repeating|id|on completion|on-completion|oncompletion)\s+(includes|include|does not include|is|regex matches|regex does not match)\s+(.+)$/iu);
  if (metadataValueMatch) {
    const field = normalizeMetadataField(metadataValueMatch[1]);
    return textPropertyFilter(line, metadataValueMatch[2], metadataValueMatch[3], (task) => metadataFieldValue(task, field));
  }

  const seriesIdMatch = line.match(/^(?:series|recurrence.?series)(?:\.id)?\s+(is|includes|include|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (seriesIdMatch) {
    return textPropertyFilter(line, seriesIdMatch[1], seriesIdMatch[2], (task) => task.metadata.recurrenceSeriesId ?? '');
  }

  const dependencyPresenceMatch = line.match(/^(dependency|dependencies|depends|depends on)\s+(exists|present|missing|absent)$/iu)
    ?? line.match(/^(has|no)\s+(depends on|dependency|dependencies)$/iu);
  if (dependencyPresenceMatch) {
    const hasStyle = dependencyPresenceMatch[1].toLowerCase() === 'has' || dependencyPresenceMatch[1].toLowerCase() === 'no';
    const present = hasStyle ? dependencyPresenceMatch[1].toLowerCase() === 'has' : isPresenceWord(dependencyPresenceMatch[2]);
    return predicateFilter(line, (task) => task.metadata.dependsOn.length > 0 === present);
  }

  const dependsOnMatch = line.match(/^(?:depends\s+on|dependency|dependencies|depends)\s+(includes|include|does not include|is|regex matches|regex does not match)?\s*(.+)$/iu);
  if (dependsOnMatch) {
    const operator = dependsOnMatch[1] || 'includes';
    return textPropertyFilter(line, operator, dependsOnMatch[2], (task) => task.metadata.dependsOn.join(','));
  }

  const tagPresence = line.match(/^(has|no)\s+tags?$/iu);
  if (tagPresence) {
    const present = tagPresence[1].toLowerCase() === 'has';
    return predicateFilter(line, (task) => task.tags.length > 0 === present);
  }

  const tagMatch = line.match(/^tags?\s+(includes|include|do not include|does not include|regex matches|regex does not match)\s+#?(.+)$/iu);
  if (tagMatch) {
    const op = tagMatch[1].replace(/^do not include$/iu, 'does not include');
    return tagPropertyFilter(line, op, tagMatch[2]);
  }

  const listMarkerMatch = line.match(/^list\s+marker\s+(is not|is|includes|include|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (listMarkerMatch) {
    return textPropertyFilter(line, listMarkerMatch[1], listMarkerMatch[2], (task) => task.listMarker);
  }

  const lineNumberMatch = line.match(/^line\s+number\s+(is not|is|before|after|above|below)\s+(\d+)$/iu);
  if (lineNumberMatch) {
    const value = Number.parseInt(lineNumberMatch[2], 10);
    const op = lineNumberMatch[1].toLowerCase();
    return predicateFilter(line, (task) => op === 'is' ? task.lineNumber === value : op === 'is not' ? task.lineNumber !== value : (op === 'before' || op === 'above') ? task.lineNumber < value : task.lineNumber > value);
  }

  const fileMatch = line.match(/^(path|root|folder|filename|file name|heading|backlink)\s+(includes|include|does not include|excludes|exclude|regex matches|regex does not match|is not|is)\s+(.+)$/iu);
  if (fileMatch) {
    const prop = fileMatch[1].toLowerCase().replace('file name', 'filename');
    const op = fileMatch[2].replace(/^excludes?$/iu, 'does not include');
    return textPropertyFilter(line, op, fileMatch[3], (task) => fileProperty(task, prop));
  }

  // ── File-property built-in filters (#16) ────────────────────────────────────
  // Syntax: file property <name> includes <value>
  //         file property <name> is <value>
  //         file property <name> missing | exists
  //         file has property <name>
  //         file tags includes <tag>
  //         note tags includes <tag>
  const filePropPresence = line.match(/^(?:file|note)\s+has\s+property\s+(.+)$/iu);
  if (filePropPresence) {
    const propName = filePropPresence[1].trim().toLowerCase();
    return predicateFilter(line, (task, ctx) => {
      const props = ctx.fileInfoProvider?.(task.filePath)?.properties ?? {};
      return Object.prototype.hasOwnProperty.call(props, propName)
        || Object.keys(props).some((k) => k.toLowerCase() === propName);
    });
  }
  const filePropMatch = line.match(/^(?:file|note)\s+property\s+(\S+)\s+(includes?|does not include|is not|is|missing|absent|exists|present)\s*(.*)$/iu);
  if (filePropMatch) {
    const propName = filePropMatch[1].trim().toLowerCase();
    const op = filePropMatch[2].trim().toLowerCase();
    const expectedRaw = filePropMatch[3].trim();
    const present = op === 'exists' || op === 'present';
    const missing = op === 'missing' || op === 'absent';
    return predicateFilter(line, (task, ctx) => {
      const props = ctx.fileInfoProvider?.(task.filePath)?.properties ?? {};
      const key = Object.keys(props).find((k) => k.toLowerCase() === propName) ?? propName;
      const value = safeStr(props[key]);
      if (present) return value !== '' && props[key] !== undefined;
      if (missing) return value === '' || props[key] === undefined;
      const expected = unquote(expectedRaw);
      if (op === 'is') return value.toLowerCase() === expected.toLowerCase();
      if (op === 'is not') return value.toLowerCase() !== expected.toLowerCase();
      const inc = value.toLowerCase().includes(expected.toLowerCase());
      return (op === 'does not include') ? !inc : inc;
    });
  }

  // ── File-tags built-in filter (#17) ──────────────────────────────────────
  // Syntax: file tags includes <tag>   |  note tags includes <tag>
  //         file tags does not include <tag>
  const fileTagsMatch = line.match(/^(?:file|note)\s+tags?\s+(includes?|does not include|is not|is|missing|absent|exists|present)\s*(.*)$/iu);
  if (fileTagsMatch) {
    const op = fileTagsMatch[1].trim().toLowerCase();
    const expectedRaw = fileTagsMatch[2].trim();
    const present = op === 'exists' || op === 'present';
    const missing = op === 'missing' || op === 'absent';
    return predicateFilter(line, (task, ctx) => {
      const props = ctx.fileInfoProvider?.(task.filePath)?.properties ?? {};
      // Collect tags from the 'tags' frontmatter property, normalising with/without '#'
      const rawTags: string[] = [];
      const tagsValue = props['tags'] ?? props['tag'];
      if (Array.isArray(tagsValue)) rawTags.push(...(tagsValue as unknown[]).map((t) => String(t)));
      else if (typeof tagsValue === 'string') rawTags.push(...tagsValue.split(/[\s,]+/u).filter(Boolean));
      const tags = rawTags.map((t) => (t.startsWith('#') ? t : `#${t}`).toLowerCase());
      if (present) return tags.length > 0;
      if (missing) return tags.length === 0;
      const expected = unquote(expectedRaw).toLowerCase().replace(/^#?/, '#');
      const exact = tags.some((t) => t === expected);
      if (op === 'is') return exact;
      if (op === 'is not') return !exact;
      const includes = exact || tags.some((t) => t.startsWith(`${expected}/`));
      return (op === 'does not include') ? !includes : includes;
    });
  }

  // ── Outlinks built-in filters ─────────────────────────────────────────────
  const outlinkIncludesMatch = line.match(/^outlinks?\s+(includes?|does\s+not\s+include|excludes?)\s+(.+)$/iu);
  if (outlinkIncludesMatch) {
    const negate = /does\s+not\s+include|excludes?/iu.test(outlinkIncludesMatch[1]);
    const target = outlinkIncludesMatch[2].trim().replace(/^\[\[|\]\]$/gu, '');
    return predicateFilter(line, (task) => {
      const hasMatch = buildDslLinks(task).some((l) => l.linksTo(target));
      return negate ? !hasMatch : hasMatch;
    });
  }
  const inlinkIncludesMatch = line.match(/^inlinks?\s+(includes?|does\s+not\s+include|excludes?)\s+(.+)$/iu);
  if (inlinkIncludesMatch) {
    const negate = /does\s+not\s+include|excludes?/iu.test(inlinkIncludesMatch[1]);
    const sourceName = stripWikiLink(inlinkIncludesMatch[2].trim()).replace(/\.md$/iu, '');
    return predicateFilter(line, (task, context) => {
      const taskNames = new Set([
        task.filePath.replace(/\.md$/iu, ''),
        task.filePath.split('/').pop()?.replace(/\.md$/iu, '') ?? task.filePath,
      ]);
      const hasMatch = context.allTasks.some((candidate) => {
        const candidatePath = candidate.filePath.replace(/\.md$/iu, '');
        const candidateBase = candidate.filePath.split('/').pop()?.replace(/\.md$/iu, '') ?? candidatePath;
        if (candidatePath !== sourceName && candidateBase !== sourceName) return false;
        const outlinks = context.fileInfoProvider?.(candidate.filePath)?.outlinks ?? [];
        return outlinks.map((link) => stripWikiLink(link).replace(/\.md$/iu, '')).some((link) => taskNames.has(link) || taskNames.has(link.split('/').pop() ?? link));
      });
      return negate ? !hasMatch : hasMatch;
    });
  }

  const outlinkRegexMatch = line.match(/^outlinks?\s+(regex\s+matches|regex\s+does\s+not\s+match)\s+\/(.+)\/([gimusy]*)$/iu);
  if (outlinkRegexMatch) {
    const negate = /does\s+not\s+match/iu.test(outlinkRegexMatch[1]);
    const pattern = outlinkRegexMatch[2];
    assertSafeUserRegexPattern(pattern);
    let regex: RegExp;
    try { regex = new RegExp(pattern, (outlinkRegexMatch[3] || 'iu').toLowerCase()); } catch { throw new Error(`Invalid regex in outlinks filter: /${pattern}/`); }
    return predicateFilter(line, (task) => {
      const hasMatch = buildDslLinks(task).some((l) => {
        regex.lastIndex = 0;
        return regex.test(l.destinationPath);
      });
      return negate ? !hasMatch : hasMatch;
    });
  }

  // ── Effort / actual-time presence and content filters ────────────────────
  // 'estimate' is an alias for 'effort' (PRD Task 7).
  if (lower === 'has effort' || lower === 'effort is set' || lower === 'has estimate' || lower === 'estimate is set') return predicateFilter(line, (task) => Boolean(task.metadata.effort));
  if (lower === 'has no effort' || lower === 'effort not set' || lower === 'effort is not set' || lower === 'has no estimate' || lower === 'estimate not set' || lower === 'estimate is not set') return predicateFilter(line, (task) => !task.metadata.effort);
  if (lower === 'has actual' || lower === 'actual is set') return predicateFilter(line, (task) => Boolean(task.metadata.actual));
  if (lower === 'has no actual' || lower === 'actual not set' || lower === 'actual is not set') return predicateFilter(line, (task) => !task.metadata.actual);
  if (lower === 'has cost' || lower === 'cost is set') return predicateFilter(line, (task) => task.metadata.cost !== undefined);
  if (lower === 'has no cost' || lower === 'cost not set' || lower === 'cost is not set') return predicateFilter(line, (task) => task.metadata.cost === undefined);

  // -- Cross-field numeric comparison filters --
  const earlyCrossFieldMatch = line.match(/^(effort|actual|cost)\s+(>|<|>=|<=|=|above|below|over|under|greater\s+than|less\s+than)\s+(effort|actual|cost)$/iu);
  if (earlyCrossFieldMatch) {
    const field1 = earlyCrossFieldMatch[1].toLowerCase() as 'effort' | 'actual' | 'cost';
    const rawOp = earlyCrossFieldMatch[2].toLowerCase();
    const field2 = earlyCrossFieldMatch[3].toLowerCase() as 'effort' | 'actual' | 'cost';
    return predicateFilter(line, (task) => {
      const valueFor = (field: 'effort' | 'actual' | 'cost'): number | undefined => {
        if (field === 'effort') return parseEffortMinutesForFilter(task.metadata.effort);
        if (field === 'actual') return parseEffortMinutesForFilter(task.metadata.actual);
        return task.metadata.cost;
      };
      const value1 = valueFor(field1);
      const value2 = valueFor(field2);
      if (value1 === undefined || value2 === undefined || !Number.isFinite(value1) || !Number.isFinite(value2)) return false;
      if (rawOp === '>' || rawOp === 'above' || rawOp === 'over' || rawOp === 'greater than') return value1 > value2;
      if (rawOp === '<' || rawOp === 'below' || rawOp === 'under' || rawOp === 'less than') return value1 < value2;
      if (rawOp === '>=') return value1 >= value2;
      if (rawOp === '<=') return value1 <= value2;
      return Math.abs(value1 - value2) < 0.01;
    });
  }

  // ── Effort / actual duration comparison filters: effort > 2h, actual < 30m, estimate > 1h ─
  // 'estimate' is an alias for 'effort' (PRD Task 7).
  const effortNumMatch = line.match(/^(?:effort|estimate)\s+(>|<|>=|<=|=|above|below|over|under|greater\s+than|less\s+than)\s+(.+)$/iu);
  if (effortNumMatch) {
    const op = effortNumMatch[1].toLowerCase();
    const durationStr = effortNumMatch[2].trim();
    const expectedMinutes = parseEffortMinutesForFilter(durationStr);
    if (!Number.isFinite(expectedMinutes)) throw new Error(`Could not parse duration value '${durationStr}' in effort filter.`);
    return predicateFilter(line, (task) => {
      const value = parseEffortMinutesForFilter(task.metadata.effort);
      if (!Number.isFinite(value)) return false;
      if (op === '>' || op === 'above' || op === 'over' || op === 'greater than') return value > expectedMinutes;
      if (op === '<' || op === 'below' || op === 'under' || op === 'less than') return value < expectedMinutes;
      if (op === '>=') return value >= expectedMinutes;
      if (op === '<=') return value <= expectedMinutes;
      if (op === '=') return Math.abs(value - expectedMinutes) < 0.01;
      return false;
    });
  }
  const actualNumMatch = line.match(/^actual\s+(>|<|>=|<=|=|above|below|over|under|greater\s+than|less\s+than)\s+(.+)$/iu);
  if (actualNumMatch) {
    const op = actualNumMatch[1].toLowerCase();
    const durationStr = actualNumMatch[2].trim();
    const expectedMinutes = parseEffortMinutesForFilter(durationStr);
    if (!Number.isFinite(expectedMinutes)) throw new Error(`Could not parse duration value '${durationStr}' in actual filter.`);
    return predicateFilter(line, (task) => {
      const value = parseEffortMinutesForFilter(task.metadata.actual);
      if (!Number.isFinite(value)) return false;
      if (op === '>' || op === 'above' || op === 'over' || op === 'greater than') return value > expectedMinutes;
      if (op === '<' || op === 'below' || op === 'under' || op === 'less than') return value < expectedMinutes;
      if (op === '>=') return value >= expectedMinutes;
      if (op === '<=') return value <= expectedMinutes;
      if (op === '=') return Math.abs(value - expectedMinutes) < 0.01;
      return false;
    });
  }

  const effortIncludesMatch = line.match(/^(?:effort|estimate)\s+(includes|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (effortIncludesMatch) {
    return textPropertyFilter(line, effortIncludesMatch[1], effortIncludesMatch[2], (task) => task.metadata.effort ?? '');
  }
  const actualIncludesMatch = line.match(/^actual\s+(includes|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (actualIncludesMatch) {
    return textPropertyFilter(line, actualIncludesMatch[1], actualIncludesMatch[2], (task) => task.metadata.actual ?? '');
  }
  const costMatch = line.match(/^cost\s+(is not|is|above|below|over|under|>=|<=|>|<)\s+([+-]?\d+(?:\.\d+)?)$/iu);
  if (costMatch) {
    const op = costMatch[1].toLowerCase();
    const expected = Number.parseFloat(costMatch[2]);
    return predicateFilter(line, (task) => {
      const value = task.metadata.cost;
      if (value === undefined) return false;
      if (op === 'is') return value === expected;
      if (op === 'is not') return value !== expected;
      if (op === 'above' || op === 'over' || op === '>') return value > expected;
      if (op === '>=') return value >= expected;
      if (op === '<=') return value <= expected;
      return value < expected;
    });
  }
  // ── Collaboration field filters ──
  if (lower === 'has assignee' || lower === 'assignee is set') return predicateFilter(line, (task) => Boolean(task.metadata.assignee));
  if (lower === 'has no assignee' || lower === 'assignee not set' || lower === 'assignee is not set') return predicateFilter(line, (task) => !task.metadata.assignee);
  if (lower === 'has reviewer' || lower === 'reviewer is set') return predicateFilter(line, (task) => Boolean(task.metadata.reviewer));
  if (lower === 'has no reviewer' || lower === 'reviewer not set' || lower === 'reviewer is not set') return predicateFilter(line, (task) => !task.metadata.reviewer);
  if (lower === 'has project' || lower === 'project is set') return predicateFilter(line, (task) => Boolean(task.metadata.project));
  if (lower === 'has no project' || lower === 'project not set' || lower === 'project is not set') return predicateFilter(line, (task) => !task.metadata.project);
  if (lower === 'has team' || lower === 'team is set') return predicateFilter(line, (task) => Boolean(task.metadata.team));
  if (lower === 'has no team' || lower === 'team not set' || lower === 'team is not set') return predicateFilter(line, (task) => !task.metadata.team);

  const assigneeMatch = line.match(/^assignee\s+(is|is not|includes|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (assigneeMatch) {
    return textPropertyFilter(line, assigneeMatch[1], assigneeMatch[2], (task) => task.metadata.assignee ?? '');
  }
  
  const reviewerMatch = line.match(/^reviewer\s+(is|is not|includes|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (reviewerMatch) {
    return textPropertyFilter(line, reviewerMatch[1], reviewerMatch[2], (task) => task.metadata.reviewer ?? '');
  }
  
  const projectMatch = line.match(/^project\s+(is|is not|includes|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (projectMatch) {
    return textPropertyFilter(line, projectMatch[1], projectMatch[2], (task) => task.metadata.project ?? '');
  }
  
  const teamMatch = line.match(/^team\s+(is|is not|includes|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (teamMatch) {
    return textPropertyFilter(line, teamMatch[1], teamMatch[2], (task) => task.metadata.team ?? '');
  }
  
  // -- Variance filters (variance = |actual - effort| / effort) --
  const varianceMatch = line.match(/^variance\s+(>|<|>=|<=|=)\s+(\d+(?:\.\d+)?)%?$/iu);
  if (varianceMatch) {
    const op = varianceMatch[1];
    const percentThreshold = Number.parseFloat(varianceMatch[2]);
    return predicateFilter(line, (task) => {
      const effort = parseEffortMinutesForFilter(task.metadata.effort);
      const actual = parseEffortMinutesForFilter(task.metadata.actual);
      
      if (!Number.isFinite(effort) || !Number.isFinite(actual) || effort === 0) return false;
      
      const variance = Math.abs(actual - effort) / effort * 100;
      
      if (op === '>') return variance > percentThreshold;
      if (op === '<') return variance < percentThreshold;
      if (op === '>=') return variance >= percentThreshold;
      if (op === '<=') return variance <= percentThreshold;
      if (op === '=') return Math.abs(variance - percentThreshold) < 0.01;
      return false;
    });
  }

  // ── Context filters ──────────────────────────────────────────────────────
  if (lower === 'has context' || lower === 'has contexts') return predicateFilter(line, (task) => task.contexts.length > 0);
  if (lower === 'has no context' || lower === 'has no contexts') return predicateFilter(line, (task) => task.contexts.length === 0);
  const contextIncludesMatch = line.match(/^context(?:s)?\s+(includes|does not include|regex matches|regex does not match)\s+(.+)$/iu);
  if (contextIncludesMatch) {
    return textPropertyFilter(line, contextIncludesMatch[1], contextIncludesMatch[2], (task) => task.contexts.map((context) => context.startsWith('@') ? context : `@${context}`).join(' '));
  }

  // ── Follow-up watch date filters ─────────────────────────────────────────
  if (lower === 'has follow-up' || lower === 'has follow up' || lower === 'follow-up exists' || lower === 'follow up exists' || lower === 'follow-up present' || lower === 'follow up present')
    return predicateFilter(line, (task) => Boolean(task.metadata.followUp));
  if (lower === 'no follow-up' || lower === 'no follow up' || lower === 'does not have follow-up' || lower === 'does not have follow up' || lower === 'follow-up missing' || lower === 'follow up missing' || lower === 'follow-up absent' || lower === 'follow up absent')
    return predicateFilter(line, (task) => !task.metadata.followUp);
  const followUpDateMatch = line.match(/^follow[- ]up\s+(on\s+or\s+before|on\s+or\s+after|in\s+or\s+before|in\s+or\s+after|before|after|on|in)?\s*(.+)$/iu);
  if (followUpDateMatch) {
    const operator = normalizeDateOperator(followUpDateMatch[1] || (looksLikeRange(followUpDateMatch[2]) ? 'in' : 'on'));
    const range = normalizeDateRangeValue(followUpDateMatch[2]);
    return predicateFilter(line, (task, context) => {
      const followUp = task.metadata.followUp;
      if (!followUp) return false;
      return matchesDateFilter(followUp.slice(0, 10), operator, range, context.today);
    });
  }

  throw new Error(`Could not parse filter '${line}'.`);
}

function parseDatePresenceFilter(line: string): TaskFilter | null {
  const match = line.match(/^(no|has)\s+(due|scheduled|start|starts|done|completed|completion|created|cancelled|canceled|reminder|happens)\s+(?:date)?$/iu)
    ?? line.match(/^(due|scheduled|start|starts|done|completed|completion|created|cancelled|canceled|reminder|happens)\s+(exists|present|missing|absent)$/iu);
  if (!match) return null;
  const hasStyle = match[1].toLowerCase() === 'no' || match[1].toLowerCase() === 'has';
  const field = normalizeDateField(hasStyle ? match[2] : match[1]);
  const present = hasStyle ? match[1].toLowerCase() === 'has' : isPresenceWord(match[2]);
  return predicateFilter(line, (task) => getRawDateValues(task, field).length > 0 === present);
}

function parseDateFilter(line: string): TaskFilter | null {
  if (containsUnexpandedTemplateText(line)) {
    throw new Error(`Instruction contains unexpanded template text: "${line}" - and cannot be interpreted.`);
  }
  const invalidMatch = line.match(/^(due|scheduled|start|starts|done|completed|completion|created|cancelled|canceled|reminder)\s+date\s+is\s+invalid$/iu);
  if (invalidMatch) {
    const field = normalizeDateField(invalidMatch[1]);
    return predicateFilter(line, (task) => getRawDateValues(task, field).some((date) => !isValidDateValue(date, field)));
  }
  const match = line.match(/^(due|scheduled|start|starts|done|completed|completion|created|cancelled|canceled|reminder|happens)\s+(on\s+or\s+before|on\s+or\s+after|in\s+or\s+before|in\s+or\s+after|before|after|on|in)?\s*(.+)$/iu);
  if (!match) return null;
  const field = normalizeDateField(match[1]);
  const operator = normalizeDateOperator(match[2] || (looksLikeRange(match[3]) ? 'in' : 'on'));
  const range = normalizeDateRangeValue(match[3]);
  return predicateFilter(line, (task, context) => {
    const values = getDateValues(task, field);
    if (field === 'start' && values.length === 0 && startDateFilterMatchesUndated(operator)) return true;
    return values.some((date) => matchesDateFilter(date, operator, range, context.today));
  });
}

function matchesExpression(task: MarkdownTask, expression: TaskQueryExpression, context: TaskFilterContext): boolean {
  switch (expression.type) {
    case 'filter':
      return expression.filter.predicate(task, context);
    case 'and':
      return expression.children.every((child) => matchesExpression(task, child, context));
    case 'or':
      return expression.children.some((child) => matchesExpression(task, child, context));
    case 'xor':
      return expression.children.reduce((value, child) => value !== matchesExpression(task, child, context), false);
    case 'not':
      return !matchesExpression(task, expression.child, context);
  }
}

function predicateFilter(description: string, predicate: TaskFilter['predicate']): TaskFilter {
  return { type: 'predicate', description, predicate };
}

function textPropertyFilter(raw: string, operator: string, expectedRaw: string, getter: (task: MarkdownTask, context: TaskFilterContext) => string): TaskFilter {
  const expected = unquote(expectedRaw.trim());
  const op = operator.toLowerCase();
  return predicateFilter(raw, (task, context) => {
    const value = getter(task, context);
    if (op === 'is') return value.toLowerCase() === expected.toLowerCase();
    if (op === 'is not') return value.toLowerCase() !== expected.toLowerCase();
    if (op === 'regex matches') return makeRegex(expected).test(value);
    if (op === 'regex does not match') return !makeRegex(expected).test(value);
    const includes = value.toLowerCase().includes(expected.toLowerCase());
    return (op === 'does not include' || op === 'do not include') ? !includes : includes;
  });
}

function tagPropertyFilter(raw: string, operator: string, expectedRaw: string): TaskFilter {
  const op = operator.toLowerCase();
  const expected = unquote(expectedRaw.trim()).replace(/^#/u, '').toLowerCase();
  return predicateFilter(raw, (task) => {
    if (op === 'regex matches' || op === 'regex does not match') {
      const value = task.tags.map((tag) => `#${tag}`).join(' ');
      const matches = makeRegex(expectedRaw.trim()).test(value);
      return op === 'regex does not match' ? !matches : matches;
    }
    const includes = task.tags.some((tag) => {
      const normalized = tag.toLowerCase();
      return normalized === expected || normalized.startsWith(`${expected}/`);
    });
    return (op === 'does not include' || op === 'do not include') ? !includes : includes;
  });
}

function startDateFilterMatchesUndated(operator: DateOperator): boolean {
  return operator === 'before' || operator === 'on-or-before' || operator === 'in-or-before';
}

function matchesDateFilter(taskDate: string, operator: DateOperator, rawValue: string, today: string): boolean {
  const range = resolveDateRange(rawValue, today);
  switch (operator) {
    case 'before': return taskDate < range.start;
    case 'on': return taskDate >= range.start && taskDate <= range.end;
    case 'after': return taskDate > range.end;
    case 'on-or-before':
    case 'in-or-before': return taskDate <= range.end;
    case 'on-or-after':
    case 'in-or-after': return taskDate >= range.start;
    case 'in': return taskDate >= range.start && taskDate <= range.end;
  }
}

function compareByField(left: MarkdownTask, right: MarkdownTask, criterion: SortCriterion, today: string, states: readonly TaskStateDefinition[], baseContext?: Partial<TaskFilterContext>): number {
  if (criterion.functionExpression) {
    const context: TaskFilterContext = { ...baseContext, today, allTasks: baseContext?.allTasks ?? [left, right], states };
    return compareDynamicValues(
      evaluateTaskExpression(criterion.functionExpression, left, context),
      evaluateTaskExpression(criterion.functionExpression, right, context),
    );
  }
  const field = criterion.field;
  switch (field) {
    case 'smart':
    case 'urgency': {
      const scores = baseContext?._urgencyScores;
      return (scores?.get(right) ?? calculateUrgency(right, today, baseContext))
        - (scores?.get(left) ?? calculateUrgency(left, today, baseContext));
    }
    case 'status': return stateOrder(left, states) - stateOrder(right, states);
    case 'status.name': return naturalCompare(statusName(left, states), statusName(right, states));
    case 'status.type': return statusTypeOrder(left.status) - statusTypeOrder(right.status);
    case 'status.symbol': return naturalCompare(left.checkbox, right.checkbox);
    case 'next-status.symbol': return nextStatusSymbol(left, states).localeCompare(nextStatusSymbol(right, states));
    case 'id': return naturalCompare(left.metadata.id ?? '', right.metadata.id ?? '');
    case 'due': return compareDateStrings(left.metadata.dates.due, right.metadata.dates.due);
    case 'scheduled': return compareDateStrings(left.metadata.dates.scheduled, right.metadata.dates.scheduled);
    case 'start': return compareDateStrings(left.metadata.dates.start, right.metadata.dates.start);
    case 'done': return compareDateStrings(left.metadata.dates.done, right.metadata.dates.done);
    case 'created': return compareDateStrings(left.metadata.dates.created, right.metadata.dates.created);
    case 'cancelled': return compareDateStrings(left.metadata.dates.cancelled, right.metadata.dates.cancelled);
    case 'reminder': return compareOptionalStrings(left.metadata.reminder, right.metadata.reminder);
    case 'follow-up': return compareOptionalStrings(left.metadata.followUp, right.metadata.followUp);
    case 'happens': return compareDateStrings(firstHappensDate(left), firstHappensDate(right));
    case 'description': return naturalCompare(left.normalizedText, right.normalizedText);
    case 'description-without-tags': return naturalCompare(stripTags(left.normalizedText), stripTags(right.normalizedText));
    case 'priority': {
      if (baseContext?.customPriorities?.length) {
        return customPriorityWeight(left, baseContext.customPriorities) - customPriorityWeight(right, baseContext.customPriorities);
      }
      return PRIORITY_ORDER[left.metadata.priority] - PRIORITY_ORDER[right.metadata.priority];
    }
    case 'effort': return parseEffortMinutes(left.metadata.effort) - parseEffortMinutes(right.metadata.effort);
    case 'actual': return parseEffortMinutes(left.metadata.actual) - parseEffortMinutes(right.metadata.actual);
    case 'cost': return (left.metadata.cost ?? Number.POSITIVE_INFINITY) - (right.metadata.cost ?? Number.POSITIVE_INFINITY);
    case 'pinned': return Number(Boolean(right.metadata.pinned)) - Number(Boolean(left.metadata.pinned));
    case 'context': return naturalCompare(left.contexts.join(','), right.contexts.join(','));
    case 'dependency-order': {
      // Blocking tasks (depended on by others) sort first; dependent tasks sort last.
      // Ambiguous IDs never participate in either relationship bucket.
      const allTasks = baseContext?.allTasks ?? [left, right];
      const explicitIds = baseContext?._explicitIds ?? new ExplicitIdIndex(allTasks);
      const leftId = left.metadata.id?.trim();
      const rightId = right.metadata.id?.trim();
      const leftIsBlocking = Boolean(leftId && explicitIds.unique(leftId) === left
        && (baseContext?._dependsOnIndex
          ? (baseContext._dependsOnIndex.get(leftId)?.length ?? 0) > 0
          : allTasks.some((t) => t !== left && t.status !== 'done' && t.status !== 'cancelled' && t.metadata.dependsOn.includes(leftId))));
      const rightIsBlocking = Boolean(rightId && explicitIds.unique(rightId) === right
        && (baseContext?._dependsOnIndex
          ? (baseContext._dependsOnIndex.get(rightId)?.length ?? 0) > 0
          : allTasks.some((t) => t !== right && t.status !== 'done' && t.status !== 'cancelled' && t.metadata.dependsOn.includes(rightId))));
      const leftHasDeps = left.metadata.dependsOn.some((id) => Boolean(explicitIds.unique(id)));
      const rightHasDeps = right.metadata.dependsOn.some((id) => Boolean(explicitIds.unique(id)));
      if (leftIsBlocking !== rightIsBlocking) return leftIsBlocking ? -1 : 1;
      if (leftHasDeps !== rightHasDeps) return leftHasDeps ? 1 : -1;
      return 0;
    }
    case 'recurring': return Number(!left.metadata.recurrence) - Number(!right.metadata.recurrence);
    case 'recurrence': return compareOptionalStrings(left.metadata.recurrence, right.metadata.recurrence);
    case 'on-completion': return compareOptionalStrings(left.metadata.onCompletion, right.metadata.onCompletion);
    case 'depends-on': return compareOptionalStrings(left.metadata.dependsOn.join(','), right.metadata.dependsOn.join(','));
    case 'tag':
    case 'tags': return naturalCompare(tagAt(left, criterion.tagIndex ?? 1), tagAt(right, criterion.tagIndex ?? 1));
    case 'original-markdown': return naturalCompare(left.rawLine, right.rawLine);
    case 'line-number': return left.lineNumber - right.lineNumber;
    case 'random': return randomSortKey(left, today) - randomSortKey(right, today);
    case 'path': return naturalCompare(left.filePath, right.filePath) || left.lineNumber - right.lineNumber;
    case 'root': return naturalCompare(fileProperty(left, 'root'), fileProperty(right, 'root'));
    case 'folder': return naturalCompare(fileProperty(left, 'folder'), fileProperty(right, 'folder'));
    case 'filename': return naturalCompare(fileProperty(left, 'filename'), fileProperty(right, 'filename'));
    case 'heading': return naturalCompare(left.heading ?? '', right.heading ?? '');
    case 'backlink': return naturalCompare(backlinkText(left), backlinkText(right));
    case 'assignee': return compareOptionalStrings(left.metadata.assignee, right.metadata.assignee);
    case 'reviewer': return compareOptionalStrings(left.metadata.reviewer, right.metadata.reviewer);
    case 'project': return compareOptionalStrings(left.metadata.project, right.metadata.project);
    case 'team': return compareOptionalStrings(left.metadata.team, right.metadata.team);
    case 'series':
    case 'recurrence-series': return compareOptionalStrings(left.metadata.recurrenceSeriesId, right.metadata.recurrenceSeriesId);
    default: return 0;
  }
}

function groupKeys(task: MarkdownTask, field: SortField, today: string, states: readonly TaskStateDefinition[], expression?: string, baseContext?: Partial<TaskFilterContext>, tagIndex?: number): string[] {
  if (expression) {
    const value = evaluateTaskExpression(expression, task, { ...baseContext, today, allTasks: baseContext?.allTasks ?? [task], states });
    if (Array.isArray(value)) return value.length ? value.map((entry) => safeStr(entry) || '(No value)') : ['(No value)'];
    return [safeStr(value) || '(No value)'];
  }
  if (field === 'tag' || field === 'tags') {
    if (typeof tagIndex === 'number') {
      const tag = task.tags[tagIndex - 1];
      return [tag ? `#${tag}` : '(No tags)'];
    }
    return task.tags.length ? task.tags.map((tag) => `#${tag}`) : ['(No tags)'];
  }
  return [groupKey(task, field, today, states, baseContext)];
}

function groupKey(task: MarkdownTask, field: SortField, today: string, states: readonly TaskStateDefinition[], baseContext?: Partial<TaskFilterContext>): string {
  switch (field) {
    case 'smart':
    case 'urgency': return urgencyGroupText(baseContext?._urgencyScores?.get(task) ?? calculateUrgency(task, today, baseContext));
    case 'status': return isDoneLike(task.status) ? 'Done' : 'Todo';
    case 'status.name': return statusName(task, states);
    case 'status.type': return statusTypeGroupText(task.status);
    case 'status.symbol': return task.checkbox;
    case 'next-status.symbol': return nextStatusSymbol(task, states);
    case 'id': return task.metadata.id || '(No id)';
    case 'due': return dateGroupText(task.metadata.dates.due, 'due');
    case 'scheduled': return dateGroupText(task.metadata.dates.scheduled, 'scheduled');
    case 'start': return dateGroupText(task.metadata.dates.start, 'start');
    case 'done': return dateGroupText(task.metadata.dates.done, 'done');
    case 'created': return dateGroupText(task.metadata.dates.created, 'created');
    case 'cancelled': return dateGroupText(task.metadata.dates.cancelled, 'cancelled');
    case 'reminder': return dateGroupText(task.metadata.reminder, 'reminder');
    case 'follow-up': return dateGroupText(task.metadata.followUp, 'follow-up');
    case 'happens': return firstHappensDate(task) ? dateGroupText(firstHappensDate(task), 'happens') : 'No happens date';
    case 'description': return task.normalizedText;
    case 'description-without-tags': return stripTags(task.normalizedText);
    case 'priority': return priorityGroupText(task.metadata.priority);
    case 'recurring': return task.metadata.recurrence ? 'Recurring' : 'Not recurring';
    case 'recurrence': return task.metadata.recurrence || 'None';
    case 'on-completion': return task.metadata.onCompletion || '(No on completion)';
    case 'depends-on': return task.metadata.dependsOn.length ? task.metadata.dependsOn.join(', ') : '(No depends on)';
    case 'tag':
    case 'tags': return task.tags.length ? task.tags.map((tag) => `#${tag}`).join(', ') : '(No tags)';
    case 'original-markdown': return task.rawLine;
    case 'line-number': return String(task.lineNumber);
    case 'random': return String(randomSortKey(task, today));
    // Mirror upstream grouping display values:
    //  - path strips the .md extension (PathField.grouper)
    //  - filename wraps in a wikilink (FilenameField.grouper)
    //  - backlink wraps in a wikilink, optionally with heading anchor (BacklinkField.grouper)
    case 'path': return task.filePath.replace(/\.md$/iu, '');
    case 'root': return fileProperty(task, 'root');
    case 'folder': return fileProperty(task, 'folder');
    case 'filename': {
      const filename = fileProperty(task, 'filename').replace(/\.md$/iu, '');
      return filename ? `[[${filename}]]` : 'Unknown Location';
    }
    case 'heading': return task.heading || '(No heading)';
    case 'backlink': {
      const filename = fileProperty(task, 'filename').replace(/\.md$/iu, '');
      if (!filename) return 'Unknown Location';
      const header = task.heading;
      if (!header || header === filename) return `[[${filename}]]`;
      return `[[${filename}#${header}|${filename} > ${header}]]`;
    }
    case 'effort': return task.metadata.effort ?? '(No effort)';
    case 'actual': return task.metadata.actual ?? '(No actual)';
    case 'cost': return task.metadata.cost === undefined ? '(No cost)' : String(task.metadata.cost);
    case 'pinned': return task.metadata.pinned ? 'Pinned' : 'Not pinned';
    case 'context': return task.contexts.length > 0 ? task.contexts.map((c) => `@${c}`).join(', ') : '(No context)';
    case 'dependency-order': {
      if (task.metadata.dependsOn.length > 0) return 'Has dependencies';
      return '(No dependencies)';
    }
    case 'assignee': return task.metadata.assignee ? `@${task.metadata.assignee}` : '(No assignee)';
    case 'reviewer': return task.metadata.reviewer ? `@${task.metadata.reviewer}` : '(No reviewer)';
    case 'project': return task.metadata.project || '(No project)';
    case 'team': return task.metadata.team || '(No team)';
    case 'series':
    case 'recurrence-series': return task.metadata.recurrenceSeriesId || '(No series)';
    default: return '(Unknown)';
  }
}

function parseSortCriteria(value: string, lineNumber: number, enableQueryDsl: boolean): SortCriterion[] {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  const functionMatch = normalized.match(/^function\s+(reverse\s+)?(.+)$/iu);
  if (functionMatch) {
    if (!enableQueryDsl) {
      throw new Error("Function expressions are disabled. Enable 'Enable function expressions' in Task Manager settings to use 'sort by function'.");
    }
    return [{ field: 'description', reverse: Boolean(functionMatch[1]), functionExpression: functionMatch[2].trim() }];
  }
  const reverse = /\s+reverse$/iu.test(normalized);
  const withoutReverse = normalized.replace(/\s+reverse$/iu, '').trim();
  const simpleParts = withoutReverse.split(/[\s,]+/u).filter(Boolean);
  if (simpleParts.length > 1 && simpleParts.every((part) => isSortFieldAlias(part))) {
    return simpleParts.map((part) => ({ field: normalizeSortField(part, lineNumber), reverse }));
  }
  const tagMatch = withoutReverse.match(/^tags?\s+(\d+)$/iu);
  if (tagMatch) {
    const tagIndex = Number.parseInt(tagMatch[1], 10);
    return [{ field: 'tag', reverse, tagIndex: tagIndex >= 1 ? tagIndex : 1 }];
  }
  return [{ field: normalizeSortField(withoutReverse, lineNumber), reverse }];
}

function parseGroupCriterion(value: string, lineNumber: number, enableQueryDsl: boolean): GroupCriterion {
  let normalized = value.trim().replace(/\s+/gu, ' ');
  const functionMatch = normalized.match(/^function\s+(.+)$/iu);
  if (functionMatch) {
    if (!enableQueryDsl) {
      throw new Error("Function expressions are disabled. Enable 'Enable function expressions' in Task Manager settings to use 'group by function'.");
    }
    return { field: 'description', functionExpression: functionMatch[1].trim() };
  }
  const reverse = /\s+reverse$/iu.test(normalized);
  normalized = normalized.replace(/\s+reverse$/iu, '').trim();
  const limitMatch = normalized.match(/^(.*?)\s+limit\s+(\d+)$/iu);
  const limit = limitMatch ? Number.parseInt(limitMatch[2], 10) : undefined;
  if (limitMatch) normalized = limitMatch[1].trim();
  const tagIndexMatch = normalized.match(/^(tags?)\s+(\d+)$/iu);
  if (tagIndexMatch) {
    const tagIndex = Number.parseInt(tagIndexMatch[2], 10);
    return { field: 'tag', reverse, limit, tagIndex: tagIndex >= 1 ? tagIndex : 1 };
  }
  return { field: normalizeSortField(normalized, lineNumber), reverse, limit };
}

function normalizeSortField(value: string, lineNumber: number): SortField {
  const normalized = value.toLowerCase().replace(/_/gu, '-').trim();
  const field = SORT_FIELD_ALIASES[normalized];
  if (!field) {
    throw new Error(`Unsupported sort field on line ${lineNumber}: ${value}. Supported sort fields: ${SUPPORTED_SORT_FIELDS.join(', ')}.`);
  }
  return field;
}

function isSortFieldAlias(value: string): boolean {
  return Boolean(SORT_FIELD_ALIASES[value.toLowerCase().replace(/_/gu, '-').trim()]);
}

function collectFilters(expression: TaskQueryExpression): TaskFilter[] {
  switch (expression.type) {
    case 'filter': return [expression.filter];
    case 'and':
    case 'or':
    case 'xor': return expression.children.flatMap((child) => collectFilters(child));
    case 'not': return collectFilters(expression.child);
  }
}

function combineExpressions(type: 'and' | 'or' | 'xor', children: TaskQueryExpression[]): TaskQueryExpression | undefined {
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return { type, children };
}

function applyLineContinuations(source: string): string {
  // Mirror upstream Tasks plugin: a trailing single backslash continues the line
  // (replaced with a space), but a doubled trailing backslash (`\\`) is treated as
  // an escaped literal backslash and does NOT continue the line.
  // Process line-by-line so we can distinguish '\\' (escape) from '\' (continuation).
  const lines = source.split(/\r?\n/u);
  const out: string[] = [];
  let buffer = '';
  let continuing = false;
  for (const line of lines) {
    const adjusted = continuing ? line.replace(/^[ \t]+/u, '') : line;
    if (/\\\\$/u.test(adjusted)) {
      // Trailing '\\' is an escaped backslash – keep as single backslash, end the line normally.
      const literal = adjusted.slice(0, -1);
      buffer = continuing ? `${buffer} ${literal}` : literal;
      out.push(buffer);
      buffer = '';
      continuing = false;
      continue;
    }
    if (/\\$/u.test(adjusted)) {
      const trimmed = adjusted.replace(/[ \t]*\\$/u, '');
      buffer = continuing ? `${buffer} ${trimmed}` : trimmed;
      continuing = true;
      continue;
    }
    if (continuing) {
      out.push(`${buffer} ${adjusted}`);
      buffer = '';
      continuing = false;
    } else {
      out.push(adjusted);
    }
  }
  if (continuing && buffer) out.push(buffer);
  return out.join('\n');
}

function expandQueryMacros(source: string, options: TaskQueryOptions): string {
  const withoutInlineComments = stripMustacheInlineComments(source);
  const macroMap = new Map<string, string>();
  for (const query of options.savedQueries ?? []) {
    macroMap.set(normalizeMacroName(query.name), query.query);
  }

  // Recursive preset expansion with cycle detection (mirrors upstream Query.parsePreset which
  // calls back into the line parser per preset instruction, naturally allowing nested presets).
  const expandPresetLines = (input: string, stack: ReadonlySet<string>): string =>
    input.split(/\r?\n/u).flatMap((line) => {
      const match = line.trim().match(/^preset\s+(.+)$/iu);
      if (!match) return [line];
      const presetName = normalizeMacroName(match[1]);
      if (stack.has(presetName)) {
        return [`# Cannot expand preset "${match[1].trim()}": cyclic preset reference detected (${[...stack, presetName].join(' → ')}).`];
      }
      const preset = macroMap.get(presetName);
      if (preset === undefined) return presetHelpLines(match[1], macroMap);
      return expandPresetLines(preset, new Set([...stack, presetName])).split(/\r?\n/u);
    }).join('\n');

  const withPresetLines = expandPresetLines(withoutInlineComments, new Set());

  // {{...}} placeholders. Resolve recursively (with cycle detection) so that a preset placeholder
  // can itself yield further placeholders / presets.
  const expandPlaceholdersRecursive = (input: string, stack: ReadonlySet<string>): string =>
    input.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (match, rawExpression: string) => {
      const expression = rawExpression.trim();
      const preset = expression.match(/^preset\.([A-Za-z0-9 _-]+)$/iu);
      if (preset) {
        const presetName = normalizeMacroName(preset[1]);
        if (stack.has(presetName)) {
          return `# Cyclic preset placeholder: ${[...stack, presetName].join(' → ')}`;
        }
        const value = macroMap.get(presetName);
        if (value === undefined) return '';
        const newStack = new Set([...stack, presetName]);
        return expandPlaceholdersRecursive(expandPresetLines(value, newStack), newStack);
      }

      const queryFileProperty = expression.match(/^query\.file\.property\((['"])(.+?)\1\)$/iu)
        ?? expression.match(/^query\.file\.property\.([A-Za-z0-9 _-]+)$/iu);
      if (queryFileProperty) {
        const name = queryFileProperty[2] ?? queryFileProperty[1];
        return stringifyPropertyValue(getFileProperty(options, name));
      }

      const queryFileHasProperty = expression.match(/^query\.file\.hasProperty\((['"])(.+?)\1\)$/iu);
      if (queryFileHasProperty) {
        const _hpProps = options.fileInfoProvider?.(options.sourcePath ?? '')?.properties ?? {};
        const _hpName = queryFileHasProperty[2].toLowerCase();
        return String(Object.keys(_hpProps).some((k) => k.toLowerCase() === _hpName));
      }

      const queryFile = expression.match(/^query\.file\.(pathWithoutExtension|path|folder|root|filenameWithoutExtension|filename)$/u);
      if (queryFile) return queryFilePlaceholder(queryFile[1], options.sourcePath ?? '');

      if (/^(date|time)\b/iu.test(expression)) return match;
      throw new Error(`Unknown query placeholder: {{${expression}}}`);
    });

  return expandPlaceholdersRecursive(withPresetLines, new Set());
}

function stripMustacheInlineComments(source: string): string {
  return source.replace(/\{\{!([\s\S]*?)\}\}/gu, '');
}

function getFileProperty(options: TaskQueryOptions, name: string): unknown {
  const properties = options.fileInfoProvider?.(options.sourcePath ?? '')?.properties ?? {};
  if (Object.prototype.hasOwnProperty.call(properties, name)) return properties[name];
  const normalized = name.toLowerCase();
  const matchingKey = Object.keys(properties).find((key) => key.toLowerCase() === normalized);
  return matchingKey ? properties[matchingKey] : undefined;
}

function stringifyPropertyValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(stringifyPropertyValue).filter(Boolean).join(', ');
  if (value === null || value === undefined) return '';
  return safeStr(value);
}

function normalizeMacroName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, '_');
}

function presetHelpLines(name: string, macroMap: ReadonlyMap<string, string>): string[] {
  const lines = [`# Cannot find preset "${name.trim()}" in the Tasks settings`, '# The following presets are defined in the Tasks settings:'];
  for (const [presetName, query] of Array.from(macroMap.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const firstLine = query.split(/\r?\n/u).find((line) => line.trim()) ?? '';
    lines.push(`#   ${presetName.padEnd(20)}: ${firstLine.slice(0, 60)}`);
  }
  return lines;
}

function stripGlobalFilter(description: string, globalFilter: string | undefined): string {
  const filter = globalFilter?.trim();
  if (!filter) return description;
  const pattern = new RegExp(String.raw`(?:^|\s)${escapeRegExp(filter)}(?=\s|$)`, 'iu');
  return description.replace(pattern, ' ').replace(/\s+/gu, ' ').trim();
}

function queryFilePlaceholder(property: string, path: string): string {
  const filename = path.split('/').pop() ?? path;
  const folder = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/') + 1)}` : '/';
  const root = path.includes('/') ? `${path.slice(0, path.indexOf('/') + 1)}` : '/';
  switch (property) {
    case 'pathWithoutExtension': return path.replace(/\.md$/iu, '');
    case 'path': return path;
    case 'folder': return folder;
    case 'root': return root;
    case 'filenameWithoutExtension': return filename.replace(/\.md$/iu, '');
    case 'filename': return filename;
    default: return '';
  }
}

function stripComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let inRegex = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (inRegex) {
      if (char === '/') inRegex = false;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '/' && /(?:^|\s)(?:regex\s+(?:matches|does\s+not\s+match)|function)\s+/iu.test(line.slice(0, index))) { inRegex = true; continue; }
    if (char === '#' && (index === 0 || (/\s/u.test(line[index - 1]) && (index + 1 >= line.length || /\s/u.test(line[index + 1]))))) {
      return line.slice(0, index);
    }
  }
  return line;
}

// Upstream layout-instruction names (TaskLayoutOptions + QueryLayoutOptions).
// We map a few common synonyms to the canonical names used internally by the renderer
// (e.g. 'postpone button' → 'defer button', the bare 'recurrence' alias → 'recurrence rule').

function normalizeLayoutElement(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
    .replace(/^postpone button$/u, 'defer button')
    .replace(/^backlinks$/u, 'backlink')
    .replace(/^recurrence$/u, 'recurrence rule')
    .replace(/^follow up date$/u, 'follow-up date');
}

function normalizeDateField(value: string): DateField {
  const normalized = value.toLowerCase();
  if (normalized === 'completed' || normalized === 'completion') return 'done';
  if (normalized === 'starts') return 'start';
  if (normalized === 'canceled') return 'cancelled';
  if (normalized === 'follow up') return 'follow-up';
  return normalized as DateField;
}

function normalizeDateOperator(value: string): DateOperator {
  return value.toLowerCase().replace(/\s+/gu, '-') as DateOperator;
}

function normalizeDateRangeValue(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function looksLikeRange(value: string): boolean {
  return /\b(week|month|quarter|year)\b/iu.test(value) || /^\d{4}-(?:w\d{2}|q\d|\d{2})$/iu.test(value) || /^\d{4}$/u.test(value) || /^\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}$/u.test(value);
}

function resolveDateRange(rawValue: string, today: string): { start: string; end: string } {
  const value = rawValue.toLowerCase().trim();
  if (value === 'today') return { start: today, end: today };
  if (value === 'tomorrow') return singleDate(addDays(today, 1));
  if (value === 'yesterday') return singleDate(addDays(today, -1));
  if (/^\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const [start, end] = value.split(/\s+/u);
    if (!isValidIsoDate(start) || !isValidIsoDate(end) || start > end) return singleDate(value);
    return { start, end };
  }
  const relative = value.match(/^(last|this|next)\s+(week|month|quarter|year)$/u);
  if (relative) return relativeRange(relative[1], relative[2], today);
  const flexible = parseFlexibleDate(value, today);
  if (flexible) return singleDate(flexible);
  const week = value.match(/^(\d{4})-w(\d{2})$/iu);
  if (week) {
    const yearNumber = Number.parseInt(week[1], 10);
    const weekNumber = Number.parseInt(week[2], 10);
    if (!hasIsoWeek(yearNumber, weekNumber)) return singleDate(value);
    return isoWeekRange(yearNumber, weekNumber);
  }
  const month = value.match(/^(\d{4})-(\d{2})$/u);
  if (month) {
    const monthNumber = Number.parseInt(month[2], 10);
    if (monthNumber < 1 || monthNumber > 12) return singleDate(value);
    return monthRange(Number.parseInt(month[1], 10), monthNumber);
  }
  const quarter = value.match(/^(\d{4})-q([1-4])$/iu);
  if (quarter) return quarterRange(Number.parseInt(quarter[1], 10), Number.parseInt(quarter[2], 10));
  const year = value.match(/^(\d{4})$/u);
  if (year) return { start: `${year[1]}-01-01`, end: `${year[1]}-12-31` };
  return singleDate(value);
}

function singleDate(value: string): { start: string; end: string } { return { start: value, end: value }; }

function relativeRange(which: string, unit: string, today: string): { start: string; end: string } {
  const date = parseDateString(today);
  const offset = which === 'last' ? -1 : which === 'next' ? 1 : 0;
  if (unit === 'week') {
    const start = addDays(startOfWeek(today), offset * 7);
    return { start, end: addDays(start, 6) };
  }
  if (unit === 'month') return monthRange(date.getUTCFullYear(), date.getUTCMonth() + 1 + offset);
  if (unit === 'quarter') return quarterRange(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) + 1 + offset);
  return { start: `${date.getUTCFullYear() + offset}-01-01`, end: `${date.getUTCFullYear() + offset}-12-31` };
}

function monthRange(year: number, month: number): { start: string; end: string } {
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const start = formatDate(normalized);
  const end = formatDate(new Date(Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, 0)));
  return { start, end };
}

function quarterRange(year: number, quarter: number): { start: string; end: string } {
  const base = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  return { start: formatDate(base), end: formatDate(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 3, 0))) };
}

function isoWeekRange(year: number, week: number): { start: string; end: string } {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = addDaysToDate(jan4, -((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  return { start: formatDate(monday), end: formatDate(addDaysToDate(monday, 6)) };
}

function hasIsoWeek(year: number, week: number): boolean {
  if (week < 1 || week > 53) return false;
  if (week < 53) return true;
  const start = parseDateString(isoWeekRange(year, week).start);
  return addDaysToDate(start, 3).getUTCFullYear() === year;
}

function startOfWeek(value: string): string {
  const date = parseDateString(value);
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return formatDate(addDaysToDate(date, -daysSinceMonday));
}

function addDays(value: string, days: number): string { return addIsoDays(value, days); }
function addDaysToDate(date: Date, days: number): Date { const result = new Date(date.getTime()); result.setUTCDate(result.getUTCDate() + days); return result; }
function parseDateString(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!match) throw new Error(`Invalid date '${value}'.`);
  return new Date(Date.UTC(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10) - 1, Number.parseInt(match[3], 10)));
}

function isValidDateValue(value: string, field: DateField): boolean {
  if (field !== 'reminder') return isValidIsoDate(value);
  const reminderMatch = value.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/u);
  if (!reminderMatch || !isValidIsoDate(reminderMatch[1])) return false;
  if (reminderMatch[2] === undefined || reminderMatch[3] === undefined) return true;
  const hour = Number.parseInt(reminderMatch[2], 10);
  const minute = Number.parseInt(reminderMatch[3], 10);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60;
}

function parseFlexibleDate(value: string, today: string): string | null {
  const utilityParsed = resolveFlexibleDateFromUtils(value, today);
  if (utilityParsed) return utilityParsed;
  const todayDate = parseDateString(today);
  const relative = value.match(/^(?:in\s+)?(\d+)\s+(day|week|month|year)s?(?:\s+from\s+now)?$/u);
  if (relative) return formatDate(addDateUnit(todayDate, relative[2], Number.parseInt(relative[1], 10)));
  const ago = value.match(/^(\d+)\s+(day|week|month|year)s?\s+ago$/u);
  if (ago) return formatDate(addDateUnit(todayDate, ago[2], -Number.parseInt(ago[1], 10)));
  const weekday = value.match(/^(next|last)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/u);
  if (weekday) return relativeWeekday(todayDate, weekday[2], weekday[1] ?? 'closest');
  const monthDay = value.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/u)
    ?? value.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:,?\s+(\d{4}))?$/u);
  if (monthDay) {
    const firstIsMonth = Number.isNaN(Number.parseInt(monthDay[1], 10));
    const month = monthNumberName(firstIsMonth ? monthDay[1] : monthDay[2]);
    const day = Number.parseInt(firstIsMonth ? monthDay[2] : monthDay[1], 10);
    const year = Number.parseInt((firstIsMonth ? monthDay[3] : monthDay[3]) ?? String(todayDate.getUTCFullYear()), 10);
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
    return formatDate(date);
  }
  return null;
}

function addDateUnit(date: Date, unit: string, count: number): Date {
  const result = new Date(date.getTime());
  if (unit === 'day') result.setUTCDate(result.getUTCDate() + count);
  if (unit === 'week') result.setUTCDate(result.getUTCDate() + count * 7);
  if (unit === 'month') return addDateUnitMonthsClamped(date, count);
  if (unit === 'year') return addDateUnitMonthsClamped(date, count * 12);
  return result;
}

function addDateUnitMonthsClamped(date: Date, months: number): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

function relativeWeekday(today: Date, weekdayName: string, direction: string): string {
  const target = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(weekdayName);
  const current = today.getUTCDay();
  let delta = target - current;
  if (direction === 'next') delta = delta <= 0 ? delta + 7 : delta;
  else if (direction === 'last') delta = delta >= 0 ? delta - 7 : delta;
  else if (delta > 3) delta -= 7;
  else if (delta < -3) delta += 7;
  return formatDate(addDateUnit(today, 'day', delta));
}

function monthNumberName(name: string): number {
  return ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(name.toLowerCase());
}
function formatDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = `${value.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${value.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function diffDays(start: string, end: string): number { return Math.round((parseDateString(end).getTime() - parseDateString(start).getTime()) / 86_400_000); }

function getRawDateValues(task: MarkdownTask, field: DateField): string[] {
  if (field === 'happens') return [task.metadata.dates.start, task.metadata.dates.scheduled, task.metadata.dates.due].filter((date): date is string => Boolean(date)).sort();
  if (field === 'reminder') return task.metadata.reminder ? [task.metadata.reminder] : [];
  if (field === 'follow-up') return task.metadata.followUp ? [task.metadata.followUp] : [];
  const date = task.metadata.dates[field as keyof typeof task.metadata.dates];
  return date ? [date] : [];
}

function getDateValues(task: MarkdownTask, field: DateField): string[] {
  return getRawDateValues(task, field).filter((date) => isValidDateValue(date, field)).map((date) => field === 'reminder' ? date.slice(0, 10) : date);
}

function firstHappensDate(task: MarkdownTask): string | undefined { return getDateValues(task, 'happens')[0]; }

function isDoneLike(status: TaskStatus): boolean { return status === 'done' || status === 'cancelled' || status === 'untracked'; }
function closedTaskSortBucket(status: TaskStatus): number { return status === 'done' || status === 'cancelled' ? 1 : 0; }
function isActionable(status: TaskStatus): boolean { return status === 'todo' || status === 'in_progress' || status === 'blocked' || status === 'deferred'; }
function statusTypeOrder(status: TaskStatus): number {
  return ({ in_progress: 0, todo: 1, on_hold: 2, blocked: 2, deferred: 2, done: 3, cancelled: 4, untracked: 5 } as Record<TaskStatus, number>)[status] ?? 99;
}

function statusTypeGroupText(status: TaskStatus): string {
  return ({ in_progress: 'IN_PROGRESS', todo: 'TODO', on_hold: 'ON_HOLD', blocked: 'ON_HOLD', deferred: 'ON_HOLD', done: 'DONE', cancelled: 'CANCELLED', untracked: 'NON_TASK' } as Record<TaskStatus, string>)[status] ?? status.toUpperCase();
}

function statusTypeGroupTextWithSort(status: TaskStatus): string {
  return `%%${statusTypeOrder(status)}%%${statusTypeGroupText(status)}`;
}

function dateGroupText(value: string | undefined, field: DateField): string {
  const label = field === 'happens' ? 'happens' : field;
  if (!value) return `No ${label} date`;
  if (!isValidDateValue(value, field)) return `Invalid ${label} date`;
  const date = value.slice(0, 10);
  return `${date} ${weekdayName(date)}`;
}

function weekdayName(value: string): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][parseDateString(value).getUTCDay()] ?? '';
}

function priorityDisplayName(priority: TaskPriority): string {
  return ({ highest: 'Highest', high: 'High', medium: 'Medium', normal: 'Normal', low: 'Low', lowest: 'Lowest' } as Record<TaskPriority, string>)[priority];
}

function priorityGroupText(priority: TaskPriority): string {
  return `${priorityDisplayName(priority)} priority`;
}

function urgencyGroupText(urgency: number): string {
  if (!Number.isFinite(urgency)) return 'less than 1.0';
  if (urgency >= 9.0) return '9.0 or more';
  if (urgency < 1.0) return 'less than 1.0';
  const bucket = Math.floor(urgency);
  return `${bucket}.0 to ${bucket}.9`;
}

function urgencyGroupOrder(label: string): number {
  if (label === '9.0 or more') return 0;
  if (label === 'less than 1.0') return 9;
  const match = label.match(/^([1-8])\.0 to \1\.9$/u);
  if (match) return 9 - Number.parseInt(match[1], 10);
  return 99;
}

function priorityGroupTextWithSort(priority: TaskPriority): string {
  return `%%${PRIORITY_ORDER[priority]}%%${priorityGroupText(priority)}`;
}

function isTaskBlocked(task: MarkdownTask, allTasks: readonly MarkdownTask[], context?: TaskFilterContext): boolean {
  if (!isActionable(task.status)) return false;
  const actionableIds = context?._actionableIds;
  if (actionableIds) return task.metadata.dependsOn.some((id) => actionableIds.has(id));
  const explicitIds = context?._explicitIds ?? new ExplicitIdIndex(allTasks);
  return task.metadata.dependsOn.some((id) => {
    const candidate = explicitIds.unique(id);
    return Boolean(candidate && isActionable(candidate.status));
  });
}

function isTaskBlocking(task: MarkdownTask, allTasks: readonly MarkdownTask[], context?: TaskFilterContext): boolean {
  if (!task.metadata.id || !isActionable(task.status)) return false;
  const id = task.metadata.id.trim();
  const explicitIds = context?._explicitIds ?? new ExplicitIdIndex(allTasks);
  if (explicitIds.unique(id) !== task) return false;
  if (context?._dependsOnIndex) {
    const dependents = context._dependsOnIndex.get(id);
    return Boolean(dependents?.some((dependent) => isActionable(dependent.status)));
  }
  return allTasks.some((candidate) => candidate.metadata.dependsOn.includes(id) && isActionable(candidate.status));
}

function buildDependencyIndices(
  tasks: readonly MarkdownTask[],
  explicitIds = new ExplicitIdIndex(tasks),
): Pick<TaskFilterContext, '_actionableIds' | '_dependsOnIndex' | '_explicitIds'> {
  const actionableIds = new Set<string>();
  const dependsOnIndex = new Map<string, MarkdownTask[]>();
  for (const id of explicitIds.ids()) {
    const task = explicitIds.unique(id);
    if (task && isActionable(task.status)) actionableIds.add(id);
  }
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue;
    for (const depId of task.metadata.dependsOn) {
      if (!explicitIds.unique(depId)) continue;
      const existing = dependsOnIndex.get(depId);
      if (existing) existing.push(task);
      else dependsOnIndex.set(depId, [task]);
    }
  }
  return { _actionableIds: actionableIds, _dependsOnIndex: dependsOnIndex, _explicitIds: explicitIds };
}

function completeTaskContext(baseContext: Partial<TaskFilterContext> | undefined, tasks: readonly MarkdownTask[]): Partial<TaskFilterContext> {
  const allTasks = baseContext?.allTasks ?? tasks;
  const _expressionCache = baseContext?._expressionCache ?? { expressions: new Map(), tasks: new WeakMap(), files: new Map() };
  if (baseContext?._explicitIds && baseContext._actionableIds && baseContext._dependsOnIndex) {
    return { ...baseContext, allTasks, _expressionCache };
  }
  const indices = buildDependencyIndices(allTasks, baseContext?._explicitIds);
  return {
    ...baseContext,
    allTasks,
    _expressionCache,
    _explicitIds: baseContext?._explicitIds ?? indices._explicitIds,
    _actionableIds: baseContext?._actionableIds ?? indices._actionableIds,
    _dependsOnIndex: baseContext?._dependsOnIndex ?? indices._dependsOnIndex,
  };
}

function normalizeStatusTypes(value: string): TaskStatus[] {
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, '_');
  const statuses = STATUS_TYPE_ALIASES[normalized];
  if (!statuses) throw new Error(`Unsupported status type: ${value}`);
  return statuses;
}

function statusName(task: MarkdownTask, states: readonly TaskStateDefinition[]): string {
  return states.find((state) => state.rawText === task.checkbox)?.name ?? task.status;
}

function stateOrder(task: MarkdownTask, states: readonly TaskStateDefinition[]): number {
  const index = states.findIndex((state) => state.rawText === task.checkbox);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function nextStatusSymbol(task: MarkdownTask, states: readonly TaskStateDefinition[]): string {
  return nextTaskCheckbox(task.checkbox, states);
}

function fileProperty(task: MarkdownTask, property: string): string {
  const path = task.filePath;
  const filename = path.split('/').pop() ?? path;
  switch (property) {
    case 'path': return path;
    case 'root': return path.includes('/') ? `${path.slice(0, path.indexOf('/') + 1)}` : '/';
    case 'folder': return path.includes('/') ? `${path.slice(0, path.lastIndexOf('/') + 1)}` : '/';
    case 'filename': return filename;
    case 'heading': return task.heading ?? '';
    case 'backlink': return backlinkText(task);
    default: return path;
  }
}

function stripTags(value: string): string { return value.replace(/(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/gu, '$1').replace(/\s+/gu, ' ').trim(); }

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}
function tagAt(task: MarkdownTask, index: number): string { return task.tags[index - 1] ?? ''; }
function randomSortKey(task: MarkdownTask, today: string): number { return hashString(`${today}:${task.normalizedText}:${task.filePath}:${task.lineNumber}`); }
function hashString(value: string): number { let hash = 0; for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0; return hash >>> 0; }

function compareDynamicValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(right) - Number(left);
  return safeStr(left).localeCompare(safeStr(right));
}

function compareOptionalStrings(left: string | undefined, right: string | undefined): number {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function compareDateStrings(left: string | undefined, right: string | undefined): number {
  const leftValid = Boolean(left && isValidIsoDate(left));
  const rightValid = Boolean(right && isValidIsoDate(right));
  if (left && !leftValid && (!right || rightValid)) return -1;
  if (right && !rightValid && (!left || leftValid)) return 1;
  return compareOptionalStrings(left, right);
}

function backlinkText(task: MarkdownTask): string {
  const filename = fileProperty(task, 'filename').replace(/\.md$/iu, '');
  return task.heading && task.heading !== filename ? `${filename} > ${task.heading}` : filename;
}

function isBooleanToken(value: string): boolean { const lower = value.toLowerCase(); return lower === 'and' || lower === 'or' || lower === 'xor'; }
function isPresenceWord(value: string): boolean { const lower = value.toLowerCase(); return lower === 'exists' || lower === 'present'; }
function normalizeMetadataField(value: string): 'recurrence' | 'id' | 'on-completion' {
  const normalized = value.toLowerCase().replace(/[\s_]+/gu, '-');
  if (normalized === 'id') return 'id';
  if (normalized === 'on-completion' || normalized === 'oncompletion') return 'on-completion';
  return 'recurrence';
}
function metadataFieldValue(task: MarkdownTask, field: 'recurrence' | 'id' | 'on-completion'): string {
  if (field === 'id') return task.metadata.id ?? '';
  if (field === 'on-completion') return task.metadata.onCompletion ?? '';
  return task.metadata.recurrence ?? '';
}
function parsePriority(value: string): TaskPriority {
  const normalized = unquote(value).trim().toLowerCase();
  const priority = PRIORITY_ALIASES[normalized];
  if (!priority) throw new Error(`Unsupported task priority: ${value}`);
  return priority;
}
function makeRegex(value: string): RegExp {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/(.*)\/([a-z]*)$/iu);
  const pattern = match ? match[1] : trimmed;
  const flags = match ? match[2].toLowerCase() : 'u';
  // Unicode-set string disjunctions (\q{...}) add a second nested grammar that
  // cannot be safely modeled by the lightweight scanner below.
  if (flags.includes('v')) throw new Error("Regex 'v' mode is not supported in task queries.");
  assertSafeUserRegexPattern(pattern);
  return new RegExp(pattern, flags);
}

function assertSafeUserRegexPattern(pattern: string): void {
  if (pattern.length > 200) throw new Error('Regex pattern is too long.');
  if (hasUnsafeRepeatedRegexGroup(pattern)) {
    throw new Error('Regex pattern is too complex. Avoid alternation or variable quantifiers inside a repeated group.');
  }
}

interface RegexGroupSafetyState {
  hasAlternation: boolean;
  hasVariableQuantifier: boolean;
}

interface RegexQuantifierInfo {
  end: number;
  repeated: boolean;
  variable: boolean;
}

/**
 * Conservatively rejects the catastrophic-backtracking shapes supported by
 * JavaScript's backtracking RegExp engine. This scanner is syntax-aware enough
 * to distinguish escaped tokens and character classes, and deliberately does
 * not attempt to prove that alternatives are semantically disjoint.
 */
function hasUnsafeRepeatedRegexGroup(pattern: string): boolean {
  const groups: RegexGroupSafetyState[] = [];
  let variableQuantifierCount = 0;
  let alternationCount = 0;
  const recordVariableQuantifier = (quantifier: RegexQuantifierInfo | null): boolean => {
    if (!quantifier?.variable) return false;
    variableQuantifierCount += 1;
    for (const group of groups) group.hasVariableQuantifier = true;
    return variableQuantifierCount > 1;
  };

  for (let index = 0; index < pattern.length; index += 1) {
    const token = pattern[index];
    if (token === '\\') {
      const escapeEnd = regexEscapeEnd(pattern, index);
      if ((markerIsBackreference(pattern, index))) return true;
      const quantifier = regexQuantifierAt(pattern, escapeEnd + 1);
      if (recordVariableQuantifier(quantifier)) return true;
      index = quantifier ? quantifier.end - 1 : escapeEnd;
      continue;
    }
    if (token === '[') {
      index = regexCharacterClassEnd(pattern, index);
      const quantifier = regexQuantifierAt(pattern, index + 1);
      if (recordVariableQuantifier(quantifier)) return true;
      if (quantifier) index = quantifier.end - 1;
      continue;
    }
    if (token === '(') {
      if (isRegexLookaround(pattern, index)) return true;
      groups.push({ hasAlternation: false, hasVariableQuantifier: false });
      continue;
    }
    if (token === '|') {
      alternationCount += 1;
      if (alternationCount > 1) return true;
      for (const group of groups) group.hasAlternation = true;
      continue;
    }
    if (token === ')' && groups.length > 0) {
      const group = groups.pop() as RegexGroupSafetyState;
      const quantifier = regexQuantifierAt(pattern, index + 1);
      if (quantifier?.repeated && (group.hasAlternation || group.hasVariableQuantifier)) return true;
      if (recordVariableQuantifier(quantifier)) return true;
      if (quantifier) index = quantifier.end - 1;
      continue;
    }

    const quantifier = regexQuantifierAt(pattern, index + 1);
    if (recordVariableQuantifier(quantifier)) return true;
    if (quantifier) index = quantifier.end - 1;
  }
  return false;
}

function markerIsBackreference(pattern: string, start: number): boolean {
  const marker = pattern[start + 1] ?? '';
  return /^[1-9]$/u.test(marker) || (marker === 'k' && pattern[start + 2] === '<');
}

function isRegexLookaround(pattern: string, start: number): boolean {
  if (pattern[start] !== '(' || pattern[start + 1] !== '?') return false;
  const marker = pattern[start + 2];
  if (marker === '=' || marker === '!') return true;
  return marker === '<' && (pattern[start + 3] === '=' || pattern[start + 3] === '!');
}

function regexEscapeEnd(pattern: string, start: number): number {
  const marker = pattern[start + 1];
  if (!marker) return start;
  if ((marker === 'u' || marker === 'p' || marker === 'P') && pattern[start + 2] === '{') {
    const close = pattern.indexOf('}', start + 3);
    return close >= 0 ? close : pattern.length - 1;
  }
  if (marker === 'u') return Math.min(pattern.length - 1, start + 5);
  if (marker === 'x') return Math.min(pattern.length - 1, start + 3);
  if (marker === 'c') return Math.min(pattern.length - 1, start + 2);
  if (marker === 'k' && pattern[start + 2] === '<') {
    const close = pattern.indexOf('>', start + 3);
    return close >= 0 ? close : pattern.length - 1;
  }
  return Math.min(pattern.length - 1, start + 1);
}

function regexCharacterClassEnd(pattern: string, start: number): number {
  for (let index = start + 1; index < pattern.length; index += 1) {
    if (pattern[index] === '\\') index = regexEscapeEnd(pattern, index);
    else if (pattern[index] === ']') return index;
  }
  return pattern.length - 1;
}

function regexQuantifierAt(pattern: string, index: number): RegexQuantifierInfo | null {
  const token = pattern[index];
  if (token === '*' || token === '+') return { end: index + 1, repeated: true, variable: true };
  if (token === '?') return { end: index + 1, repeated: false, variable: true };
  if (token !== '{') return null;
  const match = pattern.slice(index).match(/^\{(\d+)(?:,(\d*))?\}/u);
  if (!match) return null;
  const minimum = Number.parseInt(match[1], 10);
  const hasComma = match[2] !== undefined;
  const maximum = !hasComma ? minimum : match[2] === '' ? Number.POSITIVE_INFINITY : Number.parseInt(match[2], 10);
  return {
    end: index + match[0].length,
    repeated: maximum > 1,
    variable: maximum !== minimum,
  };
}

function unquote(value: string): string { return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_m, doubleQuoted: string | undefined, singleQuoted: string | undefined) => doubleQuoted ?? singleQuoted ?? value); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

interface ExpressionCache {
  expressions: Map<string, QueryExpression>;
  tasks: WeakMap<MarkdownTask, Record<string, unknown>>;
  files: Map<string, Record<string, unknown>>;
  counts?: Map<string, { total: number; done: number }>;
  allTasks?: Record<string, unknown>[];
}

function expressionCache(context: TaskFilterContext): ExpressionCache {
  return context._expressionCache ??= { expressions: new Map(), tasks: new WeakMap(), files: new Map() };
}

function evaluateTaskExpression(expression: string, task: MarkdownTask, context: TaskFilterContext): unknown {
  const cache = expressionCache(context);
  let evaluate = cache.expressions.get(expression);
  if (!evaluate) {
    evaluate = compileQueryExpression(expression, {
      property: getDslProperty, method: callDslMethod, call: callDslFunction,
      regex: makeRegex, truthy, equal: compareDslEquality, compare: compareDslValues,
    });
    cache.expressions.set(expression, evaluate);
  }
  return evaluate({
    task: taskExpressionFacade(task, context),
    query: {
      get file() { return context.sourcePath ? fileExpressionFacade(context.sourcePath, context) : undefined; },
      get allTasks() { return cache.allTasks ??= context.allTasks.map((candidate) => taskExpressionFacade(candidate, context)); },
    },
  });
}

function taskDateFacade(value: string, field: DateField, today: string): Record<string, unknown> {
  const valid = isValidDateValue(value, field);
  const date = value.slice(0, 10);
  const category = !valid ? { name: 'Invalid date', sortOrder: 0, groupText: '%%0%% Invalid date' }
    : date < today ? { name: 'Overdue', sortOrder: 1, groupText: '%%1%% Overdue' }
      : date === today ? { name: 'Today', sortOrder: 2, groupText: '%%2%% Today' }
        : { name: 'Future', sortOrder: 3, groupText: '%%3%% Future' };
  return {
    value,
    valid,
    moment: valid ? value : null,
    category,
    fromNow: { name: relativeDateLabel(date, today), sortOrder: valid ? diffDays(today, date) : Number.NEGATIVE_INFINITY, groupText: relativeDateLabel(date, today) },
    format: (format = 'YYYY-MM-DD', fallback = '') => valid ? formatDateForQuery(date, String(format)) : fallback,
    formatAsDate: (fallback = '') => valid ? date : fallback,
    formatAsDateAndTime: (fallback = '') => valid ? value : fallback,
    toISOString: (fallback = '') => valid ? `${date}T00:00:00.000Z` : fallback,
    isValid: () => valid,
  };
}

function emptyTaskDateFacade(_field: DateField): Record<string, unknown> {
  return {
    value: '',
    valid: false,
    moment: null,
    category: { name: 'Undated', sortOrder: 4, groupText: '%%4%% Undated' },
    fromNow: { name: '', sortOrder: 9999, groupText: '' },
    format: (_format = 'YYYY-MM-DD', fallback = '') => fallback,
    formatAsDate: (fallback = '') => fallback,
    formatAsDateAndTime: (fallback = '') => fallback,
    toISOString: (fallback = '') => fallback,
    isValid: () => false,
  };
}

function formatDateForQuery(value: string, format: string): string {
  if (format === 'YYYY-MM-DD' || !format) return value;
  const date = parseDateString(value);
  const replacements: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()),
    MM: String(date.getUTCMonth() + 1).padStart(2, '0'),
    MMM: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()],
    dddd: weekdayName(value),
    d: String(date.getUTCDay()),
    DD: String(date.getUTCDate()).padStart(2, '0'),
    WW: String(isoWeekNumber(date)).padStart(2, '0'),
  };
  return format.replace(/\[([^\]]+)\]|YYYY|MMMM|MMM|MM|DD|dddd|WW|d/gu, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    if (token === 'MMMM') return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][date.getUTCMonth()];
    return replacements[token] ?? token;
  });
}

function isoWeekNumber(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

function relativeDateLabel(value: string, today: string): string {
  if (!isValidIsoDate(value)) return 'Invalid date';
  const days = diffDays(today, value);
  if (days === 0) return 'today';
  if (days === 1) return 'in 1 day';
  if (days === -1) return '1 day ago';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

function taskExpressionFacade(task: MarkdownTask, context: TaskFilterContext): Record<string, unknown> {
  const cache = expressionCache(context);
  const cached = cache.tasks.get(task);
  if (cached) return cached;
  const facade = buildTaskExpressionFacade(task, context);
  cache.tasks.set(task, facade);
  return facade;
}

function buildTaskExpressionFacade(task: MarkdownTask, context: TaskFilterContext): Record<string, unknown> {
  const date = (value: string | undefined, field: DateField) => value ? taskDateFacade(value, field, context.today) : emptyTaskDateFacade(field);
  return {
    status: {
      name: statusName(task, context.states),
      type: statusTypeGroupText(task.status),
      typeGroupText: statusTypeGroupTextWithSort(task.status),
      symbol: task.checkbox,
      nextSymbol: nextStatusSymbol(task, context.states),
    },
    isDone: isDoneLike(task.status),
    statusName: statusName(task, context.states),
    statusType: task.status,
    statusSymbol: task.checkbox,
    description: task.normalizedText,
    descriptionWithoutTags: stripTags(task.normalizedText),
    originalMarkdown: task.rawLine,
    priorityName: priorityDisplayName(task.metadata.priority),
    priorityNameGroupText: priorityGroupTextWithSort(task.metadata.priority),
    priorityNumber: PRIORITY_NUMBER[task.metadata.priority],
    urgency: calculateUrgency(task, context.today, context),
    isRecurring: Boolean(task.metadata.recurrence),
    recurrenceRule: task.metadata.recurrence ?? '',
    recurrenceUntil: task.metadata.recurrenceUntil ?? null,
    recurrenceLimit: task.metadata.recurrenceLimit ?? null,
    onCompletion: task.metadata.onCompletion ?? '',
    blockLink: task.metadata.blockLink ?? '',
    tags: task.tags.map((tag) => `#${tag}`),
    id: task.metadata.id ?? '',
    dependsOn: task.metadata.dependsOn,
    due: date(task.metadata.dates.due, 'due'),
    scheduled: date(task.metadata.dates.scheduled, 'scheduled'),
    start: date(task.metadata.dates.start, 'start'),
    done: date(task.metadata.dates.done, 'done'),
    created: date(task.metadata.dates.created, 'created'),
    cancelled: date(task.metadata.dates.cancelled, 'cancelled'),
    reminder: date(task.metadata.reminder, 'reminder'),
    happens: date(firstHappensDate(task), 'happens'),
    get file() { return fileExpressionFacade(task.filePath, context); },
    outlinks: buildDslLinks(task),
    links: buildDslLinks(task),
    hasHeading: Boolean(task.heading),
    heading: task.heading ?? null,
    lineNumber: Math.max(0, task.lineNumber - 1),
    listMarker: task.listMarker,
    isBlocked: () => isTaskBlocked(task, context.allTasks, context),
    isBlocking: () => isTaskBlocking(task, context.allTasks, context),
    effort: task.metadata.effort ?? null,
    estimate: task.metadata.effort ?? null,  // alias: PRD Task 7 calls this 'estimate'
    actual: task.metadata.actual ?? null,
    cost: task.metadata.cost ?? null,
    pinned: Boolean(task.metadata.pinned),
    customFields: customFieldsExpressionFacade(task),
    dependencyTypes: task.metadata.dependencyTypes ?? {},
    followUp: task.metadata.followUp ? taskDateFacade(task.metadata.followUp.slice(0, 10), 'follow-up', context.today) : emptyTaskDateFacade('follow-up'),
    contexts: task.contexts ?? [],
    // Subtask child counts (based on same-file tasks with greater indentation immediately following)
    get childCount(): number {
      const parentIndentLen = effectiveTaskIndent(task);
      const sameFileLater = context.allTasks
        .filter((t) => t.filePath === task.filePath && t.lineNumber > task.lineNumber)
        .sort((a, b) => a.lineNumber - b.lineNumber);
      let count = 0;
      for (const t of sameFileLater) {
        if (effectiveTaskIndent(t) <= parentIndentLen) break;
        count++;
      }
      return count;
    },
    get doneChildCount(): number {
      const parentIndentLen = effectiveTaskIndent(task);
      const sameFileLater = context.allTasks
        .filter((t) => t.filePath === task.filePath && t.lineNumber > task.lineNumber)
        .sort((a, b) => a.lineNumber - b.lineNumber);
      let count = 0;
      for (const t of sameFileLater) {
        if (effectiveTaskIndent(t) <= parentIndentLen) break;
        if (t.status === 'done' || t.status === 'cancelled') count++;
      }
      return count;
    },
  };
}

function customFieldsExpressionFacade(task: MarkdownTask): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(task.metadata.customFields ?? {})) {
    if (field && field.value !== undefined) result[key] = field.value;
  }
  return result;
}

function fileExpressionFacade(path: string, context: TaskFilterContext): Record<string, unknown> {
  const cache = expressionCache(context);
  const cached = cache.files.get(path);
  if (cached) return cached;
  if (!cache.counts) {
    cache.counts = new Map();
    const terminal = new Set(context.states.filter((state) => state.type === 'done' || state.type === 'cancelled').map((state) => state.rawText));
    const known = new Set(context.states.map((state) => state.rawText));
    for (const task of context.allTasks) {
      const count = cache.counts.get(task.filePath) ?? { total: 0, done: 0 };
      count.total += 1;
      if (terminal.has(task.checkbox) || (!known.has(task.checkbox) && (task.checkbox === 'x' || task.checkbox === '-'))) count.done += 1;
      cache.counts.set(task.filePath, count);
    }
  }
  const info = context.fileInfoProvider?.(path) ?? { properties: {}, outlinks: [] };
  const filename = path.split('/').pop() ?? path;
  const count = cache.counts.get(path);
  const completionRate = count?.total ? count.done / count.total : 0;
  const completionPercent = Math.round(completionRate * 100);
  const facade = {
    path,
    pathWithoutExtension: path.replace(/\.md$/iu, ''),
    filename,
    filenameWithoutExtension: filename.replace(/\.md$/iu, ''),
    folder: path.includes('/') ? `${path.slice(0, path.lastIndexOf('/') + 1)}` : '/',
    root: path.includes('/') ? `${path.slice(0, path.indexOf('/') + 1)}` : '/',
    outlinks: info.outlinks,
    links: info.outlinks,
    outlinksInBody: info.outlinks,
    outlinksInProperties: propertyOutlinks(info.properties),
    completionRate,
    completionPercent,
    __properties: info.properties,
  };
  cache.files.set(path, facade);
  return facade;
}

function propertyOutlinks(properties: Record<string, unknown>): string[] {
  const links: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && /^\[\[.+\]\]$/u.test(value.trim())) links.push(value.trim());
    else if (Array.isArray(value)) value.forEach(visit);
  };
  Object.values(properties).forEach(visit);
  return links;
}

// ── Rich Link facade for the query DSL ───────────────────────────────────────

interface DslLink {
  markdown: string;
  destinationPath: string;
  alias: string | undefined;
  toString(): string;
  linksTo(nameOrPath: string): boolean;
}

/**
 * Build an array of structured DslLink objects from a task's body.
 * Each object exposes `.destinationPath`, `.alias`, `.markdown`, `.linksTo()`,
 * and `.toString()` (returns destinationPath) so it works as a string in legacy
 * expressions while providing richer capabilities for new ones.
 */
function buildDslLinks(task: MarkdownTask): DslLink[] {
  const seen = new Set<string>();
  const result: DslLink[] = [];

  const addLink = (raw: string): void => {
    // Parse [[Destination|Alias]] wikilinks
    const wikilinkMatch = raw.match(/^!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/u);
    // Parse [Alias](destination) markdown links
    const mdLinkMatch = !wikilinkMatch ? raw.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+['"][^)]*['"])?\)$/u) : null;

    let destinationPath: string;
    let alias: string | undefined;
    let markdown: string;

    if (wikilinkMatch) {
      destinationPath = wikilinkMatch[1].split('#')[0].trim();
      alias = wikilinkMatch[2]?.trim() || undefined;
      markdown = raw.startsWith('!') ? raw.slice(1) : raw;
    } else if (mdLinkMatch) {
      alias = mdLinkMatch[1].trim();
      destinationPath = mdLinkMatch[2].replace(/\.md$/iu, '');
      markdown = raw;
    } else {
      // Bare destination string (from taskOutlinks normalisation)
      destinationPath = raw.replace(/^\[\[|\]\]$/gu, '').split('|')[0].split('#')[0].trim();
      markdown = `[[${destinationPath}]]`;
    }

    if (!destinationPath || seen.has(destinationPath.toLowerCase())) return;
    seen.add(destinationPath.toLowerCase());

    result.push({
      markdown,
      destinationPath,
      alias,
      toString(): string { return destinationPath; },
      linksTo(nameOrPath: string): boolean {
        const needle = nameOrPath.toLowerCase().replace(/\.md$/iu, '').replace(/^.*\/([^/]+)$/u, '$1');
        const haystack = destinationPath.toLowerCase().replace(/\.md$/iu, '');
        return haystack === needle || haystack.endsWith(`/${needle}`);
      },
    });
  };

  // Extract wikilinks from the task body
  for (const match of task.body.matchAll(/!?\[\[([^\]]+)\]\]/gu)) {
    addLink(`[[${match[1]}]]`);
  }
  // Extract markdown links, but not image embeds (`![alt](source)`).
  for (const match of task.body.matchAll(/!?\[([^\]\n]+)\]\(([^)\s]+)(?:\s+['"][^)]*['"])?\)/gu)) {
    if (match[0].startsWith('!')) continue;
    addLink(`[${match[1]}](${match[2]})`);
  }

  return result;
}

function propertyValue(properties: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(properties, name)) return properties[name];
  const normalized = name.toLowerCase();
  const matchingKey = Object.keys(properties).find((key) => key.toLowerCase() === normalized);
  return matchingKey ? properties[matchingKey] : null;
}

/** Returns true if `name` exists as a key in `properties` (case-insensitive), even when the value is null/false/0/''. */
function propertyExists(properties: Record<string, unknown>, name: string): boolean {
  const searchName = name.toLowerCase();
  return Object.keys(properties).some((k) => k.toLowerCase() === searchName);
}

function callDslMethod(target: unknown, name: string, args: unknown[]): unknown {
  if (target && typeof target === 'object') {
    const record = target as Record<string, unknown>;
    const maybeFunction = record[name];
    if (typeof maybeFunction === 'function' && Object.prototype.hasOwnProperty.call(record, name)) return (maybeFunction as (...values: unknown[]) => unknown)(...args);
    if (name === 'hasProperty') {
      // Check key existence, not value truthiness — a property with value null/false/0 still exists.
      return propertyExists((record.__properties as Record<string, unknown> | undefined) ?? {}, safeStr(args[0]));
    }
    if (name === 'property') {
      return propertyValue((record.__properties as Record<string, unknown> | undefined) ?? {}, safeStr(args[0]));
    }
  }
  if (name === 'format') return target && typeof target === 'object' && 'value' in target ? String((target).value) : '';
  if (name === 'isValid') return Boolean(target && typeof target === 'object' && 'valid' in target && (target).valid);
  const text = safeStr(target);
  if (name === 'includes') {
    if (Array.isArray(target)) {
      // For arrays of DslLink objects (task.outlinks), coerce each element to a string
      // via .toString() for backward compatibility with queries like task.outlinks.includes("Target").
      return target.some((el) => el === args[0] || safeStr(el) === safeStr(args[0]));
    }
    return text.includes(safeStr(args[0]));
  }
  if (name === 'join') return Array.isArray(target) ? target.join(safeStr(args[0], ',')) : text;
  if (name === 'sort') return Array.isArray(target) ? [...(target as unknown[])].sort() : text;
  if (name === 'startsWith') return text.startsWith(safeStr(args[0]));
  if (name === 'endsWith') return text.endsWith(safeStr(args[0]));
  if (name === 'slice') return text.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
  if (name === 'replace') {
    // ReDoS guard: only allow string replacement, not regex.
    // The query language has a dedicated `matches` function for regex.
    return text.replace(safeStr(args[0]), safeStr(args[1]));
  }
  if (name === 'toLowerCase') return text.toLowerCase();
  if (name === 'toUpperCase') return text.toUpperCase();
  if (name === 'toFixed') return Number(target ?? 0).toFixed(Number(args[0] ?? 0));
  if (name === 'matches' || name === 'regexMatches') return makeRegex(safeStr(args[0])).test(text);
  throw new Error(`Unsupported query DSL method '${name}'.`);
}

function callDslFunction(name: string, args: unknown[]): unknown {
  if (name === 'contains' || name === 'includes') return safeStr(args[0]).includes(safeStr(args[1]));
  if (name === 'lower') return safeStr(args[0]).toLowerCase();
  if (name === 'upper') return safeStr(args[0]).toUpperCase();
  if (name === 'matches') return makeRegex(safeStr(args[1])).test(safeStr(args[0]));
  if (name === 'empty') return args[0] === null || args[0] === undefined || args[0] === '' || (Array.isArray(args[0]) && args[0].length === 0);
  throw new Error(`Unsupported query DSL function '${name}'.`);
}

function getDslProperty(target: unknown, name: string): unknown {
  if (target === null || target === undefined) return undefined;
  if ((Array.isArray(target) || typeof target === 'string') && name === 'length') return target.length;
  if (typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, name))
    return (target as Record<string, unknown>)[name];
  return undefined;
}

function compareDslEquality(left: unknown, right: unknown): boolean {
  return normalizeDslComparable(left) === normalizeDslComparable(right);
}

function compareDslValues(left: unknown, right: unknown): number {
  const normalizedLeft = normalizeDslComparable(left);
  const normalizedRight = normalizeDslComparable(right);
  if (typeof normalizedLeft === 'number' && typeof normalizedRight === 'number') return normalizedLeft - normalizedRight;
  return safeStr(normalizedLeft).localeCompare(safeStr(normalizedRight));
}

function normalizeDslComparable(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) return (value).value;
  return value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(normalizeDslComparable(value));
}

function getTodayString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse an effort/actual string like "2h 30m", "1h", "45m" into total minutes.
 * Returns Infinity for undefined values so undated tasks sort last.
 */
function parseEffortMinutes(s: string | undefined): number {
  return parseEffortMinutesForFilter(s);
}

/**
 * Return a sort weight for a task's priority using the custom priority scale.
 * Falls back to the built-in PRIORITY_ORDER weight when no match is found.
 */
function customPriorityWeight(task: MarkdownTask, customPriorities: readonly CustomPriority[]): number {
  const match = customPriorities.find((p) => p.label.toLowerCase() === task.metadata.priority.toLowerCase());
  return match ? -match.value : PRIORITY_ORDER[task.metadata.priority];
}

// ── Future occurrence projection helpers ───────────────────────────────────────────
function projectOccurrences<T extends MarkdownTask>(task: T, count: number, today: string): T[] {
  if (!task.metadata.recurrence) return [];
  const rule = task.metadata.recurrence.toLowerCase();
  const dateField = task.metadata.dates.due ? 'due' : task.metadata.dates.scheduled ? 'scheduled' : task.metadata.dates.start ? 'start' : undefined;
  const anchor = dateField ? task.metadata.dates[dateField] : today;
  const results: T[] = [];
  let current = /\bwhen done\b/u.test(rule) ? today : (anchor ?? today);
  const remaining = task.metadata.recurrenceLimit === undefined ? count : Math.min(count, task.metadata.recurrenceLimit - (task.metadata.recurrenceCount ?? 0) - 1);
  const projectionCount = Math.min(DEFAULT_TASK_LIMIT, Math.max(0, Math.floor(remaining)));
  // Bound catch-up work for malformed/ancient anchors; ordinary daily rules can jump directly.
  const daily = rule.match(/^every (?:(\d+) )?days?(?:\s|$)/u);
  const step = daily ? Number(daily[1] ?? 1) : 0;
  if (step > 0 && current < today) current = addIsoDays(current, Math.floor(diffDays(current, today) / step) * step);
  for (let steps = 0; results.length < projectionCount && steps < 10_000; steps++) {
    const next = advanceByRecurrenceRule(rule, current);
    if (!next || !isValidIsoDate(next) || next <= current) break;
    if (next > (task.metadata.recurrenceUntil ?? '9999-12-31')) break;
    current = next;
    if (next <= today) continue;
    const i = results.length;
    const dates = { ...task.metadata.dates };
    if (dateField) dates[dateField] = next;
    results.push({
      ...task,
      key: `_proj_${i}_${task.key}`,
      normalizedText: `${task.normalizedText} (projected)`,
      isProjected: true,
      metadata: { ...task.metadata, dates },
    });
    current = next;
  }
  return results;
}

function advanceByRecurrenceRule(rule: string, from: string): string | null {
  const [y, m, d] = from.split('-').map(Number) as [number, number, number];
  if (/every day/u.test(rule)) return addDaysToIso(from, 1);
  const dayMatch = rule.match(/every (\d+) days?/u);
  if (dayMatch) return addDaysToIso(from, Number(dayMatch[1]));
  // "every weekday" must be checked before the generic "every week" branch because
  // /every week(?! on)/ also matches "every weekday" (the "d" that follows is not " on").
  if (/every weekday/u.test(rule)) {
    const fromDt = new Date(`${from}T00:00:00Z`);
    const currentDay = fromDt.getUTCDay(); // 0=Sun, 6=Sat
    // Fri (5) → Mon: skip 3; Sat (6) → Mon: skip 2; any other weekday: +1
    const skipDays = currentDay === 5 ? 3 : currentDay === 6 ? 2 : 1;
    return addDaysToIso(from, skipDays);
  }
  // "every week on <weekday>" — advance to the next occurrence of the named weekday,
  // always at least 1 day forward (same weekday → exactly +7 days).
  const weeklyOnMatch = rule.match(/every week on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/u);
  if (weeklyOnMatch) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = dayNames.indexOf(weeklyOnMatch[1]);
    const fromDt = new Date(`${from}T00:00:00Z`);
    const currentDay = fromDt.getUTCDay();
    let delta = targetDay - currentDay;
    if (delta <= 0) delta += 7; // always forward; same weekday → +7
    return addDaysToIso(from, delta);
  }
  if (/every week(?! on)/u.test(rule) || /every \d+ weeks?(?! on)/u.test(rule)) {
    const nMatch = rule.match(/every (\d+) weeks?/u);
    return addDaysToIso(from, (nMatch ? Number(nMatch[1]) : 1) * 7);
  }
  if (/every month/u.test(rule)) {
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, daysInMonth(ny, nm))).padStart(2, '0')}`;
  }
  if (/every year/u.test(rule)) {
    const ny = y + 1;
    return `${ny}-${String(m).padStart(2, '0')}-${String(Math.min(d, daysInMonth(ny, m))).padStart(2, '0')}`;
  }
  return null;
}

function addDaysToIso(iso: string, n: number): string { return addIsoDays(iso, n); }

function daysInMonth(year: number, month: number): number { return daysInIsoMonth(year, month); }

/**
 * Propagate due/scheduled/start dates from parent tasks to undated subtasks.
 * Uses indentation depth within the same file to determine ancestry.
 * Returns a new array where undated subtasks have inherited dates; original
 * task objects are not mutated.
 */

/**
 * Apply file-scoped YAML-frontmatter defaults to a task.
 * If the file has `task_due: 2026-06-01` and the task has no due date,
 * the returned task will have `metadata.dates.due = '2026-06-01'`.
 * Similarly for `task_scheduled`, `task_start`, `task_priority`, and `task_tags`.
 * The original task object is never mutated; returns the original reference when nothing changed.
 */
function applyFileDefaults<T extends MarkdownTask>(task: T, properties: Record<string, unknown>, prefix: string): T {
  const p = prefix || 'task_';
  const getProp = (key: string): string | undefined => {
    const full = `${p}${key}`;
    if (Object.prototype.hasOwnProperty.call(properties, full)) {
      const val = properties[full];
      return val !== null && val !== undefined ? safeStr(val) : undefined;
    }
    // Case-insensitive lookup
    const lower = full.toLowerCase();
    const found = Object.keys(properties).find((k) => k.toLowerCase() === lower);
    return found !== undefined ? safeStr(properties[found]) : undefined;
  };

  const newDates = { ...task.metadata.dates };
  let changed = false;

  for (const field of ['due', 'scheduled', 'start'] as const) {
    if (!newDates[field]) {
      const val = getProp(field);
      if (val && /^\d{4}-\d{2}-\d{2}$/u.test(val.trim())) {
        newDates[field] = val.trim();
        changed = true;
      }
    }
  }

  let newPriority = task.metadata.priority;
  if (!task.metadata.priority || task.metadata.priority === 'normal') {
    const val = getProp('priority');
    if (val) {
      const normalizedPriority = val.trim().toLowerCase();
      const resolved = PRIORITY_ALIASES[normalizedPriority];
      if (resolved && resolved !== 'normal') {
        newPriority = resolved;
        changed = true;
      }
    }
  }

  let newTags = task.tags;
  const val = getProp('tags');
  if (val) {
    const fileTags = val.split(/[\s,]+/u).filter(Boolean).map((t) => t.replace(/^#/u, ''));
    if (fileTags.length > 0) {
      newTags = Array.from(new Set([...task.tags, ...fileTags]));
      if (newTags.length !== task.tags.length) changed = true;
    }
  }

  if (!changed) return task;
  return { ...task, metadata: { ...task.metadata, dates: newDates, priority: newPriority }, tags: newTags };
}

function applySubtaskDateInheritance<T extends MarkdownTask>(tasks: readonly T[]): T[] {
  if (tasks.length === 0) return [];

  // Group by file, sort by line number within each file
  const byFile = new Map<string, T[]>();
  for (const task of tasks) {
    const bucket = byFile.get(task.filePath);
    if (bucket) bucket.push(task);
    else byFile.set(task.filePath, [task]);
  }

  const result: T[] = [];

  for (const fileTasks of byFile.values()) {
    fileTasks.sort((a, b) => a.lineNumber - b.lineNumber);

    // Ancestor stack: [{ indentLen, dates }] from root to deepest ancestor
    const stack: Array<{ indentLen: number; dates: T['metadata']['dates'] }> = [];

    for (const task of fileTasks) {
      const indentLen = effectiveTaskIndent(task);

      // Pop ancestors that are at equal or deeper indentation — they are no longer ancestors
      while (stack.length > 0 && stack[stack.length - 1].indentLen >= indentLen) {
        stack.pop();
      }

      const taskDates = task.metadata.dates;
      let emittedTask: T = task;

      // Only try to inherit if this task is missing at least one date and there is an ancestor
      if (stack.length > 0 && (!taskDates.due || !taskDates.scheduled || !taskDates.start)) {
        const ancestor = stack[stack.length - 1];
        const ad = ancestor.dates;
        const inheritedDue = taskDates.due ?? ad.due;
        const inheritedScheduled = taskDates.scheduled ?? ad.scheduled;
        const inheritedStart = taskDates.start ?? ad.start;

        if (inheritedDue !== taskDates.due || inheritedScheduled !== taskDates.scheduled || inheritedStart !== taskDates.start) {
          const newDates = { ...taskDates, due: inheritedDue, scheduled: inheritedScheduled, start: inheritedStart };
          emittedTask = { ...task, metadata: { ...task.metadata, dates: newDates } };
        }
      }

      result.push(emittedTask);
      stack.push({ indentLen, dates: emittedTask.metadata.dates });
    }
  }

  return result;
}

function effectiveTaskIndent(task: Pick<MarkdownTask, 'linePrefix' | 'indentation'>): number {
  return task.linePrefix.length + task.indentation.length;
}
