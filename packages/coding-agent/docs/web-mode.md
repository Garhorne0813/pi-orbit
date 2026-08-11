# Web Mode

Web mode starts an HTTP + WebSocket server for the coding agent, enabling remote access and browser-based UIs.

## Starting Web Mode

```bash
pi --mode web [--port 3000] [--host 127.0.0.1] [--auth-token <token>] [--web-app-managed]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--port <port>` | `3000` or `PI_ORBIT_PORT` | HTTP server port (1–65535) |
| `--host <host>` | `127.0.0.1` or `PI_ORBIT_HOST` | Bind address |
| `--auth-token <token>` | `PI_ORBIT_AUTH_TOKEN` | Bearer token for API authentication |
| `--web-app-managed` | `PI_ORBIT_APP_MANAGED` | Require authentication and restrictive CORS defaults for a desktop-managed process |
| `PI_ORBIT_MAX_RUNTIMES` | `64` | Maximum hosted runtimes, including the startup runtime |
| `PI_ORBIT_MAX_CONCURRENT_TURNS` | `4` | Maximum simultaneous model turns across all runtimes |
| `PI_ORBIT_IDLE_TIMEOUT_MS` | `1800000` | Idle timeout for recoverable persisted runtimes |
| `PI_ORBIT_REQUEST_BODY_LIMIT_BYTES` | `4194304` | Maximum HTTP API request body size |
| `PI_ORBIT_RUNTIME_DISPOSE_TIMEOUT_MS` | `10000` | Maximum wait for one runtime to dispose |
| `PI_ORBIT_SHUTDOWN_TIMEOUT_MS` | `15000` | Maximum graceful shutdown time |

Loopback development can run without authentication. CORS response headers are disabled by default on every host. A non-loopback host requires both `--auth-token`/`PI_ORBIT_AUTH_TOKEN` and an explicit `PI_ORBIT_CORS_ORIGIN`; otherwise startup fails.

App-managed mode also requires an authentication token on loopback and omits CORS response headers by default. Set `PI_ORBIT_CORS_ORIGIN` to the exact trusted origin when browser access is required. The desktop host should generate a new high-entropy token for every Pi Orbit process, keep it in memory, and proxy authenticated requests instead of exposing the token to browser JavaScript.

## Architecture

```
Browser / Web App / Mobile
        │
        ├── REST (HTTP) ──── CRUD sessions, prompt, models, tools
        │
        └── SSE / WebSocket ─ Runtime events and extension UI
                │
        ┌───────┴────────┐
        │  Web Mode        │
        │  Hono + Node.js  │
        │  HTTP + WS        │
        └───────┬────────┘
                │ AgentSessionRuntime
        ┌───────┴────────┐
        │  AgentSession   │  (unchanged)
        └────────────────┘
```

Web mode is a transport layer. All agent logic — prompting, tool execution, model management, compaction — lives in `AgentSession`. The web server translates HTTP requests into `AgentSession` method calls and fans out `AgentSessionEvent` streams to WebSocket clients.

For the single-user, multi-workspace deployment decision and its comparison with Open Science's OpenCode sidecar, see [web-mode-multi-workspace.md](web-mode-multi-workspace.md).

### Key Components

| Component | File | Role |
|-----------|------|------|
| `runWebMode()` | `modes/web/web-mode.ts` | Entry point. Creates HTTP server, manages lifecycle, handles signals. |
| `WebServerHost` | `modes/web/server.ts` | Testable Node.js server lifecycle using the maintained Hono Node and `ws` adapters. |
| `WebSessionHost` | `modes/web/web-session-host.ts` | Owns session creation, isolation, extension rebinding, deletion, and disposal. |
| `WebCommandHandler` | `modes/web/commands.ts` | Shared command semantics for REST and WebSocket adapters. |
| `ConnectionManager` | `modes/web/ws/connection-manager.ts` | Permanent runtime event subscriptions, bounded replay buffers, fan-out, and extension UI response correlation. |
| `createWebExtensionUIContext()` | `modes/web/ui-context.ts` | Adapts extension `ctx.ui` calls to session-scoped WebSocket messages. |
| `WebAccessPolicy` | `modes/web/middleware/auth.ts` | Shared HTTP and WebSocket authentication with constant-time token comparison. |

