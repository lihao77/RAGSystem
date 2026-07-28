import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import type { MemoryPluginRuntimeFactory } from "../../dependencies.js";
import { configureMemoryHooks } from "../../runtime-hook.js";
import { MemoryToolService } from "../../tools/MemoryExecution.js";
import { MemoryCandidateOps } from "./candidate-store.js";
import { LocalMemoryCandidateCommandAdapter } from "./memory-candidate-command-adapter.js";
import { LocalMemoryContextRepository } from "./memory-context-repository.js";
import { LocalMemoryApplication } from "./memory-application.js";
import { MemoryStore } from "./memory-store.js";
import { LocalMemoryToolRepository } from "./memory-tool-repository.js";
import { MemoryAgentConfigService } from "../../config.js";
import { SqliteMemoryAgentConfigStore } from "./agent-config-store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export function createLocalMemoryRuntimeFactory(): MemoryPluginRuntimeFactory {
  return (context) => {
    const dbPath = path.join(context.dataRoot, "db", "memory.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(LOCAL_MEMORY_SCHEMA);

    const candidates = new MemoryCandidateOps(db);
    const memory = new MemoryStore({ dataRoot: context.dataRoot });
    const repository = new LocalMemoryContextRepository(memory, async (workspaceId) => {
      const workspace = (await context.sessions.listWorkspacesByIds([workspaceId]))[0];
      return workspace?.canonical_key ?? null;
    });
    const tools = new MemoryToolService(
      new LocalMemoryToolRepository(memory),
      context.sessions,
      new LocalMemoryCandidateCommandAdapter(candidates),
      context.tenantId,
    );
    const agentConfig = new MemoryAgentConfigService(
      new SqliteMemoryAgentConfigStore(db, context.tenantId),
    );

    return {
      tools,
      agentConfig,
      createApplication: ({ viewerUserId, viewerSessionIds }) => new LocalMemoryApplication(
        context.tenantId,
        memory,
        candidates,
        viewerUserId,
        viewerSessionIds,
      ),
      configureHooks: (registry) => configureMemoryHooks(registry, {
        context,
        agentConfig,
        repository,
        listCandidates: async (input) => candidates.listMemoryCandidates(input),
      }),
      dispose: () => db.close(),
    };
  };
}

const LOCAL_MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_candidates (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
    target_scope TEXT NOT NULL CHECK(target_scope IN ('team', 'agent')),
    operation TEXT NOT NULL DEFAULT 'publish', target_file_name TEXT, team_name TEXT NOT NULL,
    agent_name TEXT, name TEXT NOT NULL, description TEXT NOT NULL, memory_type TEXT NOT NULL,
    content TEXT NOT NULL, why TEXT, how_to_apply TEXT,
    status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'approved', 'rejected', 'withdrawn')),
    source_session_id TEXT, source_run_id TEXT, source_message_id TEXT, reviewer_user_id TEXT,
    review_comment TEXT, published_file_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, reviewed_at TIMESTAMP,
    review_claimed_at TIMESTAMP, review_attempt_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memory_candidates_owner_status ON memory_candidates(owner_user_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_candidates_target_status ON memory_candidates(target_scope, team_name, agent_name, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_candidates_operation_status ON memory_candidates(operation, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_candidates_review_claim ON memory_candidates(status, reviewer_user_id, review_claimed_at);
`;
