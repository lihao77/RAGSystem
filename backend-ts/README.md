# RAGSystem Backend TS

TypeScript backend migration workspace.

This folder is intentionally separate from `backend-fastapi` as the TypeScript backend migration
target. The tracked Python-backend parity slices now run in TypeScript. Unsupported future modes
should fail explicitly instead of silently pretending to be available.

## Scripts

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run smoke:parity -- --session-id <existing-session-id>
```

Default development port: `5002`.

Node.js 24+ is required because the first persistence milestone uses the built-in
`node:sqlite` module to avoid adding native npm database bindings.

## Current Scope

- Fastify application entrypoint
- Strict TypeScript configuration
- Runtime container and service composition
- Shared contract models for common responses, sessions, execution requests, and client events
- SQLite-backed conversation store compatible with the first slice of the Python
  `ConversationStore`
- Python-compatible session routes for create/list/get/delete, message listing, user-message
  updates, rollback, run-step sidecar reads, and session export
- Execution persistence primitives for runs, resources, step-resource links, and child-scoped
  message reads
- Session WebSocket shell with heartbeat, replay markers, and typed error responses
- Python-compatible idle execution status routes for frontend polling, diagnostics, and overview reads
- Monitoring compatibility routes for empty metrics, and tool-call raw-result reads
- In-memory permission policy API compatible with the Python `/api/permissions/*` route shapes
- Knowledge-base uploaded files (source blobs + metadata) owned by the sqlite-vec driver, served at
  `/api/vector-library/files/*`; session-scoped attachments at `/api/agent/sessions/:sessionId/files/*`
  via the main SQLite uploaded-file index
- In-memory agent config/team API compatible with the Python `/api/agent-config/*` bootstrap and
  Team Builder route shapes, including config export and built-in preset application
- In-memory agent management API compatible with the Python `/api/agent/agents*` route shapes
- In-memory model provider config API compatible with the Python `/api/model-adapter/*` provider
  management route shapes
- In-memory system config API compatible with the Python `/api/system-config/*` schema form route
  shapes
- In-memory MCP server config API compatible with the Python `/api/mcp/*` management route shapes
- In-memory daemon config and cron-task API compatible with the Python `/api/daemon/*` management
  route shapes
- In-memory vectorizer/reranker config API and vector library status reads compatible with the
  Python `/api/vector-library/*` management route shapes
- Empty vector collection/document reads and vector health status compatible with the Python
  `/api/vector/*` management route shapes
- Visualization artifact read/list/delete API compatible with the Python `/api/artifacts/*` route
  shapes for existing session visualization files
- Embedding model management API compatible with the Python `/api/embedding-models/*` route shapes,
  derived from the current TS vectorizer config
- Runtime-core execution for configured single-agent text runs, with OpenAI-compatible,
  Anthropic, and OpenAI Responses provider clients, migrated built-in tool loop, and persisted
  user/final messages
- Built-in runtime tools for `request_user_input`, memory read/write/archive, managed file
  read/write/edit/preview, foreground/background `execute_bash`, task tracking/background control,
  `glob`, `grep`, `web_fetch`, `todo_write`, restricted `execute_code`, Skill tools, MCP tools,
  vector/RAG tools, hooks, and synchronous agent delegation
- Attachments, system slash commands including `/compact`, file-history
  rollback/retry, sequential collaboration, daemon runtime operations, and provider test routes

## Test-First Boundary

Migration boundaries are defined in [docs/migration-boundaries.md](docs/migration-boundaries.md).

Before adding a future parity slice, add or update tests that describe:

- the existing public route or event shape,
- the expected TypeScript behavior,
- the explicit unsupported-mode response when TypeScript should match an unsupported Python mode.

Current test layers:

- `tests/contracts` validates shared schemas and compatibility aliases.
- `tests/services` validates runtime primitives without HTTP.
- `tests/routes` validates Fastify route compatibility through `app.inject`.

Verification:

```bash
npm run typecheck
npm run typecheck:test
npm test
npm run build
```

Optional live parity smoke against Python `5001` and TypeScript `5002`:

```bash
npm run smoke:parity -- --session-id <existing-session-id>
npm run smoke:parity -- --session-id <existing-session-id> --include-execution --execution-profile core
npm run smoke:parity -- --session-id <existing-session-id> --include-ws
npm run smoke:parity -- --session-id <existing-session-id> --include-ws --include-ws-stop
```

The default smoke is read-only. `--include-execution` starts real `/api/agent/stream`
runs on both backends and uses `selected_llm=rag|deepseek|deepseek-v4-pro` unless overridden.
Execution smoke temporarily sets `/api/permissions/policy` to skip approvals and restores the
original policy afterwards.

`--include-ws` connects `/api/agent/sessions/{session_id}/ws` before starting a minimal live run
and checks core realtime semantics: event groups, monotonic `stream_seq`, message persistence, and
terminal delivery. `--include-ws-stop` adds a WebSocket `stop`/`stop.ack` smoke. Profiles:

- `minimal`: one direct LLM reply.
- `core`: minimal plus file, data preview, foreground/background bash, and task CRUD tool chains.
- `full`: core plus one child-agent delegation smoke.

Passing `--execution-task <text>` runs only that custom task.

## Runtime Event Delivery

Terminal agent events use durable outbox live delivery. Completed/failed/interrupted terminal
events are recorded to the outbox and projected by the outbox dispatcher; the legacy synchronous
terminal publisher is no longer available.

`GET /api/agent/metrics` includes `data.event_outbox` with the delivery mode, dispatcher
metrics, and pending/delivered/failed outbox counts.

## Migration Rule

Do not silently fake migrated behavior. If a future Python capability is not available in
TypeScript, keep the public shape compatible and return an explicit, tested error until the
behavior is ported.
