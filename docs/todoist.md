# Todoist integration

> **Maturity:** Experimental, opt-in, off by default. Use a disposable project and dry-run first. Repository fixtures do not replace a live-account interoperability record.

Todoist sync manages vault tasks tagged `#todoist` and tasks already linked through a provider-prefixed ID. It uses the current Todoist API v1 with bounded cursor pagination and read-first, field-level reconciliation; it is not a last-writer-wins mirror.

## Setup

1. Back up the vault and Todoist project.
2. In Todoist, open **Settings → Integrations → Developer** and create/copy a personal API token.
3. In Task Manager **Settings → Integrations → Todoist**, enable Todoist sync.
4. Enter the API token. Optionally enter a project ID; blank uses the Todoist inbox.
5. Choose the vault inbox note for imports.
6. Enable **Todoist dry run**.
7. Add one synthetic vault task tagged `#todoist` and run **Sync with Todoist**.
8. Review the plan/run history and conflict report. Disable dry-run only after identities and mappings look correct.

The token is stored in Obsidian SecretStorage on supported Obsidian 1.11.4+ hosts. If SecretStorage is absent, the host is unsupported or incorrectly side-loaded; do not configure the token in the plaintext `data.json` defensive fallback—upgrade first. Password masking is not encryption.

## Mapping

| Vault | Todoist |
|---|---|
| Description/title | `content` |
| Child `💬` comments | task description |
| Due date and minute-precision time | API v1 `due.date` (legacy `due.datetime` is also accepted) |
| Priority | Todoist priority mapping |
| Tags | labels |
| Explicit provider ID | Todoist task ID mapping |

Nullable Todoist timezones are accepted. Floating times remain floating; fixed instants are rendered in their named timezone and retained with `[dueTimezone:: Area/City]` (UTC when no zone accompanies an explicit UTC timestamp). This annotation round-trips through the scanner and due-date payload. Assignment, hierarchy, recurrence rules, duration, deadlines, and custom fields are not currently mapped; the capability matrix does not advertise them as supported.

Unsupported/local metadata remains in Markdown and is not proof of a remote baseline. Imported content is sanitized before task syntax is rendered.

## Reconciliation and conflicts

- A pre-existing link with no verified baseline is retained as a conflict.
- Independent local and remote edits are retained; neither side wins by scan order.
- Duplicate vault or Todoist IDs block planning. Repeated sync commands join the active Todoist run, and imports recheck the current inbox atomically before adding or mapping an ID.
- An active-list absence does not authorize a blind reopen.
- Cancelled vault tasks do not cause an erroneous reopen.
- Completion/status operations that cannot be verified from the provider response/read are held rather than marked successful.
- Create failures are retained and are not automatically replayed as though they were idempotent updates.

See [External sync reconciliation contract](SYNC_V2_CONTRACT.md) and [Saved views and sync observability](SAVED_VIEWS_AND_SYNC_OBSERVABILITY.md).

## Disable and revoke

1. Stop automatic/manual sync and preserve unresolved conflict/run evidence.
2. Disable Todoist sync in Task Manager.
3. Remove the token from Task Manager settings.
4. Revoke the personal token in Todoist.
5. Review linked vault/remote tasks before deleting either copy; disabling does not delete or roll back previously synchronized data.

## Known evidence boundary
