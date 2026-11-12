# Dataview Fields Vault Fixture

This fixture demonstrates compatibility with the **Dataview** plugin inline field format.

## Format Features

- **Inline fields**: [field:: value] syntax inline in text
- **Field types**: String, number, date, link, list
- **Queryable**: Fields are indexed and queryable via Dataview queries
- **Metadata**: Stored in document but not in frontmatter

## Example Structure

```
- [ ] Task with fields [priority:: high] [effort:: 2h] [team:: backend]
- [ ] Task [owner:: @alice] [status:: in-progress] [deadline:: 2026-06-15]
```

## Self-Documenting Examples

See `dataview-basic.md` and `dataview-advanced.md` for examples.
