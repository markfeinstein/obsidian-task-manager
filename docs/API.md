# Task Manager runtime API v1 (experimental)

> **Status:** Experimental developer reference for source version 0.1.0. The API is available only inside the Obsidian process after the plugin loads. The four-file plugin/release package does not currently distribute a `.d.ts` file or SDK artifact.

## Compatibility intent

`apiV1` is a versioned runtime surface, not yet a supported distributable TypeScript SDK. Existing v1 method names and result envelopes are intended to remain compatible during the 0.1 pre-release line, and additive fields/methods may appear, but consumers must currently provide or vendor their own types. Experimental task metadata can grow. A future breaking runtime surface will use a new major property (for example `apiV2`) with migration notes; a supported API claim requires a dependency-minimal declaration/SDK artifact and consumer compile contract.

Returned arrays are new arrays and task snapshots are recursively cloned/frozen when committed to the shared index. Consumers cannot mutate index-owned task or nested metadata state through the API. Continue treating DTOs as read-only and use source-line/edit/mutation commands for writes.

## Access and readiness

```javascript
const taskManager = app.plugins.plugins['task-manager'];
if (!taskManager?.apiV1) throw new Error('Task Manager is not loaded');
const api = taskManager.apiV1;
await api.whenTaskIndexReady();
```

`apiV1` is a property of the plugin instance; it is not a separate global variable. `isTaskIndexReady()` reports whether first hydration reached ready/degraded state. `getAllTasks()` and `getTasksForFile()` reject before readiness rather than returning a misleading cold snapshot, so startup integrations must await readiness.

## TypeScript surface

The source-of-truth interface is exported as `TaskManagerApiV1` from `src/main.ts`. The runtime surface is:

```ts
interface TaskManagerApiV1 {
  createTaskLineModal(initialFields?: Partial<EditableTaskLine>): Promise<string>;
  editTaskLineModal(taskLine: string, initialFields?: Partial<EditableTaskLine>): Promise<string>;
  executeToggleTaskDoneCommand(line: string): string;
  parseTaskLine(line: string): EditableTaskLine;
  formatTaskLine(fields: Partial<EditableTaskLine>): string;
  updateTaskLine(line: string, patch: Partial<EditableTaskLine>): string;
  getAllTasks(): ParsedTask[];
  getTasksForFile(filePath: string): ParsedTask[];
  onTaskStatusChanged(handler: (task: ParsedTask, oldStatus: TaskStatus) => void): () => void;
  executeQuery(query: string, format?: 'json' | 'csv' | 'markdown', context?: { sourcePath?: string }): Promise<QueryResult>;
  onTaskCacheUpdated(handler: (tasks: ParsedTask[]) => void): () => void;
  isTaskIndexReady(): boolean;
  whenTaskIndexReady(): Promise<void>;
  getTaskIndexRevision(): number;
  onTaskIndexChanged(handler: (tasks: ParsedTask[], revision: number) => void): () => void;
}
```

## Reads and revisions

### `getAllTasks()` / `getTasksForFile(path)`

Return current snapshot arrays. File paths are vault-relative and use `/` separators. An unknown path returns `[]`.

```javascript
const all = api.getAllTasks();
const open = all.filter((task) => !['done', 'cancelled'].includes(task.status));
const fileTasks = api.getTasksForFile('Projects/Work.md');
```

### `getTaskIndexRevision()` / `onTaskIndexChanged(handler)`

Revision increases whenever the shared index publishes changed/removed paths. The subscription immediately applies only to future publications and returns an unsubscribe function.

```javascript
const unsubscribe = api.onTaskIndexChanged((tasks, revision) => {
  console.log(`Task index revision ${revision}: ${tasks.length} tasks`);
});
// Later:
unsubscribe();
```

`onTaskCacheUpdated` is the compatibility event after scans; prefer revision events for consumers that need shared-index semantics.

## Queries

