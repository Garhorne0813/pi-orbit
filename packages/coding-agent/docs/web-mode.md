# Web Mode

Web mode starts an HTTP + WebSocket server for the coding agent, enabling remote access and browser-based UIs.

## Starting Web Mode

```bash
pi --mode web [--port 3000] [--host 127.0.0.1] [--auth-token <token>]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--port <port>` | `3000` or `PI_WEB_PORT` | HTTP server port (1–65535) |
| `--host <host>` | `127.0.0.1` or `PI_WEB_HOST` | Bind address |
| `--auth-token <token>` | `PI_WEB_AUTH_TOKEN` | Bearer token for API authentication |

When no auth token is configured, the API is open to all connections (dev mode). For production, always set `--auth-token` or the `PI_WEB_AUTH_TOKEN` environment variable.

## Architecture

```
Browser / Web App / Mobile
        │
        ├── REST (HTTP) ──── CRUD sessions, prompt, models, tools
        │
        └── WebSocket ────── Real-time AgentSessionEvent stream
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

### Key Components

| Component | File | Role |
|-----------|------|------|
| `runWebMode()` | `modes/web/web-mode.ts` | Entry point. Creates HTTP server, manages lifecycle, handles signals. |
| `WebServerHost` | `modes/web/server.ts` | Testable Node.js server lifecycle using the maintained Hono Node and `ws` adapters. |
| `WebSessionHost` | `modes/web/web-session-host.ts` | Owns session creation, isolation, extension rebinding, deletion, and disposal. |
| `WebCommandHandler` | `modes/web/commands.ts` | Shared command semantics for REST and WebSocket adapters. |
| `ConnectionManager` | `modes/web/ws/connection-manager.ts` | Runtime-aware event fan-out that re-subscribes after the runtime replaces its session. |
| `WebAccessPolicy` | `modes/web/middleware/auth.ts` | Shared HTTP and WebSocket authentication with constant-time token comparison. |

### Session Model

Each session maps to a dedicated `AgentSessionRuntime` instance. The session lifecycle:

1. **Default session**: Created at startup and seeded into the session host. It cannot be deleted through the API.
2. **Dynamic sessions**: Created via `POST /api/sessions`. Each gets its own `SessionManager` and `AgentSessionRuntime`. Extensions are bound in `"web"` mode.
3. **Deletion**: `DELETE /api/sessions/:id` closes all WebSocket connections, removes the dynamic entry from the session host, and disposes its runtime.
4. **WebSocket lifecycle**: Connecting via `ws://host:port/ws?session_id=<id>` subscribes to that runtime's current `AgentSessionEvent` stream. Fork, new-session, and switch-session operations atomically rebind the subscription. Multiple clients can connect to the same session.

## REST API

### Session Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions` | Create a new session. Body: `{ "cwd": "/path", "name": "optional" }`. Returns `{ "sessionId": "uuid" }`. |
| `GET` | `/api/sessions` | List all sessions. Returns `[{ id, name, cwd, createdAt, model }]`. |
| `GET` | `/api/sessions/:id` | Get session details: name, cwd, model, thinkingLevel, messageCount. |
| `DELETE` | `/api/sessions/:id` | Delete a dynamic session. The default session returns HTTP 403. |

### Agent Control

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions/:id/prompt` | Send a prompt to the agent. Body: `{ "message": "..." }`. Returns HTTP 202 immediately. Stream results via WebSocket. |
| `POST` | `/api/sessions/:id/abort` | Abort the current agent run. |
| `POST` | `/api/sessions/:id/bash` | Execute a `!` command. Body: `{ "command": "ls -la" }`. |
| `POST` | `/api/sessions/:id/compact` | Trigger context compaction. |
| `POST` | `/api/sessions/:id/fork` | Fork the session at a given entry. Body: `{ "entryId": "optional" }`. If omitted, forks from the first user message. |

### Model & Configuration

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/models` | List models for the default session, or for `?session_id=<id>` when supplied. |
| `POST` | `/api/sessions/:id/model` | Set the model for a session. Body: `{ "modelId": "claude-sonnet-5" }`. |
| `POST` | `/api/sessions/:id/thinking` | Set thinking level. Body: `{ "level": "high" }`. Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check. Returns `{ "status": "ok", "version": "0.80.3" }`. No auth required. |

### Responses

All endpoints return JSON. Success responses use HTTP 2xx with a `success` field or the requested data. Errors use 4xx/5xx with `{ "error": "...", "details": "..." }`.

## WebSocket Protocol

### Connection

```
ws://host:port/ws?session_id=<uuid>[&token=<auth_token>]
```

- `session_id` (required): The session to subscribe to.
- `token` (required if auth is configured): Bearer token. Query params may appear in proxy logs, so use TLS and configure proxies to redact request URLs. Browser WebSocket clients cannot set an Authorization header.

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

The WebSocket also accepts commands from the client:

```json
{ "type": "prompt", "message": "Hello, world!" }
```

Frames must be masked per RFC 6455. The server handles fragmented frames (continuation opcode 0x0) and reassembles messages across TCP packets.

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
// Create session
const { sessionId } = await fetch('http://localhost:3000/api/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer my-token' },
  body: JSON.stringify({ cwd: '/tmp' })
}).then(r => r.json());

// Connect WebSocket
const ws = new WebSocket(`ws://localhost:3000/ws?session_id=${sessionId}&token=my-token`);

ws.onmessage = (event) => {
  const e = JSON.parse(event.data);
  console.log(e.type, e); // message_update, tool_execution_start, etc.
};

// Send prompt
await fetch(`http://localhost:3000/api/sessions/${sessionId}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer my-token' },
  body: JSON.stringify({ message: 'Hello!' })
});
```

## Deployment Isolation

The built-in token is process-wide authentication, not tenant authorization. For deployments serving multiple users:

1. **Process isolation**: Run one Pi process or container per trust domain. Do not expose one process directly to mutually untrusted tenants.
2. **Session isolation**: Each `POST /api/sessions` creates an isolated `SessionManager` and `AgentSessionRuntime` within that process.
3. **Resource limits**: Monitor session count via `GET /api/sessions`. Implement rate limiting and session caps at the reverse proxy (nginx, Caddy) or in middleware.
4. **Containerization**: Run each Pi instance in a container. See [containerization.md](containerization.md) for patterns.

## WebSocket Implementation

WebSocket upgrades and framing use `@hono/node-server` with `ws`. Web mode owns only authentication, session selection, command validation, and event fan-out.

## Limitations

- **No built-in TLS**: Use a reverse proxy (nginx, Caddy) for HTTPS.
- **No request size limit**: Large request bodies are streamed through `ReadableStream`. Add body size limits at the reverse proxy for production.
- **In-memory session map**: Session state is lost on process restart. Sessions persisted to disk via `SessionManager` can be recovered, but the web mode session map is ephemeral.
- **Single-process**: One `pi --mode web` process serves all sessions. No built-in horizontal scaling.
