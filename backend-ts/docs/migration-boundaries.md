# Backend TS Migration Boundaries

This document defines what the first TypeScript backend milestone is allowed to do.
Tests must enforce these boundaries before deeper migration starts.

## Milestone 0: Foundation Boundary

In scope:

- Start a Fastify server from `src/main.ts`.
- Expose health routes at `/api/health` and `/api/agent/health`.
- Keep the public session route shapes used by the Python backend:
  - `POST /api/agent/sessions`
  - `GET /api/agent/sessions`
  - `GET /api/agent/sessions/:sessionId`
  - `DELETE /api/agent/sessions/:sessionId`
  - `GET /api/agent/sessions/:sessionId/messages`
- Provide a session WebSocket shell at `/api/agent/sessions/:sessionId/ws`.
- Return explicit `501 not_migrated` for Python capabilities that are not yet ported.
- Validate request bodies with shared TypeScript schemas.

Out of scope:

- Real agent execution.
- Tool registry execution.
- MCP connection management.
- LLM provider calls.
- Vector indexing/retrieval.
- Persistent SQLite stores.
- Python skill behavior parity.

## Milestone 1: Session Persistence Boundary

In scope:

- SQLite-backed session and message persistence through `node:sqlite`.
- Python-compatible `ConversationStore` slice for:
  - session create/get/list/delete,
  - message add/list/update,
  - run step add/list/message binding,
  - run create/status/list persistence,
  - resource register/list and step-resource linking,
  - child agent records needed for rollback cleanup,
  - child-scoped recent message reads,
  - resource scope inference for managed session/workspace paths,
  - rollback deletion after `after_seq` or `after_message_id`.
- Application-level message filtering parity:
  - hidden `visible_to_user=false` messages are excluded,
  - `react_intermediate` messages are excluded,
  - child-scope and non-root-thread messages are excluded,
  - assistant messages expose `has_execution` when metadata contains `run_id`.
- Execution step sidecar reads:
  - `GET /api/agent/sessions/:sessionId/messages?expand=1|true|steps|yes`,
  - `GET /api/agent/sessions/:sessionId/messages/:messageId/run-steps`.
- User message editing:
  - `PATCH /api/agent/sessions/:sessionId/messages/:messageId`,
  - only `role='user'` messages in the target session are editable.
- Conversation rollback:
  - `POST /api/agent/sessions/:sessionId/rollback`,
  - keeps the anchor message and deletes later messages, associated run steps, and child agents created after the anchor.
- Session export:
  - `GET /api/agent/sessions/:sessionId/export`,
  - returns versioned JSON with visible messages and expanded execution steps.
- Checkpoint persistence and listing:
  - checkpoint save/load/latest/list/delete primitives,
  - `GET /api/agent/sessions/:sessionId/checkpoints`.
- Stream stop semantics:
  - `POST /api/agent/stream/stop` returns 404 when no active execution exists.
- Execution status compatibility:
  - `GET /api/agent/sessions/:sessionId/task-status`,
  - `GET /api/agent/sessions/:sessionId/execution-diagnostics`,
  - `GET /api/agent/tasks/:taskId/status`,
  - `GET /api/agent/tasks/:taskId/execution-diagnostics`,
  - `GET /api/agent/tasks/running`,
  - `GET /api/agent/execution/overview`.
- Monitoring compatibility:
  - empty system metrics and metrics reset routes,
  - persisted context message-content reads,
  - persisted tool-call raw-result reads.
- Permission policy route compatibility:
  - get/replace policy,
  - update mode,
  - add/remove/clear auto-accept patterns.
- Agent config/team compatibility:
  - default system team and default agent config reads,
  - in-memory config replace/patch/delete,
  - in-memory team create/activate/delete/rename/copy/reset,
  - static tools, memory metadata, MCP server, skill, and preset listing.
- Agent management compatibility:
  - list current active-team agents in the Python registry response shape,
  - create and delete agent configs in memory,
  - protect the default/core entry agent from deletion,
  - keep reload as a compatibility no-op until the TS runtime reload exists.
- Model adapter config compatibility:
  - provider type metadata,
  - in-memory provider create/update/delete/list,
  - in-memory provider ordering.
