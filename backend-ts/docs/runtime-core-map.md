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

`GET /api/agent/runtime-core/status` covers only the configuration-readiness part today. It does
not execute the agent and keeps `can_execute=false` until the TS runtime loop is implemented.

## Surrounding Management APIs

These APIs support the runtime core but are not the core itself:

- agent/team config management,
- model provider config management,
- system/MCP/daemon/vector config management,
- file and artifact management,
- metrics and diagnostics shells.

Management APIs may be in-memory compatibility slices during migration. Runtime-core execution must
not be faked; until implemented it remains `501 not_migrated`.
