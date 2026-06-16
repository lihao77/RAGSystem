import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { RuntimeMemorySessionPort } from "../../src/tools/MemoryTools/MemoryExecution.js";
import { MemoryToolService } from "../../src/tools/MemoryTools/MemoryExecution.js";
import { MemoryStore } from "../../src/services/stores/memory-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

class InMemorySessions implements RuntimeMemorySessionPort {
  constructor(private readonly metadataBySession: Record<string, Record<string, unknown>>) {}

  getSession(sessionId: string) {
    return { metadata: this.metadataBySession[sessionId] ?? {} };
  }
}

describe("MemoryToolService", () => {
  it("lists memory indices with session-injected team and workspace scope inputs", () => {
    const dataRoot = makeTempDataRoot();
    writeFile(dataRoot, ["memory", "teams", "alpha-team", "MEMORY.md"], "# Team Memory\n");
    writeFile(
      dataRoot,
      ["memory", "workspaces", "E-Python-RAGSystem-workspaces-demo-workspace", "MEMORY.md"],
      "# Workspace Memory\n",
    );
    const service = new MemoryToolService(
      new MemoryStore({ dataRoot }),
      new InMemorySessions({
        s1: {
          team: "alpha-team",
          workspace_root: "E:/Python/RAGSystem/workspaces/demo-workspace",
        },
      }),
    );
    const context = {
      agent: minimalAgent(["team", "workspace"]),
      sessionId: "s1",
    };

    expect(service.listMemoryIndex({ scope: "team" }, context)).toMatchObject({
      success: true,
      tool_name: "list_memory_index",
      content: "# Team Memory",
      output_type: "text",
      metadata: {
        scope: "team",
        index_file_path: path.join(dataRoot, "memory", "teams", "alpha-team", "MEMORY.md"),
      },
    });
    expect(service.listMemoryIndex({ scope: "workspace" }, context)).toMatchObject({
      success: true,
      content: "# Workspace Memory",
      metadata: {
        scope: "workspace",
      },
    });
  });

  it("reads agent memory entries and defaults agent_name to the current agent", () => {
    const dataRoot = makeTempDataRoot();
    writeFile(
      dataRoot,
      ["memory", "teams", "alpha-team", "agents", "orchestrator_agent", "fact_alpha.md"],
      "---\nname: Alpha\n---\n\nbody\n",
    );
    const service = new MemoryToolService(
      new MemoryStore({ dataRoot }),
      new InMemorySessions({
        s1: {
          team: "alpha-team",
        },
      }),
    );

    const result = service.readMemoryEntry(
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
      tool_name: "read_memory_entry",
      summary: "已读取记忆文件: fact_alpha.md",
      content: expect.stringContaining("body"),
      metadata: {
        file_path: path.join(dataRoot, "memory", "teams", "alpha-team", "agents", "orchestrator_agent", "fact_alpha.md"),
        scope: "agent",
      },
    });
  });

  it("rejects read access when the current agent memory scope does not allow it", () => {
    const service = new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({}));

    expect(
      service.listMemoryIndex(
        {
          scope: "team",
        },
        {
          agent: minimalAgent(["session"]),
          sessionId: "s1",
        },
      ),
    ).toMatchObject({
      success: false,
      output_type: "error",
      content: "当前 Agent 不允许访问 memory scope: team",
      metadata: {
        source_shape: "error",
      },
    });
  });

  it("writes and archives session memory using configured write/archive scopes", () => {
    const dataRoot = makeTempDataRoot();
    const service = new MemoryToolService(
      new MemoryStore({ dataRoot }),
      new InMemorySessions({
        s1: {},
      }),
    );
    const context = {
      agent: minimalAgent(["session"], ["session"], ["session"]),
      sessionId: "s1",
    };

    const writeResult = service.writeMemory(
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
      tool_name: "write_memory",
      output_type: "json",
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

    const archiveResult = service.archiveMemory(
      {
        scope: "session",
        fileName: "fact_Alpha-Fact.md",
      },
      context,
    );
    expect(archiveResult).toMatchObject({
      success: true,
      tool_name: "archive_memory",
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
    const dataRoot = makeTempDataRoot();
    const service = new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} }));
    const context = {
      agent: minimalAgent(["session"], [], []),
      sessionId: "s1",
    };

    expect(
      service.writeMemory(
        {
          scope: "session",
          name: "Alpha Fact",
          description: "alpha fact",
          memoryType: "fact",
          content: "alpha body",
        },
        context,
      ),
    ).toMatchObject({
      success: false,
      content: "当前 Agent 不允许写入 memory scope: session",
    });
    expect(
      service.archiveMemory(
        {
          scope: "session",
          fileName: "fact_Alpha-Fact.md",
        },
        context,
      ),
    ).toMatchObject({
      success: false,
      content: "当前 Agent 不允许归档 memory scope: session",
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

function minimalAgent(allowedScopes: string[], writeScopes: string[] = [], archiveScopes: string[] = []): AgentConfig {
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
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: allowedScopes,
      write_scopes: writeScopes,
      archive_scopes: archiveScopes,
    },
    tasks: { workflow: false, background: false },
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
