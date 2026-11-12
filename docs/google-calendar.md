# Google Calendar integration

> **Maturity:** Experimental, opt-in, off by default. This is task-to-event export/upsert, not the shared bidirectional Google Tasks reconciliation contract.

Vault tasks tagged `#google-calendar` can be mapped to all-day/timed events in one configured calendar. Successful task→event mappings are checkpointed so a later failure does not cause already-created events to be recreated on the next run.

## Setup through the shipped UI

1. Back up the vault and use a disposable Google Calendar.
2. In Google Cloud, create an OAuth client appropriate for the redirect/callback flow shown by the Task Manager setup wizard. Configure only the scopes the wizard/provider guide requests.
3. In Task Manager **Settings → Integrations → Google sync**, open **Setup wizard**.
4. Enter the OAuth client ID and follow the browser authorization URL.
5. Return the complete callback URL/code to the modal. When state validation is active, a raw code without the expected state is rejected.
6. Choose a calendar ID (`primary` by default), reminder behavior, and enable dry-run.
7. Add one synthetic `#google-calendar` task and run **Sync with Google Calendar**.
8. Review planned/events and mapping history before disabling dry-run.

Access/refresh tokens use SecretStorage on supported Obsidian 1.11.4+ hosts. If SecretStorage is absent, the host is unsupported or incorrectly side-loaded; do not configure tokens in the plaintext plugin-data defensive fallback—upgrade first. Do not paste tokens into notes, logs, issues, or screenshots.

## Behavior and limits

- Creating a new event requires a unique durable task ID. Duplicate or missing durable identity fails before a Calendar mutation.
- Task Manager derives a stable Google-valid event ID and a non-reversible private mapping digest from that durable identity. The digest contains no task text or vault path.
- Before a create, Task Manager reads the deterministic event ID. An existing event is patched; a 404 permits one POST. A lost create response or 409 is recovered by ID before another write, preventing duplicate retry creates.
- Existing explicit/provider IDs and persisted mappings remain update targets and are reused on later syncs.
- Each successful mapping is persisted before the next task, limiting duplicate creation after partial failure.
- Title/date/time are sanitized and mapped to Google event fields. Vault file path and line number are not included in the event.
- Calendar default reminders can be used, or a non-negative popup offset can be configured.
- Dry-run counts/plans events without writing them.
- This path does not claim remote-to-vault conflict-safe task synchronization. Use [Google Tasks](google-tasks.md) for the task provider, subject to its separate maturity/contract.

## Disable and revoke

1. Stop sync and preserve failed run/mapping evidence.
2. Disable Google Calendar sync and clear tokens.
3. Revoke the OAuth grant in the Google account/cloud project.
4. Review mapped events before deleting them; disabling does not remove events already created.
