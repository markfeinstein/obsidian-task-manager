# Meta Bind Integration

[Meta Bind](https://obsidian.md/plugins?id=obsidian-meta-bind-plugin) is a community plugin that renders interactive controls — dropdowns, toggles, sliders, date pickers — bound to note properties (YAML frontmatter). Combining it with Task Manager's **Query File Defaults** lets you build visual dashboards where filters and display options can be changed with a click instead of editing the query block.

---

## How Query File Defaults Work

Any note that contains a `task-list` code block can declare YAML frontmatter properties starting with `TQ_` to override query defaults for every block on that page:

```yaml
---
TQ_show_tree: true
TQ_short_mode: false
TQ_show_toolbar: true
TQ_show_urgency: true
TQ_extra_instructions: |
  sort by urgency
  limit 50
---
```

You can add all available `TQ_*` keys at once with the command **Add all Query File Defaults properties**.

---

## Building an Interactive Dashboard with Meta Bind

Install Meta Bind (community plugins) and then add controls bound to the `TQ_*` properties:

### Toggle short mode on/off

```markdown
`INPUT[toggle:TQ_short_mode]` Short mode
```

### Switch sort order with a dropdown

Add a custom property (e.g. `sort_choice`) and reference it in `TQ_extra_instructions`:

```yaml
---
sort_choice: urgency
TQ_extra_instructions: "sort by {{query.file.property('sort_choice')}}"
---
```

Then add a Meta Bind dropdown:

```markdown
`INPUT[select(option(urgency), option(due), option(priority), option(smart)):sort_choice]` Sort by
```

### Filter by folder with a text input

```yaml
---
folder_filter: Projects
TQ_extra_instructions: "path includes {{query.file.property('folder_filter')}}"
---
```

```markdown
`INPUT[text:folder_filter]` Folder filter
```

### Full example dashboard frontmatter

```yaml
---
TQ_show_tree: false
TQ_short_mode: false
TQ_show_toolbar: true
TQ_extra_instructions: "path includes Projects"
---
```

And the note body:

```markdown
`INPUT[toggle:TQ_show_tree]` Show tree  
`INPUT[toggle:TQ_short_mode]` Compact  
`INPUT[text:TQ_extra_instructions]` Extra query instruction (for example `path includes Projects`)

\`\`\`task-list
not done
sort by smart
limit 30
\`\`\`
```

---

## Tips

- Use `query.file.property('key')` inside `filter by function`, `sort by function`, or `group by function` blocks to read any frontmatter property dynamically.
- `TQ_extra_instructions` accepts multiple lines (use YAML literal block scalar `|`) and supports the full query DSL, including boolean filters, sort, group, and limit.
- Changes to frontmatter properties take effect on the next query render/refresh without editing the code block.
- Task Manager placeholders substitute property values; they do not execute JavaScript ternaries or string concatenation. Put the complete instruction (for example `path includes Projects`) in `TQ_extra_instructions`.
- Meta Bind's `INPUT[inlineSelect(...)]` creates compact inline dropdowns, ideal for putting a sort selector right above a query block.

See the upstream Tasks documentation on [Query File Defaults](https://publish.obsidian.md/tasks/Queries/Query+File+Defaults) for the full list of supported `TQ_*` keys.