### Session Model

Each session maps to a dedicated `AgentSessionRuntime` instance. The session lifecycle:

1. **Default session**: Created at startup and seeded into the session host. It cannot be deleted through the API.
2. **Dynamic sessions**: Created via `POST /api/sessions`. Each gets its own `SessionManager` and `AgentSessionRuntime`. Extensions are bound in `"web"` mode.
3. **Deletion**: `DELETE /api/sessions/:id` closes all WebSocket connections, removes the dynamic entry from the session host, and disposes its runtime.
4. **Switching**: `POST /api/sessions/:id/switch` replaces the runtime's current session while preserving the Web session ID and rebinding extensions and event subscriptions.
5. **Event lifecycle**: The host subscribes when a runtime is registered, so events continue to receive sequence numbers while no client is connected. Clients can reconnect through the runtime SSE endpoint and replay the bounded in-memory buffer.
6. **Idle eviction**: A dynamic runtime is eligible only when it is not streaming, compacting, or holding pending messages and its persisted JSONL file already exists. In-memory and not-yet-flushed sessions are never automatically evicted. The old handle returns `runtime_evicted` instead of an ambiguous 404.
7. **Operation lease**: Prompt owns a turn lease; resume, restart, compact, fork, model changes, and deletion are exclusive. `steer`, `follow-up`, abort controls, and extension UI responses may operate during an active turn. Invalid overlaps return `runtime_busy`.
8. **Session ownership**: A canonical session path and persisted `piSessionId` can belong to only one runtime. Conflicts return `session_in_use`; ownership moves with resume, switch, and fork and is released on disposal.

## REST API

### Runtime Host

The runtime API is intended for control planes. It separates the process-local `runtimeId` from the persisted `piSessionId`; a fork, new session, or resume may change the latter while the runtime handle remains stable.

Create a runtime:

```json
{
  "cwd": "/workspace/project",
  "sessionDir": "/workspace/state/sessions",
  "sessionPath": "/workspace/state/sessions/existing.jsonl",
  "cwdOverride": "/workspace/project",
  "model": "anthropic/claude-sonnet-5",
  "thinking": "high",
  "skillPolicy": {
    "mode": "allowlist",
    "skills": ["pdf", "browser"]
  },
  "runtimeEnv": {
    "VIRTUAL_ENV": "/workspace/project/.venv",
    "PATH": "/workspace/project/.venv/bin:/usr/bin",
    "PYTHONHOME": null
  }
}
```

`sessionDir`, `sessionPath`, `cwdOverride`, `model`, `thinking`, `skillPolicy`, and `runtimeEnv` are optional. Omitting `sessionDir` inherits the startup runtime's persistence policy and session directory. `cwdOverride` is only for explicitly relocating an existing session and must resolve to the same canonical path as `cwd`.

