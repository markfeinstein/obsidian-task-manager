# Desktop MCP companion

> **Status:** Experimental, desktop-only, separate process, and read-only. Last verified for source version 0.1.0.

Task Manager's production Obsidian plugin is mobile-safe and does **not** embed Node's HTTP/MCP server. The repository provides `scripts/mcp-companion.mjs` as a separate desktop process. It forwards read-only queries through Obsidian's CLI handler.

The companion currently exposes exactly two tools:

- `query_tasks` — run Task Manager query DSL;
- `search_tasks` — search task descriptions.

It does not expose create/update/complete/undo/import tools. The former embedded `src/mcp-server.ts` reference implementation was production-unreachable and has been removed; `scripts/mcp-companion.mjs` is the only repository-owned MCP server implementation.

## Prerequisites

- Desktop Obsidian with its CLI available as `obsidian` (or set `OBSIDIAN_CLI`).
- Task Manager enabled and its CLI handler available.
- Node 22+ for the companion process.
- The companion script from the same verified release/source revision. The normal plugin ZIP still contains exactly the four Obsidian plugin files; the companion is a separate release asset.

Phones/tablets cannot run this process.

## Start

Create a strong random bearer token, then launch from a source checkout:

```bash
export OBSIDIAN_TASK_MANAGER_TOKEN='replace-with-a-long-random-secret'
export OBSIDIAN_TASK_MANAGER_MCP_PORT=7777
# Optional when the CLI executable is not named `obsidian`:
export OBSIDIAN_CLI='/absolute/path/to/obsidian'
npm run mcp:companion
```

Or run the verified standalone asset:

```bash
node mcp-companion.mjs
```

The process binds only to `127.0.0.1`. Restart it after changing port/token/environment. Keep the token out of shell history, screenshots, logs, and client config committed to source control.

## Protocol layers

- Transport: HTTP on loopback, endpoint `http://127.0.0.1:<port>/mcp`
- Envelope: JSON-RPC 2.0
- Negotiated MCP protocol version: `2025-06-18`
- Companion implementation version: `0.1.0`
- Authentication: `Authorization: Bearer <token>` for every `/mcp` request
- Health: unauthenticated `GET /mcp/health` returns only `{ "status": "ok" }`
- Sessions/SSE: `initialize` issues a bounded `Mcp-Session-Id`; authenticated `GET /mcp` returns `405` because no SSE stream is exposed

The companion implements session-scoped Streamable HTTP: one POST message at a time, JSON responses for requests, and `202` with an empty body for accepted notifications/client responses. Sessions isolate lifecycle and cancellation IDs between clients. It does not provide an SSE stream, resumability, JSON-RPC batches, or server-initiated requests. “MCP protocol version,” JSON-RPC version, and companion implementation version are separate values.

The canonical Obsidian CLI handler is `task-manager:query`. Private evaluator automation that still invokes `obsidian-task-manager:query` must be updated manually; no runtime alias is registered. Follow the [pre-publication evaluator transition](INSTALLATION.md#pre-publication-evaluator-transition-from-obsidian-task-manager) before launching the new identity.

After `initialize`, send `notifications/initialized`; only then call tools. Every request after `initialize` must carry `MCP-Protocol-Version: 2025-06-18`. POST clients must advertise both supported response forms with `Accept: application/json, text/event-stream`; this companion always chooses JSON for requests.

## Verify without an external client package

Initialize and capture the returned session ID:

```bash
headers_file="$(mktemp)"
curl --fail-with-body -D "$headers_file" http://127.0.0.1:7777/mcp \
  -H "Authorization: Bearer $OBSIDIAN_TASK_MANAGER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-check","version":"1"}}}'
export MCP_SESSION_ID="$(awk 'BEGIN{IGNORECASE=1} /^Mcp-Session-Id:/ {gsub("\\r", "", $2); print $2}' "$headers_file")"
rm -f "$headers_file"
test -n "$MCP_SESSION_ID"
```

Complete initialization:

```bash
curl --fail-with-body http://127.0.0.1:7777/mcp \
  -H "Authorization: Bearer $OBSIDIAN_TASK_MANAGER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  --data '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
```

A successful notification returns HTTP `202` with an empty body.

List tools:

```bash
curl --fail-with-body http://127.0.0.1:7777/mcp \
  -H "Authorization: Bearer $OBSIDIAN_TASK_MANAGER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Call a query:

```bash
curl --fail-with-body http://127.0.0.1:7777/mcp \
  -H "Authorization: Bearer $OBSIDIAN_TASK_MANAGER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -H "Mcp-Session-Id: $MCP_SESSION_ID" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"query_tasks","arguments":{"query":"not done\nsort by smart","limit":20}}}'
```

Search:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "search_tasks",
    "arguments": { "query": "client feedback", "limit": 20 }
  }
}
```

The repository does not provide or endorse an `npx task-manager-mcp-client` package. An MCP client that only supports stdio needs a separately verified HTTP bridge; do not copy an unversioned third-party command from old documentation.

## Tool schemas

### `query_tasks`

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "limit": { "type": "number" }
  },
  "required": ["query"]
}
```

The query is passed to the Task Manager CLI as URL-safe base64. A positive finite `limit` is appended as an integer query instruction.

### `search_tasks`

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "limit": { "type": "number" }
  },
  "required": ["query"]
}
```

