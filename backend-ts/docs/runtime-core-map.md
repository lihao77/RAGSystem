# Runtime Core Map

This document separates the true agent execution core from surrounding management APIs.

## Runtime Core

The runtime core is the minimum capability required for a real agent to run from configuration:

- resolve the entry agent from the active team,
- resolve the agent system prompt and enabled state,
- resolve the default or frontend-selected LLM tier,
- resolve a matching model provider configuration and chat model,
- call the LLM,
- run the agent message loop,
- execute tools and approvals,
- persist user/final messages and run steps,
- stream execution events to WebSocket clients,
- support stop/cancel semantics.

`GET /api/agent/runtime-core/status` covers the configuration-readiness part. When it returns
`can_execute=true`, `POST /api/agent/stream` can run a configured single-agent request with the
current migrated runtime tool loop.

Current TS runtime-core scope:

- single entry agent,
- system prompt plus recent user/assistant root-thread messages,
- OpenAI-compatible, Anthropic, and OpenAI Responses chat calls,
- XML streaming tool-call loop,
- native tool-call fallback,
- request_user_input interactions,
- permission approval waits for migrated tools,
- memory read/write/archive tools,
- managed file read/write/edit/structure-preview tools,
- local search tools (`glob`, `grep`, `web_fetch`, `todo_write`),
- foreground execute_bash,
- background execute_bash start, completion event, output file, and stop support,
- restricted execute_code,
- task tracking tools (`task_create`, `task_get`, `task_update`, `task_list`, `task_output`, `task_stop`),
- synchronous agent delegation tools,
- Skill activation, resource loading, metadata reads, and script execution,
- MCP tool discovery and execution,
- vector/RAG indexing and retrieval tools,
- hook execution around runtime tool lifecycles,
- attachments and uploaded/session files in runtime context,
- slash command execution, including `/compact`,
- checkpoint recovery and file-history rollback/retry,
- persisted user and final assistant messages,
- run status and compact execution steps,
- streaming lifecycle events, WebSocket replay, and durable terminal-event outbox,
- best-effort stop through `AbortController`.

Intentional unsupported modes:

- Parallel collaboration still returns HTTP 400 with `并行模式尚未实现`, matching the current
  Python backend behavior.
- Live provider, MCP, daemon gateway, embedding, and rerank behavior still depends on local
  external configuration and credentials.

## Surrounding Management APIs

These APIs support the runtime core but are not the core itself:

- agent/team config management,
- model provider config management,
- system/MCP/daemon/vector config management,
- file and artifact management,
- metrics and diagnostics shells.

Management APIs may be in-memory compatibility slices during migration. Runtime-core execution must
not be faked; unsupported future runtime features must remain explicit, tested errors until they
are implemented.
