# Obsidian Bases integration

Task Manager can generate a Bases-friendly task index when **Enable Obsidian Bases integration** is turned on in settings. The integration is off by default and writes only generated files under `Task Manager Bases/`.

## What is generated

- `Task Manager Bases/Task Index.md` — a human-readable summary with frontmatter marking it as a generated task index.
- `Task Manager Bases/Task Index/*.md` — one generated note per indexed task. Each note has YAML/frontmatter fields such as `task_status`, `task_priority`, `task_due`, `task_project`, `task_source_file`, and `task_source_url`.
- `Task Manager Bases/*.base` — starter Bases views for Today, Upcoming, Projects, and Completed. These use the [current Bases schema](https://help.obsidian.md/bases/syntax): a `properties` configuration object and a `views` array, with per-view column order, sorting, and grouping. Output is JSON (a strict YAML subset) under an anchored generated-file header. Date filters use `date(...)` and `today()`, exclude undated notes, and access hyphenated ownership properties with bracket syntax. Existing owned legacy views are migrated on the next export.

## Commands

- **Generate Obsidian Bases task views** writes the starter `.base` files and refreshes the index.
- **Export task index for Obsidian Bases** refreshes the generated task index without changing your source task notes.

Both commands require the integration setting to be enabled.

## Auto-refresh

When **Auto-refresh Bases export** is enabled, Task Manager reconciles generated Bases files after task-cache updates using a short debounce. It creates missing outputs, updates existing marker-owned outputs, and moves stale marker-owned outputs under `Task Manager Bases/` through Obsidian's configured trash behavior. This keeps the generated frontmatter index aligned with the scanner cache while avoiding writes on every individual file event. Unchanged generated files are not rewritten.

## Safety notes

- Source task notes are read but are not modified or removed by the Bases export.
- Generated files under `Task Manager Bases/` are disposable outputs. Do not edit them in place; copy user-owned material outside the generated directory.
- Existing unmarked or ambiguously marked files are neither overwritten nor trashed. Files outside the exact export directory are never cleanup candidates.
- Stale files are moved with Obsidian's configured trash behavior rather than permanently deleted by Task Manager. Recovery location and availability depend on the user's Obsidian deletion settings.
- The export is capped to a conservative number of generated task notes to avoid large accidental writes in very large vaults.
- If Obsidian Bases syntax changes, you can still use the generated Markdown task notes and frontmatter properties directly.
