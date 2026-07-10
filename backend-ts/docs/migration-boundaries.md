# Backend TS Migration Boundaries

This document records the current TypeScript backend migration boundary after the Python-backend
parity pass. The tracked parity slices now run in `backend-ts`; this document should prevent future
work from reintroducing placeholder behavior or stale `501 not_migrated` assumptions.

## Current Status

- `backend-ts` owns the migrated runtime and compatibility routes described in the full migration
  plan.
- There are no active route-level `501 not_migrated` placeholders in `backend-ts/src`.
- Health/status endpoints report the TS runtime as migrated.
- The remaining `not_migrated` type value in tool metadata is a compatibility value for hidden or
  future unavailable tools; current visible runtime tools report `implemented`.

## Migrated Scope

Foundation and persistence:

- Fastify application entrypoint and health routes.
- SQLite-backed sessions, messages, runs, run steps, resources, uploaded files, file
  history, and durable event outbox.
- Python-compatible session create/list/get/delete, message listing, message edit, rollback,
  retry, run-step sidecar reads, and session export.
- WebSocket replay, monotonic stream sequence handling, approval responses, stop acknowledgements,
  and durable terminal event replay.

Execution runtime:

- `/api/agent/stream` for configured single-agent execution.
- `/api/agent/execute` and `/api/agent/execute/:agentName` synchronous execution.
- `/api/agent/collaborate` sequential collaboration.
- XML streaming tool-call loop, native tool-call fallback, approvals, user-input interactions,
  stop/cancel, run status, context compression, and `/compact`.
- Attachments and uploaded/session files in runtime context.

Runtime tools and integrations:

- `request_user_input`.
- Memory read/write/archive tools.
- Managed file read/write/edit/preview tools.
- Local search tools: `glob`, `grep`, `web_fetch`, `todo_write`.
- Foreground/background `execute_bash`, background task status/output/stop, and task workflow
  tools.
- Restricted `execute_code`.
- Agent delegation tools.
- Skill discovery, visibility, resource loading, script execution (with per-skill `.venv`
  isolation and `requirements.txt` provisioning), artifact protocol, team
  protocol, and background execution.
- Hook runtime.
- MCP server config, stdio/http connection lifecycle, tool discovery, runtime bridge exposure,
  execution, and permissions.
- Vector/RAG indexing, search, rerank, delete, migration, sync, and knowledge-base runtime tools.

Management and provider compatibility:

- Agent/team config import/export, preset application, team management, agent management, and
  runtime reload response.
- Model provider YAML-backed management, provider availability/test routes, Anthropic chat,
  OpenAI-compatible chat, OpenAI Responses chat, embeddings, and rerank support.
- System config reads/updates/reload.
- Daemon status/config, start/stop, outbound send, test message dispatch, cron task management, and
  cron trigger.
- File management, artifact management, embedding model management, vector library management,
  permission policy routes, monitoring routes, context snapshot, and outbox operations.

## Intentional Unsupported Modes

- Parallel collaboration still returns HTTP 400 with `并行模式尚未实现`. This matches the current
  Python backend behavior and is not a TypeScript migration gap.
- Live external behavior still depends on local provider keys, MCP servers, daemon platform
  gateways, and vector provider configuration. Tests cover local/fake execution paths; optional
  smoke tests can validate a live environment.

## Rule

Do not silently fake migrated behavior. If a future Python capability is added before its
TypeScript implementation, keep the public route shape compatible and return an explicit, tested
error until the behavior is ported.