The canonical workspace is immutable for the lifetime of a runtime. Create, resume, and legacy switch operations reject a session recorded for another workspace with `runtime_workspace_mismatch`. A string in `runtimeEnv` overrides the inherited child-process value; `null` removes it. The environment is stored on the runtime and is used by built-in bash tools, direct bash commands, and extension `pi.exec` calls without mutating `process.env`. Provider credentials, `agentDir`, skill discovery sources, extensions, and MCP configuration remain application-level resources. Each runtime can independently filter discovered skills with `skillPolicy`; raw runtime-scoped skill paths and extensions remain invalid. An MCP or third-party extension that starts processes directly must explicitly consume the runtime execution environment contract; Pi Orbit cannot intercept arbitrary `child_process.spawn` calls.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/runtimes` | Create a runtime from explicit directories and an optional session path. |
| `GET` | `/api/runtimes` | List runtime descriptors. |
| `GET` | `/api/runtimes/:runtimeId` | Read identity, path, model, activity, and busy state. |
| `GET` | `/api/runtimes/:runtimeId/state` | Reconcile model, thinking, session, queue, and busy state. |
| `GET` | `/api/runtimes/:runtimeId/commands` | List extension, prompt-template, and skill commands. |
| `GET` | `/api/runtimes/:runtimeId/skills` | List discovered skills, enabled state, diagnostics, and the current policy. |
| `PUT` | `/api/runtimes/:runtimeId/skills` | Replace the runtime policy with `inherit`, `none`, `allowlist`, or `denylist`. |
| `POST` | `/api/runtimes/:runtimeId/skills/refresh` | Rescan skill resources without reloading extensions. |
| `DELETE` | `/api/runtimes/:runtimeId` | Dispose a dynamic runtime without deleting session storage. |
| `POST` | `/api/runtimes/:runtimeId/resume` | Resume `{ sessionPath, piSessionId?, cwdOverride? }`; an identity mismatch returns HTTP 409. |
| `POST` | `/api/runtimes/:runtimeId/prompt` | Submit `{ message }`; returns HTTP 202 with both IDs. |
| `POST` | `/api/runtimes/:runtimeId/steer` | Queue steering input during an active turn. |
| `POST` | `/api/runtimes/:runtimeId/follow-up` | Queue follow-up input during an active turn. |
| `POST` | `/api/runtimes/:runtimeId/abort` | Abort the active turn. |
| `POST` | `/api/runtimes/:runtimeId/compact` | Compact the current context. |
| `POST` | `/api/runtimes/:runtimeId/fork` | Fork at an optional `entryId`. |
| `POST` | `/api/runtimes/:runtimeId/model` | Select `{ provider, modelId }` exactly. |
| `POST` | `/api/runtimes/:runtimeId/thinking` | Set `{ level }` exactly. |
| `POST` | `/api/runtimes/:runtimeId/ui-response` | Resolve a pending `extension_ui_response` without WebSocket client commands. |
| `GET` | `/api/runtimes/:runtimeId/events` | Stream versioned event envelopes with replay support. |
| `GET` | `/api/runtimes/:runtimeId/health` | Read runtime health and protocol version. |

A runtime descriptor contains:

```json
{
  "runtimeId": "process-local-uuid",
  "piSessionId": "persisted-session-id",
  "sessionPath": "/workspace/state/sessions/session.jsonl",
  "sessionDir": "/workspace/state/sessions",
  "cwd": "/workspace/project",
  "workspaceCwd": "/workspace/project",
  "persisted": true,
  "createdAt": 1770000000000,
  "lastActivityAt": 1770000000000,
  "busy": false,
  "model": { "provider": "anthropic", "id": "claude-sonnet-5" },
  "qualifiedModel": "anthropic/claude-sonnet-5",
  "thinking": "high",
  "isStreaming": false,
  "isCompacting": false,
  "diagnostics": []
}
```

Before creating a runtime, a control plane can read `GET /api/project-trust?cwd=<path>`. If `required` is true and `decision` is null, runtime creation returns HTTP 409 with `project_trust_required`. Persist a decision with `PUT /api/project-trust` and `{ "cwd": "...", "decision": true }`; use `false` to load the workspace without trust-requiring resources and `null` to clear the saved decision. Resource-loader errors return HTTP 422 with `runtime_initialization_failed` and structured diagnostics.

### Session Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions` | Create a new session. Body: `{ "cwd": "/path", "name": "optional" }`. Returns `{ "sessionId": "uuid" }`. |
| `GET` | `/api/sessions` | List all sessions. Returns `[{ id, name, cwd, createdAt, model }]`. |
| `GET` | `/api/sessions/:id` | Get session details: name, cwd, model, thinkingLevel, messageCount. |
| `GET` | `/api/sessions/:id/state` | Get current model, thinking, streaming, compaction, queue, and session state. |
| `GET` | `/api/sessions/:id/stats` | Get message, token, cost, and context statistics. |
| `GET` | `/api/sessions/:id/messages` | Get the current message history. |
| `GET` | `/api/sessions/:id/entries?since=<id>` | Get all entries, or only entries after `since`. |
| `GET` | `/api/sessions/:id/tree` | Get the branch tree and active leaf. |
| `GET` | `/api/sessions/:id/commands` | List extension, prompt-template, and skill commands. |
| `GET` | `/api/sessions/:id/fork-messages` | List user messages available as fork points. |
| `GET` | `/api/sessions/:id/last-assistant-text` | Get the last assistant text or `null`. |
| `PATCH` | `/api/sessions/:id` | Rename the session. Body: `{ "name": "..." }`. |
| `POST` | `/api/sessions/:id/switch` | Switch session files. Body: `{ "sessionPath": "/path/session.jsonl", "cwdOverride": "/optional/cwd" }`. |
| `POST` | `/api/sessions/:id/clone` | Clone at the active leaf. |
| `POST` | `/api/sessions/:id/restart` | Replace the runtime while preserving the Web session ID. |
| `POST` | `/api/sessions/:id/export` | Export to HTML. Optional body: `{ "outputPath": "/path/session.html" }`. |
| `DELETE` | `/api/sessions/:id` | Delete a dynamic session. The default session returns HTTP 403. |

