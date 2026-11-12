# Google Tasks integration

> **Maturity:** Experimental, opt-in, off by default. Use a disposable list, backup, and dry-run first.

Google Tasks uses read-first three-way reconciliation for linked/imported tasks. It sends managed title, notes/comments, status, **due date only**, and IDs to Google subject to provider capability and evidence checks. The Google Tasks API discards the time portion of its due timestamp, so Task Manager does not claim due-time or timezone round-tripping.

## Setup through the shipped OAuth modal

1. In Google Cloud, create a public OAuth client that permits the Tasks scope:
   `https://www.googleapis.com/auth/tasks`.
2. Add the redirect URI used by Task Manager:
   `http://localhost:42813/oauth/google-tasks/callback`.
   Task Manager does **not** start a localhost listener; the browser may show an unreachable page after authorization. Copy the full URL from the address bar.
3. In Task Manager **Settings → Integrations → Google sync**, enable Google Tasks and open advanced settings.
4. Enter the OAuth client ID and start the Google Tasks authorization flow from the plugin command/setup prompt.
5. Complete sign-in. Paste the **full callback URL** into the **Google Tasks OAuth** modal. When an OAuth state is active, a raw code is rejected because state cannot be verified.
6. Set **Google Tasks list ID** to `@default` or paste a non-default list ID, then configure the vault inbox note. Use **Test Google Tasks** to perform an authenticated read of that list before sync.
7. Enable **Dry-run mode** and run **Sync with Google Tasks**.
8. Review the plan, imported Markdown, run history, and conflict report before disabling dry-run.

The modal exchanges the authorization code with the session PKCE verifier, stores access/refresh/expiry data, and enables the integration. A configured refresh token/client ID is used before sync when the access token is expired or near expiry.

Advanced token fields remain visible for recovery/manual administration; the supported primary journey is the browser + callback modal, not source-helper invocation. Tokens use SecretStorage on supported Obsidian 1.11.4+ hosts. If SecretStorage is absent, do not configure tokens in the unsupported plaintext plugin-data fallback—upgrade first.

## API-key boundary

The legacy API-key field is retained for limited read/import compatibility. Google user-data mutations require an OAuth bearer token. Create/update/delete/writeback attempts with only an API key fail locally. Dry-run never refreshes or persists credentials.

## Mapping and reconciliation

- Imported tasks receive `[id:: google-tasks:<id>]` only after the vault write succeeds.
- Title, notes/comments, status, and due **date** are reconciled per field. Due time/timezone remain local metadata and are not round-tripped by Google Tasks.
- Duplicate vault or Google IDs block writes/imports. Repeated sync commands join the active Google Tasks run, and imports recheck the current inbox atomically before adding or mapping an ID.
- Existing links with no verified baseline and independent edits are retained as conflicts.
- Inbound changes are validated, applied as one atomic Markdown block mutation, and re-read from persisted content before baseline advancement.
- Unsafe provider title/comment syntax is rejected before mutation.
- PATCH, reopen, and delete require a strong ETag and send `If-Match`. A missing validator or HTTP 412 holds the operation for a fresh read and reconciliation; it never falls back to an unconditional write.
- Listings include both completed and hidden tasks so completions made in Google's own clients remain visible.
- Returned provider projections are post-verified where the API permits.
- A complete fetch is capped at 20,000 tasks and 32 MiB of serialized task data, with separate page, pagination-token, ID, title, notes, and date/version limits. Exceeding any limit fails the snapshot before reconciliation, import, absence decisions, baselines, or last-success publication.

See [External sync reconciliation contract](SYNC_V2_CONTRACT.md).

## Disable and revoke

1. Stop sync and preserve unresolved evidence.
2. Disable Google Tasks and clear access/refresh/API-key fields.
3. Revoke the OAuth grant in the Google account/cloud project.
4. Review remote and vault copies separately; disabling does not delete or undo prior changes.
