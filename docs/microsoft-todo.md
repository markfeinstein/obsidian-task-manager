# Microsoft To Do integration

> **Maturity:** Experimental, opt-in, off by default. Use a disposable list, backup, and dry-run first.

Microsoft To Do uses read-first three-way reconciliation for linked/imported tasks through Microsoft Graph. It handles supported title/body/comments, status, due date/time/timezone, importance, list/task IDs, and remote version evidence. Microsoft reminder fields are currently unmanaged and are not inferred from due dates.

## Setup through the shipped OAuth modal

1. In Microsoft Entra/Azure, create a **public client** app registration.
2. Add the native-client redirect URI:
   `https://login.microsoftonline.com/common/oauth2/nativeclient`.
3. Configure delegated scopes required by the shipped flow: `Tasks.Read`, `Tasks.ReadWrite`, and `offline_access`. Grant only the consent appropriate for the test account.
4. In Task Manager **Settings → Integrations → Microsoft To Do**, enable the integration and enter the client ID.
5. Start the Microsoft authorization command/flow. Complete sign-in in the browser.
6. Paste the resulting full callback URL into the **Microsoft To Do OAuth** modal. When state validation is active, a raw code is rejected because state cannot be checked.
7. Optionally set a list ID; blank resolves the default list through Graph. Set the vault inbox note.
8. Enable dry-run and run **Sync Microsoft To Do**.
9. Review the plan, imported Markdown, run history, and conflict report before live writes.

The modal exchanges the PKCE code, stores access/refresh/expiry data, and enables sync. Refresh occurs before a non-dry run when the access token is expired/near expiry and a refresh token/client ID exists. Advanced token fields are for recovery/manual administration; source helper calls are not the primary setup journey.

Tokens use SecretStorage on supported Obsidian 1.11.4+ hosts. If SecretStorage is absent, the host is unsupported or incorrectly side-loaded; do not configure tokens in the plaintext `data.json` defensive fallback—upgrade first.

## Mapping and reconciliation

- Imported tasks receive `[id:: ms-todo:<id>]` only after a successful vault write.
- Supported Graph `notStarted`, `inProgress`, `deferred`, and completed states map to reviewed vault states; malformed pages/items and unsupported statuses fail the snapshot closed rather than being treated as remote absence.
- Importance maps to supported priority values.
- Duplicate vault/Graph IDs block imports and writes. Repeated sync commands join the active Microsoft To Do run, and imports recheck the current inbox atomically before adding or mapping an ID.
- Existing links without baseline and independent edits are retained as conflicts.
- Inbound changes are validated, applied atomically to the Markdown block, and re-read before baseline advancement.
- Dry-run does not refresh/persist credentials or mutate either side.
- Delete-missing behavior requires a certified complete linked local snapshot; empty/unlinked inputs cannot authorize broad remote deletion.
- A complete task fetch is capped at 20,000 tasks and 32 MiB of serialized task data, with separate page, next-link, list, ID, title, body, date/timezone, and version limits. Exceeding any limit fails closed before reconciliation, import, absence decisions, baselines, or last-success publication.

See [External sync reconciliation contract](SYNC_V2_CONTRACT.md).

## Disable and revoke

1. Stop sync and preserve unresolved evidence.
2. Disable Microsoft To Do and clear access/refresh/client fields.
3. Revoke the app grant/session from the Microsoft account/Entra portal.
4. Review Graph and vault copies separately; disabling does not undo prior writes.
