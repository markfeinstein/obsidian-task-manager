# Task Genius Vault Fixture

This fixture demonstrates compatibility with the **Task Genius** plugin format.

## Format Features

- **Custom checkboxes**: Various checkbox states (-, >, <, /, ?, !, +, ~)
- **Progress tracking**: Subtask completion percentage
- **Custom metadata**: Task type, category, urgency markers
- **Advanced syntax**: Multi-level nesting and hierarchy

## Checkbox Types

- `[ ]` - Todo
- [x] - Done
- [-] - Cancelled
- [>] - Delegated
- [<] - Waiting
- [/] - In Progress
- [?] - Question
- [!] - Important
- [+] - Added
- [~] - Recurring

## Example Structure

```
- [/] Task in progress
- [>] Task delegated to someone
- [<] Waiting on information
```

## Self-Documenting Examples

See `genius-basic.md` for examples.
