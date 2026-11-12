# Reminder Plugin Vault Fixture

This fixture demonstrates compatibility with the **Obsidian Reminder** plugin format.

## Format Features

- **Reminder dates**: (@YYYY-MM-DD) syntax at the end of task lines
- **Multiple reminders**: Multiple (@date) entries per task
- **Optional time**: (@YYYY-MM-DD HH:mm) format
- **Flexible placement**: Inline or at end of line

## Example Structure

```
- [ ] Task with reminder (@2026-06-15)
- [ ] Task with time reminder (@2026-06-15 14:00)
- [ ] Task with multiple reminders (@2026-06-10) and (@2026-06-15)
```

## Self-Documenting Examples

See `reminder-basic.md`, `reminder-advanced.md`, and `reminder-scheduling.md` for examples.
