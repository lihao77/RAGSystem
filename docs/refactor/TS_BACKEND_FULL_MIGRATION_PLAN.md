# TS Backend Full Migration Plan

Last updated: 2026-06-08

## Goal

Migrate the remaining Python backend capabilities into `backend-ts` without faking runtime behavior. Each functional slice must be implemented, covered by focused tests, and committed separately.

## Current Baseline

Migrated in TS:

- Fastify API foundation and health routes.
- SQLite-backed sessions, messages, runs, run steps, checkpoints, resources, uploaded files, and event outbox.
- Single-agent streaming runtime through `/api/agent/stream`.
- XML streaming tool-call loop, native tool-call fallback, approvals, user input interactions, stop/cancel, run status, WebSocket replay, and synchronous execution routes.
- Managed file tools, local search tools, bash execution, background bash tasks, restricted `execute_code`, task workflow tools, memory tools, Skill tools, hooks, vector/RAG tools, MCP tools, synchronous agent delegation, context compression, `/compact`, checkpoint recovery, file-history rollback/retry, and daemon runtime.
- Agent/team config import/export and model provider YAML-backed management slices, including provider tests, Anthropic, OpenAI Responses, embeddings, and rerank support.

Open items after this migration pass:

- No known Python-backend parity blocker remains in `backend-ts` based on the tracked migration plan and full local test suite.
- Remaining `not_migrated` text in runtime tool errors is a defensive message for hidden/unavailable tools, not an active route placeholder.
- Older Claude Code alignment docs under `docs/refactor/` still describe optional future enhancements such as richer tool display names, MCP per-tool overrides, and caching; those are not blockers for Python backend parity.

## Execution Order

1. Local runtime tools parity.
   - Implement and test `glob`, `grep`, `web_fetch`, `todo_write`.
   - Then implement and test `execute_code`.
   - Then migrate skills: skill discovery, resource loading, script execution, visualization artifact integration.
2. Stream input parity.
   - Attach uploaded/session files to runtime context.
   - Slash command parsing and execution.
3. Hook runtime.
   - Hook config loading, registry, matcher, executor, tool lifecycle integration, tests.
4. Vector/RAG runtime.
   - Provider embedding calls, vector store schema, indexing, search, rerank, delete/migrate/sync APIs.
5. MCP runtime.
   - Server config persistence, stdio/http connection lifecycle, tool discovery, runtime bridge exposure, execution, permissions.
6. Daemon runtime.
   - Scheduler, start/stop, cron trigger, platform gateway contracts, outbound dispatch.
7. File history and rollback.
   - File-history backups on tool edits, snapshot binding on user messages, rollback file restore, retry flow, cleanup.
8. Provider parity.
   - Anthropic, OpenAI Responses, provider test/availability, embeddings, rerank.
9. Final parity pass.
   - Remove obsolete `not_migrated` paths, update health/status, run full tests and smoke parity.

## Commit Policy

- One commit per functional slice.
- Each commit must include tests or an explicit documented reason when a live external integration cannot be tested locally.
- `not_migrated` routes remain until their behavior is actually implemented.

## Progress

- [x] Local runtime tools parity (`glob`, `grep`, `web_fetch`, `todo_write`).
- [x] Restricted `execute_code` runtime.
- [x] Attachments and slash commands.
- [x] Hook runtime.
- [x] Vector/RAG runtime.
- [x] MCP runtime.
- [x] Daemon runtime.
- [x] File history rollback/retry.
  - [x] Session rollback-and-retry execution flow.
  - [x] File-history snapshot creation and workspace restore.
- [x] Synchronous execution and sequential collaboration routes.
- [x] Provider parity.
  - [x] Provider availability/test endpoints.
  - [x] Anthropic and OpenAI Responses chat clients.
- [x] Agent config import.
- [x] Skills runtime tools.
  - [x] Skill discovery with workspace/global/builtin source priority.
  - [x] Skill visibility rules, resource loading, script execution, artifact protocol, team protocol, and background execution.
