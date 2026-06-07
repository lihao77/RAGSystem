# TS Backend Full Migration Plan

Last updated: 2026-06-08

## Goal

Migrate the remaining Python backend capabilities into `backend-ts` without faking runtime behavior. Each functional slice must be implemented, covered by focused tests, and committed separately.

## Current Baseline

Already migrated in TS:

- Fastify API foundation and health routes.
- SQLite-backed sessions, messages, runs, run steps, checkpoints, resources, uploaded files, and event outbox.
- Single-agent streaming runtime through `/api/agent/stream`.
- XML streaming tool-call loop, native tool-call fallback, approvals, user input interactions, stop/cancel, run status, WebSocket replay.
- Managed file tools, bash execution, background bash tasks, task workflow tools, memory tools, synchronous agent delegation, context compression, checkpoint recovery.
- Agent/team config and model provider YAML-backed management slices.

Known gaps to close:

- Local tool parity: `glob`, `grep`, `web_fetch`, `todo_write`, `execute_code`, skill loading/execution.
- Attachments and slash command handling in `/api/agent/stream`.
- Hook runtime execution chain.
- Vector/RAG indexing, retrieval, rerank, migration, deletion, and embedding sync.
- MCP runtime connection, registry install, tool discovery, and MCP tool execution.
- Daemon runtime start/stop, platform adapters, outbound dispatch, cron execution.
- File-history snapshots and workspace rollback/retry.
- Provider parity beyond OpenAI-compatible chat completions, including OpenAI Responses, Anthropic, embeddings, rerank provider tests.
- Health/status wording and migration status consistency.

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
   - Git snapshot creation on user messages, rollback file restore, retry flow, cleanup.
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
- [x] Attachments and slash commands.
- [ ] Hook runtime.
- [ ] Vector/RAG runtime.
- [ ] MCP runtime.
- [ ] Daemon runtime.
- [ ] File history rollback/retry.
- [ ] Provider parity.
- [ ] Final parity pass.
