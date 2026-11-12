# Kanban Boards Vault Fixture

This fixture demonstrates compatibility with the **Obsidian Kanban** plugin format.

## Format Features

- **YAML frontmatter**: Plugin stores board metadata in YAML
- **Lane structure**: Each lane represents a column (e.g., Todo, In Progress, Done)
- **Card tasks**: Checkboxes represent individual cards on the board
- **Metadata**: board-id, order tracking, created timestamps

## Example Structure

```yaml
---
kanban-plugin: basic
---

## Todo

- [ ] Design feature
- [ ] Review requirements

## In Progress

- [ ] Implement API

## Done

- [x] Setup project
- [x] Database schema
```

## Self-Documenting Examples

See `board-simple.md` and `board-complex.md` for examples.
