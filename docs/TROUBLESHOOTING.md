# Troubleshooting

## Start safely

Back up the vault, disable network integrations, and reproduce with synthetic tasks in a disposable note. Never paste unredacted `data.json`, tokens, private task text, or mutation logs into public support.

## Tasks are missing

1. Run **Rescan current file** or **Rescan vault now**.
2. Check excluded folders and the global filter.
3. Confirm the line is a Markdown list item with a configured checkbox marker.
4. Run **Show task status diagnostics** for unknown markers.
5. For Canvas, remember indexed tasks are read-only until copied to Markdown.

## Query block does not render

- Use the configured block name (default `task-list`).
- Check whether upstream `tasks` block registration is disabled because Obsidian Tasks is installed.
- Add `explain` to inspect parse/recurrence warnings.
- Test the query with a minimal block: `not done\nsort by smart`.

## A mutation is refused

Task Manager refuses stale/ambiguous identity, a relocated or changed source line, unsafe lifecycle combinations, and conflicting remote validators. Reopen/rescan the source and retry; do not work around a refusal by editing a different line number.

## Duplicate or missing completion logs

- Completion logging is off by default; verify **Settings → Task Manager → Logging → Enable completion logging** is on before expecting daily-note entries.
- A task logs only on a non-done → done transition after logging is enabled.
- Do not reset snapshot/dedupe state during ordinary use.
- Verify daily-note folder/date settings and the configured log heading.
- Today's daily note is intentionally not logged back into itself as a source link.

## Archive or collect reports pending reconciliation

Task Manager journals archive/collect transfers before writing the destination. On restart it automatically rolls back or completes only when exact source, destination, and marker evidence agrees. If a notice reports pending manual reconciliation, preserve both files and `data.json`, open diagnostics, and compare the named source/destination before editing or deleting either copy. Do not remove `<!-- task-manager-lifecycle:... -->` markers until the journal is reconciled; ambiguous edits intentionally remain fail-closed.

## Reminders do not fire while closed

The plugin needs Obsidian/JavaScript execution. Mobile OS suspension or force-close prevents polling. Enable missed-reminder logging for recovery and see [`PLATFORM_SUPPORT.md`](PLATFORM_SUPPORT.md); it is not a background-service guarantee.

## Sync problem

1. Stop automatic sync and preserve the run history/error.
2. Back up affected local and remote lists.
3. Check credentials, token expiry, destination/list IDs, and dry-run preview.
4. Resolve retained conflicts explicitly; failed operations remain recoverable rather than being silently dropped.
5. CalDAV 409/412 means the remote validator changed—read again rather than overwriting.
6. Revoke a credential if logs/screenshots may have exposed it.

## Dashboard/layout problem

Use **Clean up layout** or reset a specific layout only after preserving settings. Empty setup widgets remain open; clear alert widgets may collapse. On narrow panes the dashboard intentionally stacks into one column.

## Plugin will not load

- Verify the four files and versions came from one package.
- Compare the ZIP/file hashes with `SHA256SUMS`.
- Check Obsidian's developer console for the first error.
- Reinstall the previous known-good package to distinguish artifact from data issues.

## Recovery and support

Preserve backups before deleting plugin data; clearing `data.json` loses settings, snapshots, mappings, histories, and queued sync state but does not revert Markdown or remote changes.
