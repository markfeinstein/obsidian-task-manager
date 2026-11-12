# Format and performance compatibility

> **Status:** Verified reference for source version 0.1.0. “Supported” below means a production parser/scanner test exists; it does not imply full feature parity with another plugin.

## Status vocabulary

- **Round-trip:** parsed and emitted without known semantic loss in the documented subset.
- **Read/parse:** Task Manager reads the syntax; writing may normalize it to the selected Task Manager format.
- **Partial/configurable:** only documented fields/states work, often after state configuration.
- **Fixture-only:** example data exists but no production-path guarantee. No format is presented as supported on this basis alone.
- **Not supported:** ignored or requires an explicit copy/import workflow.

## Format matrix

| Format | Level | Verified behavior | Boundaries |
|---|---|---|---|
| Obsidian Tasks Markdown | **Read/parse; partial round-trip** | `📅` due, `⏳`/`⌛` scheduled, `🛫` start, `✅` done, `➕` created, `❌` cancelled; `🔁` recurrence; priorities `🔺 ⏫ 🔼 🔽 ⏬`; `🆔`, `⛔`, effort | Task Manager is independent of the open-source Obsidian Tasks plugin and is not “Premium.” Unsupported recurrence/query nuances can normalize or be ignored. |
| Reminder plugin syntax | **Explicit conversion only** | **Convert Reminder plugin syntax in current file** rewrites `(@YYYY-MM-DD)` and `(@YYYY-MM-DD HH:mm)` to `⏰` metadata | Raw markers are intentionally not treated as Task Manager reminders. Conversion rewrites source; back up first. |
| Obsidian Kanban Markdown | **Read/parse** | Markdown checkbox cards under headings are scanned | Kanban plugin frontmatter/lanes are not round-tripped as a proprietary board model; Task Manager's own Kanban view is separate. |
| Dataview inline fields | **Read/parse; configurable write** | Built-in fields and configured `[key:: value]` custom fields | Complex objects/lists can normalize to strings. File frontmatter sync follows each custom field's mode. |
| Task Genius/custom checkboxes | **Partial/configurable** | Raw checkbox characters are preserved; configured markers receive Task Manager state types | Task Genius-specific progress/automation semantics are not imported. A marker such as `>` has Task Manager's configured meaning, not an assumed external meaning. |
| Canvas text nodes | **Read-only index** | Checklist lines in text nodes appear in search/query index | Mutations/manual ordering are refused. Use **Import tasks from Canvas cards** to copy checklist items into Markdown before editing. |

## Canonical Tasks-style example

```markdown
- [ ] Deploy service 🛫 2026-05-25 ⏳ 2026-05-29 📅 2026-06-01 🔺 ⏱️ 4h 🆔 deploy
- [ ] Weekly review 🔁 every Monday 📅 2026-06-01
```

## Obsidian and platform scope

Task Manager requires Obsidian 1.11.4 or later. See [Platform support](PLATFORM_SUPPORT.md) for mobile limitations. The MCP companion is desktop-only.
