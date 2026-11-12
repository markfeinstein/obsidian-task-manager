# Reminders and notifications

> **Important:** Task Manager reminders are polling performed by the Obsidian plugin. They are not guaranteed while Obsidian is suspended or closed.

## Built-in reminder field

```markdown
- [ ] Call dentist ⏰ 2026-07-15 09:00
```

Enable reminder notifications and choose a check interval in settings. The interval checks the shared in-memory task index; quiet ticks do not rescan vault files. When Task Manager executes after the reminder time, it can show an Obsidian Notice and, where the host grants support/permission, request a system notification.

The create/edit modal accepts supported date/time expressions and writes normalized metadata. Date-only reminders do not imply a precise clock alert. A unique explicit task ID gives reminder/snooze actions a vault-wide identity that survives file moves; tasks without IDs use a conservative same-file line identity, and ambiguous/duplicate IDs fail closed.

Due notifications are first committed to a durable delivery outbox. The outbox entry is removed and the fired marker is recorded only after the notification path reports success; a failed or interrupted delivery remains queued for the next healthy check. This is intentionally **at least once**: a crash after the OS accepts a notification but before acknowledgement can repeat the same tagged reminder, which is safer than silently losing it.

## Foreground, background, and closed-app behavior

| State | Expected behavior |
|---|---|
| Obsidian active | Polling runs at the configured interval. |
| Obsidian backgrounded but still executing | Best effort; host/OS can throttle timers. |
| Obsidian suspended or force-closed | No plugin polling or notification. |
| App reopened after a missed time | Missed-reminder state/logging can provide recovery if enabled. |

A native-looking Notification does not mean the plugin can execute while closed. Test permissions and behavior on each OS/device. Use an OS calendar/reminder system independently for safety-critical alerts.

## Reminder-plugin migration syntax

Raw third-party markers such as `(@2026-07-15 09:00)` are **not** silently treated as Task Manager reminders. The command **Convert Reminder plugin syntax in current file** explicitly rewrites supported markers to `⏰` metadata. Back up first and review the diff. If another reminder plugin also reads `⏰`, disable one poller to avoid duplicate alerts; no third-party compatibility guarantee is made here.

## iCal export

**Export all tasks as iCal** creates a one-way snapshot:

- date-only tasks become all-day events;
- tasks with a real time (reminder/date time or `timeStart`) become timed events;
- calendar-app alerts are controlled by that app;
- later task changes require another export.

This is not bidirectional sync.

## Privacy

Web/system notification text can appear on a lock screen. Reminder metadata, task text, and generated logs may sync with the vault. Review [`PRIVACY.md`](PRIVACY.md) and redact sensitive titles where notification previews are visible.

## Troubleshooting

- Keep Obsidian open for the first controlled test.
- Verify the exact `⏰ YYYY-MM-DD HH:mm` value and device clock/time zone.
- Check notification permission and OS focus/battery restrictions.
- Run diagnostics and inspect the missed-reminder log after returning to the app.
- Do not reset task state/dedupe storage as a routine reminder fix.
