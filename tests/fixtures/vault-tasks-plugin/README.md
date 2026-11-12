# Obsidian Tasks format fixture

This fixture exercises the subset of the open-source **Obsidian Tasks** Markdown format that Task Manager parses through its production scanner.

## Supported markers

- Dates: `📅` due, `⏳`/`⌛` scheduled, `🛫` start, `✅` done, `➕` created, `❌` cancelled
- Priority: `🔺` highest, `⏫` high, `🔼` medium, no marker normal, `🔽` low, `⏬` lowest
- Recurrence: `🔁 <rule>`
- Effort: `⏱️ <duration>`
- Task ID: `🆔 <id>`
- Dependency: `⛔ <id>`

```markdown
- [ ] Task with dates 🛫 2026-06-01 ⏳ 2026-06-10 📅 2026-06-15
- [ ] Highest priority task 🔺
- [ ] Daily standup 🔁 every weekday 📅 2026-06-15
- [ ] Multi-day effort ⏱️ 2d
```

See `basic-tasks.md`, `advanced-tasks.md`, and `filtered-tasks.md`. Compatibility tests scan these files with `TaskScanner`; a green test is not based on a separate fixture-only regex.
