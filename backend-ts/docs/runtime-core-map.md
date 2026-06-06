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
currently migrated built-in tool loop.

Current TS runtime-core scope:

- single entry agent,
- system prompt plus recent user/assistant root-thread messages,
- OpenAI-compatible chat completion call,
- XML streaming tool-call loop,
- request_user_input interactions,
- permission approval waits for migrated tools,
- memory read/write/archive tools,
- managed file read/write/edit/structure-preview tools,
- foreground execute_bash,
- background execute_bash start, completion event, output file, and stop support,
- task tracking tools (`task_create`, `task_get`, `task_update`, `task_list`, `task_output`, `task_stop`),
- synchronous agent delegation tools,
- persisted user and final assistant messages,
- run status and compact execution steps,
- basic run lifecycle events,
- best-effort stop through `AbortController`.

Still outside runtime-core scope:

- MCP runtime,
- vector retrieval,
- token-by-token output streaming,
- slash commands and attachments.

## Surrounding Management APIs

These APIs support the runtime core but are not the core itself:

- agent/team config management,
- model provider config management,
- system/MCP/daemon/vector config management,
- file and artifact management,
- metrics and diagnostics shells.

Management APIs may be in-memory compatibility slices during migration. Runtime-core execution must
not be faked; unsupported runtime features remain explicit errors or `501 not_migrated`.
