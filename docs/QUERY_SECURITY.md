# Query grammar and security boundaries

Task Manager queries are parsed by repository-owned grammar code. They do not execute arbitrary JavaScript, shell commands, network requests, or vault writes merely by rendering a query.

## Grammar matrix

| Surface | Example | Gate | Capability |
|---|---|---|---|
| Built-in filters | `not done`, `due before tomorrow`, `path includes Projects` | Always available | Compares parsed task/file metadata. |
| Boolean composition | `(priority is high) OR (due today)` | Always available | Combines built-in predicates. |
| Sort/group/layout | `sort by smart`, `group by folder`, `hide tags` | Always available | Orders/groups/presents result snapshots. |
| Saved query/preset expansion | `preset Open work` | Saved query exists; cycles rejected | Expands repository grammar text, not code. |
| Query File Defaults | `TQ_show_tree`, `TQ_extra_instructions` | File defaults enabled and source context supplied | Adds complete query instructions from frontmatter. |
| Safe function-expression DSL | `filter by function task.priority === "high"` | **Enable advanced query DSL** and **Enable function expressions in queries** | Evaluates a restricted AST over task/file fields and allow-listed helpers. It is not JavaScript `eval`. |
| Property placeholders | `{{query.file.property('area')}}` | Source file/property exists | Substitutes a property value. No ternary, concatenation, or arbitrary expression execution. |
| Mustache-style comments | `{{! explanation }}` | Always available | Removed before parsing. |

The former **Allow scripting in queries** toggle was a redundant third gate and has been removed. Legacy stored `enableScripting` values migrate once to **Enable function expressions in queries** only when no explicit modern value exists, then the legacy field is dropped.

## Function-expression restrictions

The safe DSL exposes reviewed task/file projections (for example description, dates, status, priority, properties, links, child counts) and allow-listed operators/helpers. The parser rejects unsupported identifiers/member access, statements, assignment, constructors, and overly complex regular expressions. Disabling either DSL gate rejects `filter/sort/group by function` before evaluation.

Do not treat a shared query as harmless solely because it cannot execute JavaScript: a very broad query can still consume CPU/DOM and reveal task metadata to someone who can view the vault. Keep limits on shared dashboards and review Query File Defaults/frontmatter changes.

## API and CLI context

Renderer, API, and CLI use `TaskQueryService`. Pass a normalized source path only when Query File Defaults from that note should apply. Source-independent API/CLI calls omit those file defaults. All paths remain vault-relative.

See [Query language](tutorials/QUERY_LANGUAGE.md), [API](API.md), and [Meta Bind](meta-bind.md).