- [x] `/compact` system slash command.
- [x] Final parity status cleanup.

## Validation Log

- 2026-06-08 session rollback-and-retry:
  - `npm run typecheck`
  - `npx vitest run tests/routes/session-message-mutations.test.ts tests/services/agent-session-application.test.ts`
  - `npx vitest run tests/routes/runtime-core-execution.test.ts tests/routes/session-checkpoints.test.ts tests/services/agent-runtime-core.test.ts`
- 2026-06-08 file-history snapshots and workspace restore:
  - `npm run typecheck`
  - `npx vitest run tests/services/file-history-service.test.ts tests/routes/session-message-mutations.test.ts tests/services/runtime-tool-bridge.test.ts`
  - `npx vitest run tests/routes/runtime-core-execution.test.ts tests/routes/session-checkpoints.test.ts tests/services/agent-runtime-core.test.ts tests/services/agent-session-application.test.ts`
- 2026-06-08 synchronous execution and collaboration:
  - `npm run typecheck`
  - `npx vitest run tests/routes/execution-status.test.ts tests/routes/runtime-core-execution.test.ts tests/services/agent-runtime-core.test.ts`
  - `npx vitest run tests/routes/session-message-mutations.test.ts tests/routes/session-checkpoints.test.ts tests/services/runtime-tool-bridge.test.ts tests/services/file-history-service.test.ts`
- 2026-06-08 provider availability/test endpoints:
  - `npm run typecheck`
  - `npx vitest run tests/routes/model-adapter.test.ts tests/services/model-adapter-service.test.ts tests/routes/runtime-core.test.ts tests/routes/runtime-core-execution.test.ts tests/routes/execution-status.test.ts`
- 2026-06-08 Anthropic and OpenAI Responses chat clients:
  - `npm run typecheck`
  - `npx vitest run tests/services/llm-chat-client.test.ts tests/routes/model-adapter.test.ts tests/routes/runtime-core-execution.test.ts tests/services/agent-runtime-core.test.ts tests/routes/execution-status.test.ts`
- 2026-06-08 Agent config import:
  - `npm run typecheck`
  - `npx vitest run tests/routes/agent-config.test.ts tests/services/agent-config-service.test.ts`
- 2026-06-08 restricted `execute_code` runtime:
  - `npm run typecheck`
  - `npx vitest run tests/services/runtime-tool-bridge.test.ts tests/services/agent-runtime-core.test.ts tests/routes/runtime-core-execution.test.ts tests/routes/runtime-core.test.ts tests/routes/agent-config.test.ts tests/services/agent-config-service.test.ts`
- 2026-06-08 Skills runtime tools:
  - `npm run typecheck`
  - `npx vitest run tests/services/skill-tool-service.test.ts tests/services/runtime-tool-bridge.test.ts tests/routes/runtime-core-execution.test.ts tests/routes/agent-config.test.ts tests/routes/artifacts.test.ts`
  - `npx vitest run tests/services/agent-runtime-core.test.ts tests/routes/runtime-core-execution.test.ts tests/routes/runtime-core.test.ts tests/services/agent-config-service.test.ts`
- 2026-06-08 `/compact` system slash command:
  - `npm run typecheck`
  - `npx vitest run tests/services/agent-context-compression-service.test.ts tests/routes/runtime-core-execution.test.ts tests/services/agent-runtime-core.test.ts tests/routes/runtime-core.test.ts`
- 2026-06-08 final parity status cleanup:
  - `npm run typecheck`
  - `npx vitest run tests/routes/foundation.test.ts tests/routes/agent-management.test.ts tests/routes/runtime-core.test.ts tests/services/runtime-core-service.test.ts tests/routes/agent-config.test.ts`
- 2026-06-08 full backend-ts validation:
  - `npm run typecheck`
  - `npm test` (44 files, 251 tests)
