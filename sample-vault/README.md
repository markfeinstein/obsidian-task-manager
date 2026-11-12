# Task Manager disposable sample vault

Open `sample-vault/` as its **own disposable Obsidian vault**. Do not copy its `.obsidian` directory into a real vault. Back up before experimenting with lifecycle/archive/import commands.

The tracked notes use fixed dates from May/June 2026 so regression examples remain deterministic. `Daily/2026-05-26.md` is a fixture day, not “today.” For a current visual-review copy, run `npm run sample:seed -- --date YYYY-MM-DD --output ../task-manager-sample-today`; the command shifts every valid fixture date by the same offset and never rewrites the tracked sample vault.

## Plugin files

The sample tracks manifest/style/version/settings fixtures for release QA but intentionally does not track `main.js`. Install one verified four-file release package into the sample's `.obsidian/plugins/task-manager/` directory using [`../docs/INSTALLATION.md`](../docs/INSTALLATION.md). Confirm all files share the same version/checksum source.

To build from source, use the Node and npm versions specified by the repository, then run these commands from the repository root:

```bash
npm ci
npm run build:prod
mkdir -p sample-vault/.obsidian/plugins/task-manager
cp main.js manifest.json styles.css versions.json sample-vault/.obsidian/plugins/task-manager/
```

Network integrations, AI/voice, callbacks/webhooks, sync, and reminder notifications are disabled in the sample settings. Review [`../docs/PRIVACY.md`](../docs/PRIVACY.md) before enabling any of them.

This vault is an **advanced visual showcase**, not the pristine Local basics profile: habits and gamification are intentionally enabled so their fixtures can be reviewed. Those features are off in product defaults and should remain off for the recommended first-run journey in [`../docs/PERSONA_JOURNEYS.md`](../docs/PERSONA_JOURNEYS.md). Disable both toggles when evaluating the minimal core experience.

## Structure

```text
Daily/2026-05-26.md        fixed fixture daily note and Log section
Projects/Website Redesign.md
Queries/Dashboard.md       query/list/Kanban/calendar examples
Showcase/Queries.md        standalone grouped-query screenshot
Showcase/Kanban.md         standalone project-board screenshot
Showcase/Calendar.md       standalone calendar screenshot
Showcase/Table.md          standalone metadata-table screenshot
Habits/Habits.md
```

The `Showcase/` notes contain queries only, not duplicate tasks. Open them in Reading view in the current-date copy for reproducible captures; their results come from the existing synthetic notes. Keep integrations and reminders disabled.

## Safe quick start

1. Back up or discard any previous copy of the sample.
2. Open `sample-vault/` directly in Obsidian.
3. Install the verified plugin package manually and enable it.
4. Keep integrations/reminders off.
5. Open `Queries/Dashboard.md`, run a rescan, then test one synthetic create/edit/complete flow.
6. Review all generated/changed Markdown with source control or a directory diff.

## Reset

Close Obsidian and replace your disposable sample copy with a fresh one. Removing plugin files alone does not undo changes to notes, generated logs, or remote data.