### Agent Control

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions/:id/prompt` | Send a prompt to the agent. Body: `{ "message": "..." }`. Returns HTTP 202 immediately. Stream results via WebSocket. |
| `POST` | `/api/sessions/:id/steer` | Queue steering input. Body: `{ "message": "...", "images": [...] }`. |
| `POST` | `/api/sessions/:id/follow-up` | Queue follow-up input with the same body shape. |
| `POST` | `/api/sessions/:id/abort` | Abort the current agent run. |
| `POST` | `/api/sessions/:id/abort-bash` | Abort the active direct bash command. |
| `POST` | `/api/sessions/:id/abort-retry` | Abort an automatic retry delay. |
| `POST` | `/api/sessions/:id/bash` | Execute a `!` command. Body: `{ "command": "ls -la" }`. |
| `POST` | `/api/sessions/:id/compact` | Trigger context compaction. |
| `POST` | `/api/sessions/:id/fork` | Fork the session at a given entry. Body: `{ "entryId": "optional" }`. If omitted, forks from the first user message. |

### Model & Configuration

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/models` | List models for the default session, or for `?session_id=<id>` when supplied. |
| `POST` | `/api/sessions/:id/model` | Set the exact model. Body: `{ "provider": "anthropic", "modelId": "claude-sonnet-5" }`. |
| `POST` | `/api/sessions/:id/cycle-model` | Cycle the model. Optional body: `{ "direction": "forward" }` or `backward`. |
| `POST` | `/api/sessions/:id/thinking` | Set thinking level. Body: `{ "level": "high" }`. Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `POST` | `/api/sessions/:id/cycle-thinking` | Cycle through levels supported by the current model. |
| `GET` | `/api/sessions/:id/thinking-levels` | List levels supported by the current model. |
| `PUT` | `/api/sessions/:id/steering-mode` | Set `{ "mode": "all" }` or `one-at-a-time`. |
| `PUT` | `/api/sessions/:id/follow-up-mode` | Set follow-up queue behavior with the same body shape. |
| `PUT` | `/api/sessions/:id/auto-compaction` | Set `{ "enabled": true }` or `false`. |
| `PUT` | `/api/sessions/:id/auto-retry` | Set automatic retry with the same body shape. |

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check with version, runtime counts, busy/active turns, capacity, and buffered-event usage. No auth required. |
| `GET` | `/api/capabilities` | Protocol version, Pi version, supported runtime commands, and isolation capabilities. No auth required. |
| `POST` | `/api/auth/session` | Exchange a valid Bearer header for an HttpOnly, same-origin authentication cookie. |
| `DELETE` | `/api/auth/session` | Clear the browser authentication cookie. |
| `GET` | `/api/project-trust?cwd=<path>` | Read the trust requirement and current decision for a workspace. |
| `PUT` | `/api/project-trust` | Set or clear a workspace trust decision. |

### Responses

All endpoints return JSON. Success responses use HTTP 2xx with a `success` field or the requested data. Errors use 4xx/5xx with `{ "error": "...", "details": "..." }`.

