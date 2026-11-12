# Privacy and data flow

> **Status:** User-facing safety reference. Last verified for source version 0.1.0.

Task Manager is local-first. Core Markdown scanning, queries, dashboards, planning, completion logging, and local exports do not require a network service. Every integration below is opt-in. Enabling one may transmit task text, metadata, selected note content, audio, file paths, or credentials to the configured recipient.

## Before enabling a network feature

- Use synthetic data first and keep a vault backup.
- Read the provider's privacy, retention, and account-security terms.
- Grant the narrowest token scope available.
- Do not paste secrets into task text, logs, screenshots, issues, or support messages.
- Disable the feature and revoke its token at the provider when finished.

## Data-flow inventory

| Feature | Default | Destination | Data sent | Local storage / removal |
|---|---|---|---|---|
| Todoist | Off | Todoist API | Managed task text, completion state, dates, priority, labels/comments, external IDs | Token uses Obsidian SecretStorage on supported hosts. Disable, clear the token, and revoke it in Todoist. |
| Google Tasks | Off/experimental | Google OAuth and Tasks API | Managed task text, status, dates/notes, list/task IDs | Access/refresh/API tokens use SecretStorage on supported hosts. Revoke the OAuth grant and clear settings. |
| Google Calendar | Off/experimental | Google OAuth and Calendar API | Task title, dates/times, reminder configuration, deterministic event ID, and a non-reversible private mapping digest; vault path/line are not sent | Access/refresh tokens use SecretStorage on supported hosts. Revoke and clear. |
| Microsoft To Do | Off/experimental | Microsoft identity platform and Graph | Managed task title/body, status, due date/time/timezone, importance, and list/task IDs; Microsoft reminder fields are unmanaged and are not emitted or inferred | Access/refresh tokens use SecretStorage on supported hosts. Revoke the app grant and clear. |
| CalDAV | Off | User-configured HTTPS CalDAV URL; local/private literals require a separate explicit trust toggle | Credentials plus managed VTODO/ICS content and validators such as ETags | Password uses SecretStorage on supported hosts. URL userinfo/fragments are rejected, redirects fail closed, and the server must allow the Obsidian app origin through CORS. Clear credentials and remove remote managed items only after reviewing a backup. |
| Remote ICS overlay/import | Disabled | None in the production plugin | No request is sent | Existing URL settings are retained for migration. The mobile-safe host transport cannot bind validated DNS to TLS and reject redirects, so arbitrary remote feeds fail closed. Download/review data through a local workflow instead. |
| Generic arbitrary-URL webhooks | Not supported/removed | None in the production plugin | No request is sent | The former unreachable notifier/webhook modules were deleted; there is no outgoing generic webhook setting/path. |
| AI task-query generation | Off | OpenAI, Anthropic, or explicitly configured local endpoint | The natural-language query entered in the AI search modal plus the fixed query-grammar instruction; task/vault content is not included by this modal | API key uses SecretStorage on supported hosts. Provider retention is controlled by that provider/account. Clear/revoke the key. |
| Voice capture: Web Speech | User action | Browser/OS speech provider, which may be cloud-backed | Microphone audio/transcript as determined by the browser/OS | No recording is intentionally persisted by Task Manager; stop/close releases tracks and chunks. Provider behavior is outside the plugin. |
| Voice capture: Whisper | Off until key + user action | OpenAI Whisper API | The recorded audio blob, capped at 24 MiB and 10 minutes | Whisper key uses SecretStorage on supported hosts. Uploads have a 60-second deadline and can be cancelled; tracks/chunks are cleared after completion/abort. Revoke/clear key. |
| Apple Reminders Shortcut import | Off | User-operated Shortcut → system clipboard → explicit plugin command | Reminder title/notes, completion state, dates, external IDs, optional shared secret | Secret uses SecretStorage on supported hosts. Clipboard is not encrypted by the plugin. No EventKit, HTTP listener, MCP mutation tool, or native writeback is bundled. |
| External URI actions | Off | Current vault only | Vault-targeted task text or note path from an `obsidian://` link | Requires explicit opt-in, an exact current-vault name, and a SecretStorage-backed shared secret. Treat full URIs as credentials. Callback delivery remains blocked because capture URIs are untrusted and the host transport cannot pin DNS/reject redirects. |
| Desktop MCP companion | Separate/off | `127.0.0.1` only | Read-only query/search results returned to the authenticated local client | Bearer token is an environment variable for the companion. Stop the process and rotate/remove the token. Not available on mobile. |

## AI query provider controls

The optional AI search helper sends only the entered question and fixed query-grammar instructions, never the task index or vault contents. Anthropic direct browser access additionally requires an explicit default-off setting; enabling AI or migrating settings does not grant it. With that consent, requests include Anthropic's documented browser-access header and use a dedicated API key from this client. Other code running in the client may access a key; some organizations (including documented ZDR/Compliance configurations) prohibit browser requests regardless of the header. The plugin does not bypass those restrictions. Use local Ollama/LM Studio or a suitable alternative when browser access is prohibited.

Both the malformed former default and its retired correctly spelled Haiku 3.5 identifier migrate to the documented, still-available pinned `claude-haiku-4-5-20251001`; custom model choices remain intact. This is a compatibility repair, not a claim that Haiku 4.5 is Anthropic's latest model or that a live account/model-quality evaluation has run. OpenAI Chat Completions requests explicitly set `store: false`; this disables stored completions, **not** all provider retention. Empty AI replies are rejected instead of becoming unrestricted queries.

## Credential storage

Task Manager's supported minimum, Obsidian 1.11.4, exposes SecretStorage. Task Manager migrates active provider API keys, OAuth tokens, CalDAV passwords, AI/Whisper keys, and the Apple clipboard-import secret into it and clears their plaintext setting fields. The retired embedded-MCP token is scrubbed from both legacy plugin data and SecretStorage rather than retained as an invisible setting. If SecretStorage is unavailable, the host is unsupported or incorrectly side-loaded and Task Manager refuses to save active credentials. Upgrade before configuring a network integration. Password input masking is not encryption.

SecretStorage protects against accidental plaintext copying, not a compromised OS account or Obsidian process. Rotate credentials after device loss, suspicious logs, an overly broad backup/share, or accidental disclosure.

## Local copies and retention

Task data may be duplicated in daily completion logs, mutation JSONL logs and rotations, temporary archive/collect recovery journals, exports, sync history, cached ICS events, generated reports, task notes, and backups. Retention follows the relevant setting and the vault's own sync/backup policy. To remove data, disable the feature, clear its setting/cache where offered, delete generated files after backup, and verify remote/provider copies separately.

Diagnostics should not display stored credential values, but filenames, task counts, error text, and integration state can still be sensitive. Redact them before sharing.

## Network and lifecycle limits

Fixed OAuth/provider and AI requests keep cancellation/deadlines active through full body consumption, reject redirects, and enforce bounded streaming responses (256 KiB for OAuth/Whisper responses, 1 MiB for AI responses, and 5 MiB default provider pages). CalDAV separately uses abortable `fetch` with redirects disabled, a 5 MiB streaming response bound, per-origin serialization, a bounded pending queue, and a cooldown circuit after timeouts/oversized responses. This fail-closed transport requires the CalDAV server to allow the Obsidian app origin through CORS. The private-network toggle covers literal localhost, `.local`, loopback, link-local, and private addresses; the host API cannot pin a public hostname's DNS result, so enable private trust only for a destination you control.

Disabling/reloading the plugin does not guarantee a third-party service has cancelled a request it already received. Review remote state after interrupted sync.

