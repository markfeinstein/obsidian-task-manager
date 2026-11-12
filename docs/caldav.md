# CalDAV integration

> **Maturity:** Experimental, opt-in, off by default. CalDAV servers vary substantially; use a test calendar and backup.

Task Manager reads a configured CalDAV calendar collection and conditionally reconciles each managed VTODO in its own calendar-object resource, then displays a remote projection in one configured vault note. It requires durable task IDs and provider validators; it does not replace the whole calendar blindly. CalDAV requests and post-read vault publication are cancelled and generation-fenced when the plugin unloads or reloads.

## Setup

1. Create a test calendar/VTODO collection and back it up.
2. In **Settings → Integrations → CalDAV**, enable CalDAV sync.
3. Enter a clean HTTPS server base URL only if you trust both the server and its DNS environment. Credentials and task data are sent to the configured hostname. Userinfo (`user:pass@`), fragments, and redirects are rejected.
4. Enable **Trust CalDAV endpoint** only after verifying that you control or trust the server and its DNS environment. No CalDAV connection is allowed without this explicit trust.
5. Enter username/password, the actual calendar **collection path ending in `/`** (for example `/user/tasks/`), and the vault note path. Read-only Depth-1 PROPFIND must identify a VTODO-capable calendar; an HTTP 200 login page is not a valid connection.
6. Use **Test Connection**.
7. Add a synthetic task with a durable explicit ID and run **Sync CalDAV**.
8. Inspect the vault note, server, run history, and conflict report before using real tasks.

The password uses Obsidian SecretStorage on supported Obsidian 1.11.4+ hosts. If SecretStorage is absent, the host is unsupported or incorrectly side-loaded; do not configure CalDAV credentials in the plaintext `data.json` defensive fallback—upgrade first.

## Transport safety

- HTTPS only; URL credentials/fragments are rejected.
- `redirect: error`; credentials are not forwarded to a redirect target.
- Abortable streaming reads with a 5 MiB response limit.
- Per-origin serialization, bounded pending work, and cooldown after timeout/oversize failures.
- Cross-origin/credentialed/fragments in discovered hrefs are rejected.
- The server must allow the Obsidian app origin through CORS.

The host runtime cannot pin a public hostname's validated DNS address to the TLS request. Explicit endpoint trust therefore includes its DNS resolution and any literal private/local destination. It is not a DNS-rebinding or split-horizon defense. Prefer a server and DNS environment you control.

## Reconciliation

- Fetch/read occurs before writes.
- Managed VTODO identity uses durable UID evidence; tasks without a durable ID are skipped and prevent a full-success outcome.
- Conditional validators such as ETags protect updates from stale writes.
- Local/remote divergence is retained instead of resolving by direction alone.
- A failed read/write or retained conflict does not advance last-success state.
- Repeating the same successful state should be a no-op.

## Collection protocol and legacy snapshots

Collection synchronization discovers object resources with Depth-1 PROPFIND, reads the complete bounded snapshot, and plans all conflicts before writing. Each UID gets a separate conditional PUT (`If-Match` with a strong ETag, or `If-None-Match: *` for a new object) followed by a GET verification. There is no PUT to the collection URL, and no METHOD property in calendar-object payloads. Cross-origin and out-of-collection hrefs, malformed XML/DTDs, duplicate UIDs across resources, unsupported matching recurrence-exception structures, missing validators, and incomplete snapshots stop the run. A collection read is capped at 20,000 objects/32 MiB and the run has a two-minute work budget in addition to per-request deadlines. A partial write batch retains its partial status and is not blindly retried.

An explicit path ending in `.ics` (without a trailing slash) intentionally retains **legacy ICS-over-WebDAV snapshot mode** for compatibility. It is not CalDAV collection synchronization; it reads and conditionally updates one shared file. Existing `.ics/` settings are treated as collection paths and must identify a real collection—there is no automatic fallback that PUTs an aggregate calendar to a collection. New setup should use collection mode. The plugin does not create calendars, propagate remote deletions, or overwrite externally edited managed fields.

## Recurrence interoperability

Exports translate supported scheduled rules (for example `every day` → `FREQ=DAILY`) instead of writing natural language into RRULE. Day/week intervals, named weekdays, supported month/year rules, counts, and end dates are validated; completed counts reduce the remaining exported count. Unsupported/ambiguous rules fail explicitly, including completion-relative `when done` and clamped month/year anchors that do not have identical fixed-RRULE semantics. Unsupported imported RFC rules remain encoded as non-executing `[caldav_rrule:: …]` metadata rather than being silently turned into a different local schedule. A full unified recurrence engine remains separate work. Independent ical.js tests validate parsing and occurrence expansion; it is a development-only dependency and is not bundled into the plugin.

## Managed-field baseline

Each plugin-written VTODO carries `X-OBSIDIAN-TASK-MANAGER-BASELINE`, a portable snapshot of the last written managed properties. A remote-only or divergent managed-field change, missing baseline on an unequal existing object, duplicate property, or malformed baseline stops synchronization without applying a directional overwrite. Equal existing objects can be adopted safely. Unknown properties and nested `VALARM` components remain intact during a permitted local-only update. Do not remove the baseline to force an overwrite; review both copies instead. Historical completed tasks without a known completion date no longer receive a newly fabricated completion timestamp on each run.

## Disable and revoke

1. Stop sync and preserve conflict/run evidence.
2. Disable CalDAV sync.
3. Clear password/server settings.
4. Revoke the app password/session at the server if applicable.
5. Review the test calendar and vault note separately; do not delete remote VTODOs until you have a backup and verified ownership.
