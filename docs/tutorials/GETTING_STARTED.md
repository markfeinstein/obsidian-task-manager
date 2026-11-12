# Getting started with Task Manager

Start with a task and a query. You can add integrations, reminders, and automation later. See [Choose a workflow](../PERSONA_JOURNEYS.md) for other ways to use the plugin.

## In-product local onboarding

A genuinely new profile opens a three-step **Getting started** flow after the Obsidian layout is ready. It only opens local task capture, reveals the Task Manager Sidebar, and inserts a `task-list` / `not done` query (or copies that snippet when no Markdown editor is active). It does not enable or call integrations, AI, voice, reminders, gamification, or other network features.

Choose **Remind me later** to close without recording completion, or **Don't show again** / **Finish** to persist the current onboarding version. Run **Open getting started** from the command palette at any time, including after dismissal. Existing configured profiles are not treated as first installs merely because they predate the onboarding setting.

## 1. Install for source evaluation

Follow [Installation and upgrade](../INSTALLATION.md). Use a test vault for your first session and leave network features off.

Create `Tasks.md`:

```markdown
- [ ] This is my first task
```

The line remains ordinary Markdown. Task Manager indexes it after startup/file scan; the plugin does not convert the note to a private database.

## 2. Add the first query

In another note, add:

````markdown
```task-list
not done
sort by smart
```
````

This renders incomplete tasks from the shared index, subject to the default query result limit. If it is empty immediately after enable, run **Rescan vault now** and check excluded folders/global filter.

## 3. Create and edit tasks

### Type Markdown

```markdown
- [ ] Buy groceries 🔺 #errands
```

`🔺` means highest priority; do not also add the literal word `high` unless it belongs in the description.

### Use the modal

1. Press `Ctrl/Cmd + P`.
2. Run **Create task** in an editor or **Quick add task (natural language)** for inbox capture.
3. Use persistent field labels for status, priority, dates, recurrence, ID, dependencies, and other enabled fields.
4. Save and inspect the resulting Markdown before using automation.

Right-click/context actions and **Edit task at cursor** open the same task model when a saved Markdown source can be resolved.

## 4. Understand status behavior by surface

Default checkbox markers are:

```text
[ ] Todo      [/] In progress      [!] Blocked      [?] Waiting
[>] Deferred  [x] Done             [-] Cancelled
```

| Surface | Status behavior |
|---|---|
| Markdown reading view | Left-click on a recognized task checkbox cycles configured states; context menu selects an exact state. |
| Markdown source/live preview | Editor command/Task Manager toolbar/status menu updates the editor buffer. Avoid racing an unsaved edit from another surface. |
| Query, Sidebar, Dashboard, Table/Kanban/Calendar | Task Manager resolves the saved source identity, writes through the mutation service, then refreshes the shared index/view. Stale or ambiguous sources fail instead of retargeting another line. |
| Canvas checklist text | Indexed read-only; copy/import to Markdown before mutation. |
| File-backed task note | Supported frontmatter status/date/priority changes use task-note semantics. Destructive archive/collect/delete and unsupported recurrence completion fail closed. |

A task with a duplicate explicit ID cannot use identity-sensitive dependencies, moves, or sync until the duplicate is fixed.

## 5. Add metadata

Prefer the edit modal while learning the syntax:

- **Due** — deadline (`📅`)
- **Scheduled** — planned work date (`⏳`)
- **Start** — availability/start date (`🛫`)
- **Priority** — highest/high/medium/normal/low/lowest
- **Recurrence** — reviewed recurrence rule (`🔁`)
- **Reminder** — foreground/plugin-execution reminder metadata (`⏰`)
- **ID / dependencies** — durable case-sensitive ID (`🆔`) and blockers (`⛔`)
- **Effort / actual** — estimate (`⏱️`) and logged time (`🕐`)

Dates written into Markdown are exact calendar dates. Relative phrases are input conveniences in supported modal/NLP fields; they are normalized before save.

## 6. Verify completion logging

Completion logging is **off by default**. Before testing it, open **Settings → Task Manager → Logging**, review the daily-note destination/heading behavior, and explicitly enable **Completion logging**. Once enabled, a detected non-done → done transition is deduplicated across rescans/retries. A task completed inside today's daily note is not logged back into that same note.

1. Enable completion logging after reviewing the destination and format settings.
2. Complete one synthetic task from a saved surface.
3. Task Manager resolves Periodic Notes, core Daily Notes, or the ISO fallback and may create today's note if needed.
4. Inspect the configured log heading and optional source link/time format.
5. Re-scan and confirm a duplicate visible log entry is not added.

Archive/collect/recurrence/follow-up side effects run through lifecycle checks. If a destination succeeds but exact source finalization is uncertain, the result is a structured partial failure with recovery guidance—not ordinary success.

## 7. Try evergreen queries

### Due today

```task-list
not done
due today
sort by smart
```

### Due this week

```task-list
not done
due this week
sort by due
```

### Highest priority

```task-list
not done
priority highest
sort by due
```

### Kanban status view

```task-list
view: kanban
not done
```

The built-in grammar is available without function expressions. Keep **Enable function expressions in queries** off until you have read [Query security](../QUERY_SECURITY.md).

## 8. Recommended next step

Choose one, not all:

- [Query language](QUERY_LANGUAGE.md)
- [Sidebar/default planning journey](../PERSONA_JOURNEYS.md#planning)
- [Mobile-first journey](../PERSONA_JOURNEYS.md#mobile)
- [Settings guide](../SETTINGS.md)
- [Troubleshooting](../TROUBLESHOOTING.md)

## Common questions

**Where are tasks stored?**

In Markdown files in the vault. Plugin settings, caches, sync mappings, generated logs/exports, and optional remote copies are separate data.

**Does Task Manager sync my vault to a phone?**

No. Use a vault-sync mechanism you choose. Task Manager runs only while Obsidian/plugin execution is available; mobile suspension prevents polling. See [Platform support](../PLATFORM_SUPPORT.md).

**Can collaborators edit the same task file?**

The file-sync provider governs concurrent file conflicts. Task Manager fails closed on stale/ambiguous task identity but cannot guarantee another provider's merge behavior. Test with backups.

**What remains after uninstall?**

Markdown remains. Follow [Uninstall and local data](../INSTALLATION.md#uninstall-and-local-data) for settings, caches, logs, generated files, credentials, and remote state.

For help, see [Troubleshooting](../TROUBLESHOOTING.md).