The companion converts this to a literal description-search query before invoking the CLI.

## HTTP behavior

| Request | Result |
|---|---|
| `GET /mcp/health` | `200` without authentication; contains only health status |
| authenticated `POST /mcp` request | `200 application/json` with one JSON-RPC response |
| authenticated notification/client response | `202` with an empty body |
| authenticated session `GET /mcp` | `405`, because this server has no SSE stream |
| authenticated session `DELETE /mcp` | `204`; cancels active work and terminates the session |
| unsupported method on `/mcp` | `405` with `Allow: POST` |
| wrong path | `404` |
| missing/wrong bearer token | `401` |
| missing/wrong media or protocol headers | `406`, `415`, or `400` |
| pending-request saturation | `503` with `Retry-After: 1` |

## Safety and limits

Defaults are finite and may be lowered through the corresponding environment variables:

- loopback-only binding and loopback-only browser origins;
- constant-time bearer comparison;
- 1 MiB request body (`OBSIDIAN_TASK_MANAGER_MCP_MAX_REQUEST_BYTES`);
- 32 total pending HTTP requests (`OBSIDIAN_TASK_MANAGER_MCP_MAX_PENDING`);
- 64 client sessions with a one-hour idle lifetime (`OBSIDIAN_TASK_MANAGER_MCP_MAX_SESSIONS`, `OBSIDIAN_TASK_MANAGER_MCP_SESSION_TTL_MS`);
- four active Obsidian CLI children (`OBSIDIAN_TASK_MANAGER_MCP_MAX_CONCURRENT`), with excess work queued only inside the pending bound;
- simultaneous byte-identical tool requests share one in-flight CLI child only within the same authenticated session; different bytes/sessions and later repeats run independently, and completed results are never cached;
- cancelling one duplicate waiter detaches only that waiter; shared work is cancelled only when no waiter still needs it;
- 5 MiB each for CLI stdout and stderr (`OBSIDIAN_TASK_MANAGER_MCP_MAX_OUTPUT_BYTES`);
- 30-second CLI deadline (`OBSIDIAN_TASK_MANAGER_MCP_CHILD_TIMEOUT_MS`), then `SIGTERM` and `SIGKILL` after a 2-second grace (`OBSIDIAN_TASK_MANAGER_MCP_KILL_GRACE_MS`);
- 35-second request/socket deadline (`OBSIDIAN_TASK_MANAGER_MCP_REQUEST_TIMEOUT_MS`), 10-second header deadline, and 5-second keep-alive timeout;
- `spawn(..., { shell: false })` with query content base64-encoded;
- no completed-result cache;
- an HTTP disconnect does not cancel accepted work; send `notifications/cancelled` with `params.requestId` to stop a matching active request;
- on POSIX, timed-out/cancelled process groups receive `SIGTERM`, then `SIGKILL`; on Windows, escalation invokes `taskkill /T /F`; inherited output pipes are forcibly closed so descendants cannot retain a capacity slot indefinitely;
- unknown/write-capable tools rejected.

The token grants access to task query results visible to the Obsidian CLI. Treat output and client logs as sensitive vault data. Stop the companion to revoke process access, rotate the token, and review [`PRIVACY.md`](PRIVACY.md).

## Troubleshooting

- **400 after initialize:** send both the negotiated protocol version and returned session ID, then complete the initialized notification first.
- **404 session not found:** the session expired or was deleted; initialize again.
- **401:** token missing/mismatched; restart companion and client with the same value.
- **406/415:** include both required `Accept` values and JSON `Content-Type` as shown above.
- **503:** the bounded pending queue is full; wait for current queries rather than retrying in a tight loop.
- **CLI exited nonzero:** verify desktop Obsidian, CLI installation, vault selection, plugin enablement, and `OBSIDIAN_CLI`.
- **Invalid JSON from CLI:** run the underlying CLI command directly and inspect redacted stdout/stderr.
- **Phone/tablet:** unsupported by design; use the plugin UI/API on-device, not the companion.
