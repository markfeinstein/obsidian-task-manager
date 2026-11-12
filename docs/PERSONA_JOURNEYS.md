# Choose a workflow

Start with local tasks and add features as you need them. You do not need to enable integrations to use Task Manager.

## Local tasks

1. Create a task in a note using the create/edit modal.
2. Add a `task-list` block with `not done` and `sort by smart`.
3. Complete and reopen the task from a query or the sidebar; check the source note to see the change.
4. If you want completion logs, choose a daily-note destination and enable logging in settings. It is off by default and may create or modify a daily note when enabled.
5. Add task IDs when you need dependencies or sync. Use the task health report to find duplicate IDs.

See [Getting started](tutorials/GETTING_STARTED.md) and [Settings](SETTINGS.md).

## Planning

Open the sidebar and try Today, Upcoming, and Agenda. Then open the dashboard and add the widgets you need. The daily planner and weekly review can help you plan ahead. Back up your vault before using archive or collect actions.

## Mobile

Use quick capture, the task editor, and the sidebar while Obsidian is open. Reminders cannot run while the operating system suspends or closes Obsidian. The MCP companion is desktop-only. See [Mobile](mobile.md) and [Platform support](PLATFORM_SUPPORT.md).

## Sync

1. Back up your vault and remote data.
2. Choose one provider and read its guide and [Privacy](PRIVACY.md).
3. Start with a test list and task. Use dry-run if available and check the result on both sides.
4. Review any conflicts before retrying. Test one provider at a time before using real tasks.

## Automation

Function expressions use a restricted query language, not JavaScript, and are disabled by default. The experimental [runtime API](API.md) returns task snapshots; treat them as read-only. The separate desktop [MCP companion](MCP.md) supports queries and searches, not writes. Test workflows in a disposable vault and treat mutation logs as sensitive data.
