# RAGSystem Backend TS

TypeScript backend migration workspace.

This folder is intentionally separate from `backend-fastapi` while the backend is being ported.
The first milestone keeps the public HTTP and WebSocket paths visible, but core agent execution
returns `501 Not Migrated` until the runtime has been implemented in TypeScript.

## Scripts

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

Default development port: `5002`.

Node.js 24+ is required because the first persistence milestone uses the built-in
`node:sqlite` module to avoid adding native npm database bindings.

## Current Scope

- Fastify application entrypoint
- Strict TypeScript configuration
- Runtime container skeleton
- Shared contract models for common responses, sessions, execution requests, and client events
- SQLite-backed conversation store compatible with the first slice of the Python
  `ConversationStore`
- Python-compatible session routes for create/list/get/delete, message listing, user-message
  updates, rollback, run-step sidecar reads, and session export
- Execution persistence primitives for runs, resources, step-resource links, and child-scoped
  message reads
- Checkpoint persistence primitives and checkpoint list route
- Session WebSocket shell with heartbeat, replay markers, and typed error responses
- Python-compatible idle execution status routes for frontend polling, diagnostics, and overview reads
- Monitoring compatibility routes for empty metrics, persisted message-content reads, and tool-call raw-result reads
- In-memory permission policy API compatible with the Python `/api/permissions/*` route shapes
- In-memory agent config/team API compatible with the Python `/api/agent-config/*` bootstrap and
  Team Builder route shapes
- In-memory agent management API compatible with the Python `/api/agent/agents*` route shapes
- In-memory model provider config API compatible with the Python `/api/model-adapter/*` provider
  management route shapes
- In-memory system config API compatible with the Python `/api/system-config/*` schema form route
  shapes
- In-memory MCP server config API compatible with the Python `/api/mcp/*` management route shapes
- Explicit `501` responses for agent runtime operations that have not been migrated yet

## Test-First Boundary

Migration boundaries are defined in [docs/migration-boundaries.md](docs/migration-boundaries.md).

Before porting a Python capability, add or update tests that describe:

- the existing public route or event shape,
- the expected TypeScript behavior,
- the current `501 not_migrated` boundary if the implementation is still pending.

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

## Migration Rule

Do not silently fake migrated behavior. If a Python capability is not yet ported, keep the route
shape compatible and return `501` with code `not_migrated`.
