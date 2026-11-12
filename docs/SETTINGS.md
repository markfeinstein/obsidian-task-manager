# Settings guide

Open **Settings → Task Manager** and use the search field to find a setting by name or description. The [settings reference](SETTINGS_REFERENCE.md) lists individual controls and defaults. Invalid numeric values show an error and are not saved.

## General

Configure scanning, editor features, completion logging, reminders, language, and quick capture. File events normally update the task index; periodic scans help pick up external edits.

## Queries

Configure filters, task states, custom fields and priorities, saved queries, and table defaults. Function expressions require two settings and use a restricted language, not arbitrary JavaScript. See [Query security](QUERY_SECURITY.md). Reordering states changes the status cycle.

## Views

Configure daily logs, the focus timer, habits, appearance, Kanban boards, and saved view presets.

## Sync

Configure Todoist, CalDAV, Google Tasks, Google Calendar, Apple Reminders, and Microsoft To Do. These integrations are off by default. Read [Privacy](PRIVACY.md) and the provider guide, back up your data, and try dry-run where available before syncing real tasks.

## Automation

Configure recurrence, voice capture, AI, and workflows. Voice recognition may use a browser or operating-system service; the Whisper fallback uploads audio to OpenAI. AI search sends your query to the selected provider. Test workflows in a disposable note because they can create tasks.

## Advanced

Configure missed-reminder and mutation logging and Planning Board behavior. Mutation logs can contain sensitive task history. The desktop MCP companion is a separate process; configure its port and token in its environment, not in plugin settings.

## Paths and credentials

Output paths must be relative to the vault root; absolute paths and `..` traversal are rejected. Check for existing files before exporting.

Supported Obsidian versions use SecretStorage for credentials. If SecretStorage is unavailable, upgrade Obsidian before configuring credentials. See [Privacy](PRIVACY.md).

Back up settings and data before deleting states, queries, templates, fields, priorities, workflows, or presets, or before changing sync identity or running migration/repair commands.

Changing the query code-block language or upgrading plugin files can require a plugin reload. Restart the desktop MCP companion after changing its environment, port, or token.
