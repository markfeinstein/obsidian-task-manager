# Installation and upgrade

> **Pre-release:** Install manually from a source checkout or a package you trust.

## Manual source-evaluation installation

Use a source checkout or a package from a source you trust. A checksum supplied alongside an untrusted package does not prove who made it.

For a source checkout, use the Node version in `.nvmrc` and npm version in `package.json`, then run:

```bash
npm ci
npm run build:prod
```

Then:

1. Back up the vault.
2. Close Obsidian or disable Task Manager.
3. Copy exactly these files into:
   `<vault>/.obsidian/plugins/task-manager/`
   - `main.js`
   - `manifest.json`
   - `styles.css`
   - `versions.json`
4. Reopen Obsidian. Under **Settings → Community plugins**, enable **Task Manager**.
5. Keep network integrations disabled while running the first local smoke test.

## Pre-publication evaluator transition from `obsidian-task-manager`

This section applies only to private/source evaluator builds that used the former `obsidian-task-manager` ID. It does **not** establish a published `1.0.0` lineage or an automatic public upgrade. The permanent release-candidate ID is `task-manager`; the old plugin folder and CLI command are not runtime aliases.

1. Back up the vault and the complete `<vault>/.obsidian/plugins/obsidian-task-manager/` directory.
2. Disable the old installation and close Obsidian.
3. Create `<vault>/.obsidian/plugins/task-manager/` and copy one matching four-file package (`main.js`, `manifest.json`, `styles.css`, and `versions.json`) into it.
4. Before enabling the new ID for the first time, copy the backed-up old `data.json` as a whole into the new directory. Do not merge JSON, and do not overwrite a `data.json` already created by launching the new ID.
5. Rename or remove the old plugin directory so both identities cannot load together.
6. Update desktop CLI/MCP automation from `obsidian-task-manager:query` to `task-manager:query`; no legacy CLI alias is registered.
7. Reopen Obsidian, enable only `task-manager`, run Diagnostics and a rescan, then verify settings plus one local create/edit/complete/query flow before re-enabling integrations.
8. Retain the backup until credentials, pending move/archive journals, generated destinations, and provider settings are checked. If a SecretStorage-backed credential is unavailable under the new identity, re-authorize it instead of copying secrets into notes or scripts.

To roll back this evaluator transition, disable the new ID, restore the old folder with its matching files and `data.json`, and keep the new folder disabled/removed. Rollback does not undo Markdown, generated-file, or provider writes performed while either build was active.

## Upgrade

1. Back up the vault and copy the existing plugin directory/data file.
2. Disable the plugin.
3. Replace all four release files together; do not mix versions.
4. Preserve `data.json` unless release notes explicitly require migration.
5. Re-enable, run diagnostics/rescan, and test one create/edit/complete/query flow before enabling sync.

## Rollback

Disable the plugin, restore the previous four-file package and backed-up `data.json`, then reopen Obsidian. Review any Markdown or remote-service mutations made by the newer version; restoring plugin files does not undo task lines, logs, or remote writes.

## Uninstall and local data

Disable Task Manager, back up anything needed, then remove its plugin directory. Optional generated data can remain in the vault: completion logs, mutation logs/rotations, exports, generated reports/views, task notes, and sync-import notes. Delete those only after reviewing them. Revoke external OAuth grants/tokens and clear provider-side data separately.

## Community Plugins

Only use **Browse → Community Plugins** instructions after the distribution page explicitly confirms the listing and plugin ID `task-manager`. This documentation will not claim a listing before it is verified.