Runtime endpoints also return stable error codes. `runtime_not_found` means the handle was never known, `runtime_evicted` means idle eviction removed it, `runtime_busy` means another mutation owns the runtime operation lease, `session_in_use` means another runtime owns the canonical path or `piSessionId`, `runtime_capacity_exceeded` means the host reached its configured limit, `runtime_workspace_mismatch` means a persisted session belongs to another canonical workspace, `project_trust_required` means the caller must make a trust decision, `runtime_initialization_failed` includes resource-loader diagnostics, `pi_session_mismatch` means resume opened a different persisted identity, `event_replay_gap` means the requested sequence left the ring buffer, and `event_sequence_ahead` means the cursor is newer than the runtime's latest sequence.

Prompt endpoints also enforce a host-wide active-turn limit. When the limit is reached, new prompts return HTTP 429 with `agent_turn_capacity_exceeded`; capacity is released when the running prompt finishes or fails. HTTP API bodies larger than `PI_ORBIT_REQUEST_BODY_LIMIT_BYTES` return HTTP 413 with `request_body_too_large`.

## Runtime Event Protocol

`GET /api/runtimes/:runtimeId/events` emits SSE records named `runtime_event`. Each data field is a versioned envelope:

```json
{
  "protocolVersion": 1,
  "runtimeId": "runtime-uuid",
  "piSessionId": "pi-session-id",
  "sequence": 42,
  "timestamp": "2026-07-28T12:00:00.000Z",
  "event": { "type": "message_update" }
}
```

Sequence numbers increase monotonically per runtime and continue across session replacement. The bounded buffer keeps the latest 512 events by default. Reconnect with `Last-Event-ID: <sequence>` or `?after=<sequence>`. Replay validation, subscriber registration, and the replay snapshot occur as one synchronous state transition; live events produced during replay are queued after the replay watermark. SSE writes are serialized per client. A cursor outside the available window returns HTTP 409 with `event_replay_gap` or `event_sequence_ahead`; durable persistence and state reconciliation remain the control plane's responsibility.

## WebSocket Protocol

### Connection

```
ws://host:port/ws?session_id=<uuid>
```

- `session_id` (required): The session to subscribe to.
- When authentication is enabled, send `Authorization: Bearer <token>` on the HTTP upgrade request or first exchange that header through `POST /api/auth/session`. Query-string tokens are rejected.
- `POST /api/auth/session` sets an HttpOnly `pi_web_auth` cookie with `SameSite=Strict`. A desktop shell or backend can perform the exchange, after which native browser `WebSocket`, `EventSource`, and fetch requests authenticate automatically on the same origin. Never expose the process token to browser JavaScript.

### Server → Client: Events

Each message is a JSON-serialized `AgentSessionEvent`. The full event catalog:

| Event | Description |
|-------|-------------|
| `message_start` / `message_update` / `message_end` | Streaming assistant output, token by token |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Tool execution with partial results |
| `turn_start` / `turn_end` | Agent turn boundaries |
| `agent_start` / `agent_end` | Agent run lifecycle |
| `compaction_start` / `compaction_end` | Context compaction progress |
| `queue_update` | Steering/follow-up message queue state |
| `session_info_changed` | Session display name changed |
| `thinking_level_changed` | Thinking level was modified |
| `entry_appended` | New entry appended to session |
| `auto_retry_start` / `auto_retry_end` | Automatic retry on failures |

### Client → Server: Commands

The WebSocket accepts prompt and abort commands from the client:

```json
{ "type": "prompt", "message": "Hello, world!" }
{ "type": "abort" }
```

Frames must be masked per RFC 6455. The server handles fragmented frames (continuation opcode 0x0) and reassembles messages across TCP packets.

### Extension UI Protocol

Extensions bound in Web mode receive a real `ExtensionUIContext`. Blocking calls send an `extension_ui_request` to every client connected to that session:

```json
{
  "type": "extension_ui_request",
  "id": "request-uuid",
  "method": "confirm",
  "title": "Permission",
  "message": "Continue?",
  "timeout": 30000
}
```