- System config compatibility:
  - schema-form metadata for the editable AppConfig simple fields,
  - in-memory config reads and deep-merge updates,
  - reload resets the TS process copy to defaults until config-file loading is migrated.
- MCP management compatibility:
  - empty Registry search result,
  - in-memory server add/update/delete/list,
  - empty server/global tool listing.
- Daemon management compatibility:
  - idle status and default config reads,
  - in-memory daemon config updates,
  - disconnected agent/platform status and empty heartbeat history,
  - in-memory cron task create/update/delete/list/history.

Out of scope:

- Real agent execution and streaming output generation.
- Daemon runtime start/stop, social-platform adapters, outbound messages, webhook handling, and
  cron execution.
- Tool registry execution.
- MCP connection management.
- MCP Registry network search and Registry install.
- LLM provider calls.
- Model provider availability checks and live provider tests.
- Vector indexing/retrieval.
- System config YAML persistence and runtime cache refresh.
- Checkpoint recovery execution:
  - `POST /api/agent/sessions/:sessionId/recover` parses the Python-compatible body but returns `501 not_migrated` until agent execution exists.
- File-history snapshot rewind during rollback.
- Workspace/worktree cleanup during delete or rollback.
- Python skill behavior parity.

## Predefined Effects

These effects are intentional and covered by tests:

- A created session is returned by list/get endpoints.
- Empty user IDs are treated as absent for list filtering.
- Session lists derive `title`, `first_message`, `last_message`, `last_message_at`, and `unread_count` like Python.
- Message lists return the latest window in ascending sequence order, after applying Python's visible root-message filtering.
- User message edits reject non-user messages with a 404-compatible not-found response.
- Rollback requires `after_seq` or `after_message_id`, keeps the anchor, and removes later message/run-step/child-agent state.
- Runs, resources, and step-resource links persist with the same field names consumed by the Python execution persistence layer.
- Resource scope inference matches Python's managed directory buckets for `workspace`, `upload`, `export`, `transient`, and `session`.
- Checkpoint listing returns `{'checkpoints': [...]}` and supports `agent_name` and `limit` filters.
- Stream stop does not report success without a tracked active execution.
- Session export returns JSON attachment payloads with visible messages and compacted execution steps.
- `POST /api/agent/stream` with a valid payload returns HTTP 501 until the TS agent runtime is ported.
- `POST /api/agent/stream` with an empty task and no attachments returns HTTP 400.
- Synchronous execution and sequential collaboration route shapes return HTTP 501 until the TS agent runtime is ported.
- Health endpoints clearly report that `backend-ts` is running while the agent runtime is not migrated.
- Idle execution status routes return Python-compatible empty state instead of 404.
- Monitoring metrics return real empty TS runtime metrics while agent execution is unavailable.
- Agent context snapshot still returns HTTP 501; message-content and raw-result sidecar reads are served from persisted data.
- Permission policy changes are stored in the TS process memory until runtime configuration persistence is migrated.
- Agent config and team changes are stored in TS process memory until runtime config-file persistence is migrated.
- Agent config export/import and preset application return HTTP 501 until YAML/JSON config persistence is migrated.
- Agent management create/delete changes are stored in TS process memory until runtime config-file
  persistence is migrated.
- `POST /api/agent/agents/reload` returns success with `reloaded=false` while TS runtime reload
  remains unavailable.
- Model provider config changes are stored in TS process memory until model adapter config-file
  persistence is migrated.
- Model provider availability checks and `POST /api/model-adapter/test` return HTTP 501 until
  provider runtime calls are migrated.
- System config changes are stored in TS process memory until YAML persistence and runtime refresh
  are migrated.
- MCP server config changes are stored in TS process memory until MCP YAML persistence is migrated.
- MCP connect/disconnect/test and Registry install return HTTP 501 until MCP runtime management is
  migrated.
- Daemon config and cron task changes are stored in TS process memory until daemon YAML persistence
  is migrated.
- Daemon start/stop, outbound send, test message dispatch, and cron trigger return HTTP 501 until
  the daemon runtime and social-platform adapters are migrated.

## Rule

Do not fake a migrated capability. A route may exist before its implementation, but it must return
`501 not_migrated` until the behavior is ported and covered by tests.
