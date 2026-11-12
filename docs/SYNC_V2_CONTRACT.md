# External sync and conflicts

External sync is optional and off by default. Back up your vault and remote data, start with a test list, and use dry-run where available. Read [Privacy](PRIVACY.md) and the provider's setup guide before entering credentials.

## How conflicts work

For supported fields, Task Manager compares the current vault value and remote value with the last verified value. If only one side changed, it can sync that change. If both sides changed independently, an existing link has no trustworthy baseline, or the data is ambiguous, it retains a conflict rather than choosing a side automatically.

Duplicate task IDs block identity-sensitive sync. Give each task a unique ID before retrying. Conflicts survive a restart and appear in **Open sync conflict report**. Choosing a value in the report does not itself write it to the provider; review the next sync result.

A run can be partial or failed even if some changes succeeded. Dry-run shows a plan and does not perform the planned writes.

## Providers

| Provider | What it does | Important limits |
|---|---|---|
| [Todoist](todoist.md) | Reconciles managed tasks, including supported titles, dates, priorities, labels, and comments. | Unverified existing links and conflicting edits require review. |
| [Google Tasks](google-tasks.md) | Reconciles supported task fields. | Due times and time zones do not round-trip; OAuth is required for writes. |
| [Microsoft To Do](microsoft-todo.md) | Reconciles supported task fields through Microsoft Graph. | Reminder fields are not managed; OAuth is required. |
| [CalDAV](caldav.md) | Reconciles tasks in a configured calendar collection. | Requires a trusted HTTPS endpoint and a compatible server; see the setup guide. |
| [Google Calendar](google-calendar.md) | Exports or updates events from tasks. | This is not bidirectional task sync. |
| [Apple Reminders](apple-reminders-webhook.md) | Imports a Shortcut's JSON from the clipboard. | It does not write back to Apple Reminders. |

## Resolve a conflict

1. Stop automatic sync and keep the run history.
2. Open **Open sync conflict report** and note the provider, task, field, and reported values.
3. Inspect both copies. Fix duplicate IDs and decide which value should be kept; do not delete either copy just to clear the report.
4. Retry the explicit sync or reconciliation, then check both copies and the run result.

See [Sync history](SAVED_VIEWS_AND_SYNC_OBSERVABILITY.md) and [Troubleshooting](TROUBLESHOOTING.md).