The client responds on the same session connection. Depending on the method, use `value`, `confirmed`, or `cancelled`:

```json
{ "type": "extension_ui_response", "id": "request-uuid", "confirmed": true }
```

| Method | Response | Behavior |
|--------|----------|----------|
| `select` | `{ value }` or `{ cancelled: true }` | Returns the selected string or `undefined`. |
| `confirm` | `{ confirmed }` or `{ cancelled: true }` | Returns a boolean. |
| `input` | `{ value }` or `{ cancelled: true }` | Returns text or `undefined`. |
| `editor` | `{ value }` or `{ cancelled: true }` | Returns edited text or `undefined`. |
| `notify`, `setStatus`, `setTitle`, `set_editor_text`, `setWidget` | none | Fire-and-forget UI update. Widgets support string arrays only. |

Requests and responses are isolated by runtime. If several clients share a runtime, the first valid response wins. Responses from another runtime or for an expired request are rejected. A control plane consuming runtime SSE can post the same response object to `/api/runtimes/:runtimeId/ui-response`. Dialogs return their safe default when there is no client, the timeout expires, the supplied `AbortSignal` fires, the final client disconnects, or the runtime is removed.

## Examples

### cURL

```bash
# Health check
curl http://localhost:3000/api/health

# Create a session
curl -X POST http://localhost:3000/api/sessions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-token" \
  -d '{"cwd": "/home/user/project"}'

# Send a prompt
curl -X POST http://localhost:3000/api/sessions/<session-id>/prompt \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-token" \
  -d '{"message": "Refactor the auth module"}'

# List models
curl http://localhost:3000/api/models \
  -H "Authorization: Bearer my-token"
```

### JavaScript (Browser)

```javascript
// A desktop shell or trusted backend performs this once. Do not embed the token
// in browser-delivered JavaScript in a real application.
await fetch('http://localhost:3000/api/auth/session', {
  method: 'POST',
  headers: { Authorization: 'Bearer my-token' }
});

// Create session using the HttpOnly authentication cookie.
const { sessionId } = await fetch('http://localhost:3000/api/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cwd: '/tmp' })
}).then(r => r.json());

// Connect WebSocket
const ws = new WebSocket(`ws://localhost:3000/ws?session_id=${sessionId}`);

ws.onmessage = (event) => {
  const e = JSON.parse(event.data);
  console.log(e.type, e); // message_update, tool_execution_start, etc.
};

// Send prompt
await fetch(`http://localhost:3000/api/sessions/${sessionId}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Hello!' })
});
```

## Deployment Isolation

The built-in token is process-wide authentication, not tenant authorization. For deployments serving multiple users:

1. **Process isolation**: Run one Pi process or container per trust domain. Do not expose one process directly to mutually untrusted tenants.
2. **Session isolation**: Each `POST /api/sessions` creates an isolated `SessionManager` and `AgentSessionRuntime` within that process.
3. **Resource limits**: Monitor runtime count and active turns via `GET /api/health`. Configure `PI_ORBIT_MAX_RUNTIMES`, `PI_ORBIT_MAX_CONCURRENT_TURNS`, and `PI_ORBIT_IDLE_TIMEOUT_MS`, and enforce process-level CPU and memory limits externally.
4. **Containerization**: Run each Pi instance in a container. See [containerization.md](containerization.md) for patterns.

## WebSocket Implementation

WebSocket upgrades and framing use `@hono/node-server` with `ws`. Web mode owns only authentication, session selection, command validation, and event fan-out.

## Limitations

- **No built-in TLS**: Use a reverse proxy (nginx, Caddy) for HTTPS.
- **Shared application resources**: Provider credentials, agent resources, and MCP configuration are shared. Runtime environment overrides isolate runtime-managed child processes, but do not create an OS security boundary or automatically affect third-party code that spawns processes itself.
- **In-memory runtime handles and replay**: Runtime IDs and the 512-event buffers are lost on process restart. Persisted JSONL sessions can be resumed with a new runtime ID.
- **Single-process**: One `pi --mode web` process serves all sessions. No built-in horizontal scaling.
