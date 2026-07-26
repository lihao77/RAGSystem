import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent/agent-config.js";
import type { RuntimeMemorySessionPort } from "../../src/tools/MemoryTools/MemoryExecution.js";
import { MemoryToolService } from "../../src/tools/MemoryTools/MemoryExecution.js";
import { MemoryStore } from "../../src/adapters/local/memory-store.js";
import { LocalMemoryToolRepository } from "../../src/adapters/local/local-memory-tool-repository.js";
import type { CreateMemoryCandidateInput, MemoryCandidateRecord } from "../../src/contracts/conversation-store/index.js";
import type { MemoryToolRepositoryPort } from "../../src/contracts/memory-store/index.js";

const tempRoots: string[] = [];

const localRepository = (store: MemoryStore) => new LocalMemoryToolRepository(store);

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

class InMemorySessions implements RuntimeMemorySessionPort {
  constructor(private readonly metadataBySession: Record<string, Record<string, unknown>>) {}

  async getSession(sessionId: string) {
    return { metadata: this.metadataBySession[sessionId] ?? {} };
  }
}

describe("MemoryToolService", () => {
  it("accepts a deployment-neutral repository without Local path capabilities", async () => {
    const repository: MemoryToolRepositoryPort = {
      loadIndexHead: async () => "# Remote Memory",
      readEntryFile: async () => null,
      saveMemory: async () => ({ file_name: "entry", file_path: "entry", scope: "session" }),
      archiveMemory: async () => false,
    };
    const service = new MemoryToolService(repository, new InMemorySessions({ s1: {} }));

    expect(await service.listMemoryIndex(
      { scope: "session" },
      { agent: minimalAgent(["session"]), sessionId: "s1" },
    )).toMatchObject({
      success: true,
      content: "# Remote Memory",
      metadata: { scope: "session" },
    });
  });

  it("writes user memory beneath the current user identity", async () => {
    const dataRoot = makeTempDataRoot();
    const service = new MemoryToolService(localRepository(new MemoryStore({ dataRoot })), new InMemorySessions({ s1: {} }));

    const result = await service.writeMemory(
      { scope: "user", name: "Preference", description: "personal", memoryType: "preference", content: "compact replies" },
      { agent: minimalAgent(["user"], ["user"]), sessionId: "s1", userId: "usr_alice" },
    );

    expect(result).toMatchObject({ success: true, content: { scope: "user" } });
    expect(fs.existsSync(path.join(dataRoot, "memory", "users", "usr_alice", "preference_Preference.md"))).toBe(true);
  });

  it("stores team writes as a private candidate instead of shared memory", async () => {
    const dataRoot = makeTempDataRoot();
    const candidates = new InMemoryCandidates();
    const service = new MemoryToolService(
      localRepository(new MemoryStore({ dataRoot })),
      new InMemorySessions({ s1: { team: "alpha" } }),
      candidates,
      "tnt_alpha",
    );

    const result = await service.writeMemory(
      { scope: "team", name: "Rule", description: "team rule", memoryType: "constraint", content: "review first" },
      { agent: minimalAgent(["team"], ["team"]), sessionId: "s1", userId: "usr_alice", runId: "run-1" },
    );

    expect(result).toMatchObject({ success: true, content: { saved: true, scope: "team" } });
    expect(candidates.records).toMatchObject([{
      tenant_id: "tnt_alpha",
      owner_user_id: "usr_alice",
      target_scope: "team",
      team_name: "alpha",
      status: "candidate",
    }]);
    expect(fs.existsSync(path.join(dataRoot, "memory", "teams", "alpha", "constraint_Rule.md"))).toBe(false);
  });

  it("stores shared archive requests as private candidates without archiving the shared file", async () => {
    const dataRoot = makeTempDataRoot();
    const store = new MemoryStore({ dataRoot });
    const saved = await store.saveMemory({
      scope: "team", team_name: "alpha", name: "Shared", description: "shared", memory_type: "fact", content: "active",
    });
    const candidates = new InMemoryCandidates();
    const service = new MemoryToolService(localRepository(store), new InMemorySessions({ s1: { team: "alpha" } }), candidates, "tnt_alpha");
    const context = {
      agent: minimalAgent(["team"], [], ["team"]), sessionId: "s1", userId: "usr_alice", runId: "run-1",
    };

    expect(service.checkMemoryScopeAccess({ scope: "team" }, context, "archive")).toEqual({ action: "allow" });
    expect(await service.archiveMemory({ scope: "team", fileName: saved.file_name }, context)).toMatchObject({
      success: true,
      content: { saved: true, scope: "team" },
      metadata: { operation: "archive" },
    });
    expect(candidates.records[0]).toMatchObject({
      operation: "archive",
      target_file_name: saved.file_name,
      owner_user_id: "usr_alice",
    });
    expect(fs.readFileSync(saved.file_path, "utf8")).toContain("status: active");
  });
  it("lists memory indices with session-injected team and execution workspace inputs", async () => {
    const dataRoot = makeTempDataRoot();
    writeFile(dataRoot, ["memory", "teams", "alpha-team", "MEMORY.md"], "# Team Memory\n");
    writeFile(
      dataRoot,
      ["memory", "users", "usr_alice", "workspaces", "E-Python-RAGSystem-workspaces-demo-workspace", "MEMORY.md"],
      "# Workspace Memory\n",
    );
    const service = new MemoryToolService(
      localRepository(new MemoryStore({ dataRoot })),
      new InMemorySessions({
        s1: {
          team: "alpha-team",
        },
      }),
    );
    const context = {
      agent: minimalAgent(["team", "workspace"]),
      sessionId: "s1",
      userId: "usr_alice",
      workspaceRoot: "E:/Python/RAGSystem/workspaces/demo-workspace",
    };

    expect(await service.listMemoryIndex({ scope: "team" }, context)).toMatchObject({
      success: true,
      toolName: "list_memory_index",
      content: "# Team Memory",
      outputType: "text",
      metadata: {
        scope: "team",
        index_file_path: path.join(dataRoot, "memory", "teams", "alpha-team", "MEMORY.md"),
      },
    });
    expect(await service.listMemoryIndex({ scope: "workspace" }, context)).toMatchObject({
      success: true,
      content: "# Workspace Memory",
      metadata: {
        scope: "workspace",
      },
    });
  });

  it("reads agent memory entries and defaults agent_name to the current agent", async () => {
    const dataRoot = makeTempDataRoot();
    writeFile(
      dataRoot,
      ["memory", "teams", "alpha-team", "agents", "orchestrator_agent", "fact_alpha.md"],
      "---\nname: Alpha\n---\n\nbody\n",
    );
    const service = new MemoryToolService(
      localRepository(new MemoryStore({ dataRoot })),
      new InMemorySessions({
        s1: {
          team: "alpha-team",
        },
      }),
    );

    const result = await service.readMemoryEntry(
      {
        scope: "agent",
        fileName: "../fact_alpha.md",
      },
      {
        agent: minimalAgent(["agent"]),
        sessionId: "s1",
      },
    );

    expect(result).toMatchObject({
      success: true,
      toolName: "read_memory_entry",
      summary: "已读取记忆文件: fact_alpha.md",
      content: expect.stringContaining("body"),
      metadata: {
        file_path: path.join(dataRoot, "memory", "teams", "alpha-team", "agents", "orchestrator_agent", "fact_alpha.md"),
        scope: "agent",
      },
    });
  });

  it("rejects read access when the current agent memory scope does not allow it", () => {
    const service = new MemoryToolService(localRepository(new MemoryStore({ dataRoot: makeTempDataRoot() })), new InMemorySessions({}));

    expect(
      service.checkMemoryScopeAccess(
        { scope: "team" },
        { agent: minimalAgent(["session"]), sessionId: "s1" },
        "read",
      ),
    ).toMatchObject({
      action: "deny",
      reason: "当前 Agent 不允许访问 memory scope: team",
    });
  });

  it("writes and archives session memory using configured write/archive scopes", async () => {
    const dataRoot = makeTempDataRoot();
    const service = new MemoryToolService(
      localRepository(new MemoryStore({ dataRoot })),
      new InMemorySessions({
        s1: {},
      }),
    );
    const context = {
      agent: minimalAgent(["session"], ["session"], ["session"]),
      sessionId: "s1",
    };

    const writeResult = await service.writeMemory(
      {
        scope: "session",
        name: "Alpha Fact",
        description: "alpha fact",
        memoryType: "fact",
        content: "alpha body",
        sourceRunId: "run-1",
      },
      context,
    );

    expect(writeResult).toMatchObject({
      success: true,
      toolName: "write_memory",
      outputType: "json",
      content: {
        file_name: "fact_Alpha-Fact.md",
        scope: "session",
      },
      metadata: {
        file_path: path.join(dataRoot, "memory", "sessions", "s1", "fact_Alpha-Fact.md"),
        scope: "session",
      },
    });
    expect(fs.readFileSync(path.join(dataRoot, "memory", "sessions", "s1", "MEMORY.md"), "utf8")).toContain(
      "- [Alpha Fact](fact_Alpha-Fact.md) - alpha fact",
    );

    const archiveResult = await service.archiveMemory(
      {
        scope: "session",
        fileName: "fact_Alpha-Fact.md",
      },
      context,
    );
    expect(archiveResult).toMatchObject({
      success: true,
      toolName: "archive_memory",
      content: {
        archived: true,
        file_name: "fact_Alpha-Fact.md",
        scope: "session",
      },
    });
    expect(fs.readFileSync(path.join(dataRoot, "memory", "sessions", "s1", "fact_Alpha-Fact.md"), "utf8")).toContain(
      "status: archived",
    );
  });

  it("rejects write and archive scopes independently from readable scopes", () => {
    const service = new MemoryToolService(localRepository(new MemoryStore({ dataRoot: makeTempDataRoot() })), new InMemorySessions({ s1: {} }));
    const context = {
      agent: minimalAgent(["session"], [], []),
      sessionId: "s1",
    };

    expect(
      service.checkMemoryScopeAccess(
        { scope: "session" },
        context,
        "write",
      ),
    ).toMatchObject({
      action: "deny",
      reason: "当前 Agent 不允许写入 memory scope: session",
    });
    expect(
      service.checkMemoryScopeAccess(
        { scope: "session" },
        context,
        "archive",
      ),
    ).toMatchObject({
      action: "deny",
      reason: "当前 Agent 不允许归档 memory scope: session",
    });
  });
});

function makeTempDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-memory-tools-"));
  tempRoots.push(root);
  return root;
}

function writeFile(dataRoot: string, parts: string[], content: string): void {
  const filePath = path.join(dataRoot, ...parts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function minimalAgent(
  allowedScopes: AgentConfig["memory"]["allowed_scopes"],
  writeScopes: AgentConfig["memory"]["write_scopes"] = [],
  archiveScopes: AgentConfig["memory"]["archive_scopes"] = [],
): AgentConfig {
  return {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator Agent",
    description: null,
    enabled: true,
    default_entry: true,
    llm_tiers: {
      default: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        extra_params: {},
      },
    },
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [] },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: allowedScopes,
      write_scopes: writeScopes,
      archive_scopes: archiveScopes,
    },
    goals: { enabled: false },
    tasks: { background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: {},
  };
}

class InMemoryCandidates {
  readonly records: MemoryCandidateRecord[] = [];

  async createMemoryCandidate(input: CreateMemoryCandidateInput): Promise<MemoryCandidateRecord> {
    const record: MemoryCandidateRecord = {
      id: `candidate-${this.records.length + 1}`,
      tenant_id: input.tenantId,
      owner_user_id: input.ownerUserId,
      target_scope: input.targetScope,
      operation: input.operation ?? "publish",
      target_file_name: input.targetFileName ?? null,
      team_name: input.teamName,
      agent_name: input.agentName ?? null,
      name: input.name,
      description: input.description,
      memory_type: input.memoryType,
      content: input.content,
      why: input.why ?? null,
      how_to_apply: input.howToApply ?? null,
      status: "candidate",
      source_session_id: input.sourceSessionId ?? null,
      source_run_id: input.sourceRunId ?? null,
      source_message_id: input.sourceMessageId ?? null,
      reviewer_user_id: null,
      review_comment: null,
      published_file_name: null,
      created_at: "2026-07-17T00:00:00Z",
      updated_at: "2026-07-17T00:00:00Z",
      reviewed_at: null,
      review_claimed_at: null,
      review_attempt_id: null,
    };
    this.records.push(record);
    return record;
  }

  getMemoryCandidate(id: string) { return this.records.find((item) => item.id === id) ?? null; }
  listMemoryCandidates() { return [...this.records]; }
  countMemoryCandidates() { return this.records.length; }
  claimMemoryCandidate() { return { attemptId: "attempt-1", claimedAt: "2026-07-17T00:00:00Z" }; }
  releaseMemoryCandidate() { return true; }
  updateMemoryCandidate() { return false; }
  reviewMemoryCandidate() { return false; }
  withdrawMemoryCandidate() { return false; }
}