### `executeQuery(query, format?, context?)`

The promise always resolves to an envelope rather than throwing query errors:

```ts
type TaskStatus = 'todo' | 'in_progress' | 'on_hold' | 'blocked' | 'deferred' | 'done' | 'cancelled' | 'untracked';

type QueryResult =
  | {
      apiVersion: 1;
      success: true;
      data: { tasks: ParsedTask[] | string; count: number };
      error?: never;
      executionTime: number;
    }
  | {
      apiVersion: 1;
      success: false;
      error: string;
      data?: never;
      executionTime: number;
    };
```

```javascript
const result = await api.executeQuery(`not done
priority is high
sort by due`);
if (!result.success) {
  console.warn(result.error);
} else if (Array.isArray(result.data.tasks)) {
  for (const task of result.data.tasks) console.log(task.normalizedText);
}
```

For `csv` and `markdown`, `data.tasks` is a formatted string; for default `json`, it is a task array. API, CLI, and rendered query blocks use the same metadata/outlink, subtask inheritance, future-occurrence, custom-priority, file-default, global-query, and default-sort context. Pass `{ sourcePath: 'Queries/Focus.md' }` when the query should apply that note's Query File Defaults; source-independent calls remain backwards-compatible.

## Line helpers and modals

`parseTaskLine`, `formatTaskLine`, and `updateTaskLine` operate on standalone strings and do not write a file. `executeToggleTaskDoneCommand` also rewrites only the supplied line; file-backed recurrence/lifecycle behavior belongs to normal mutation flows.

```javascript
const parsed = api.parseTaskLine('- [ ] Ship 📅 2026-07-15');
const changed = api.updateTaskLine('- [ ] Ship 📅 2026-07-15', {
  checkbox: 'x',
  done: '2026-07-11',
});
```

Modal methods resolve to `''` when cancelled. Call them from an active Obsidian UI context.

## `ParsedTask` essentials

The authoritative shape is `ParsedTask` in `src/task-scanner.ts`/`MarkdownTask` in `src/task-model.ts`. Important corrections to older docs:

- `heading?: string` (absent rather than `null`);
- `metadata.reminder?: string` such as `YYYY-MM-DD HH:mm`, not `{ mins }`;
- `metadata.dates` can include due, scheduled, start, created, done, and cancelled values/times;
- top-level `tags`, `contexts`, checkbox/source identity, indentation, and raw line are present;
- metadata also includes recurrence/series, IDs/dependencies, project/assignee/reviewer/team, effort/actual/cost, custom fields, sync IDs, comments, and more.

Do not persist the complete object as a stable external schema. Explicit task IDs are exact, case-sensitive, vault-wide identities; paths and line numbers are mutable locations. Persist the ID and rescan on revision changes. If an ID is duplicated, treat it as ambiguous and fail closed rather than selecting a task by array or file order.

Identical anonymous tasks are intentionally not assigned durable identity by occurrence order. Task Manager blocks completion/cancellation for a scanner-detected identical anonymous duplicate because those actions feed recurrence, completion, habit, and deduplication state. Add a unique `🆔 id` / `[id:: id]` before applying a stateful transition. Ordinary distinct anonymous tasks remain supported.

## Event ordering and errors

Index readiness precedes a reliable initial full read. Status events are emitted by Task Manager mutation flows; edits from another plugin/editor become visible after vault event/index reconciliation and may not produce the same immediate status event. Unsubscribe during plugin unload. Handler failures must not be used to block Task Manager writes.

Query envelopes carry errors as strings. Modal cancellation is an empty string. File mutation APIs are intentionally not exposed through v1; the desktop MCP companion is separately read-only.

## Security and privacy

Other plugins using this API already run with vault access, but should still minimize retained task data, redact logs, avoid exporting private file paths, and follow [`PRIVACY.md`](PRIVACY.md). Never send API results to a network service without explicit user opt-in.
