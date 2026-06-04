import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { MemoryStore } from "../../src/services/memory-store.js";
import { MemoryToolService, type RuntimeMemorySessionPort } from "../../src/services/memory-tool-service.js";
import { RuntimeToolBridge } from "../../src/services/runtime-tool-bridge.js";

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

describe("RuntimeToolBridge", () => {
  it("exposes read-only memory tools from agent memory allowed scopes", () => {
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
    );

    expect(bridge.listVisibleToolNames(minimalAgent(["session"]))).toEqual([
      "list_memory_index",
      "read_memory_entry",
    ]);
    expect(bridge.listVisibleTools(minimalAgent(["session"]))).toEqual([
      expect.objectContaining({
        name: "list_memory_index",
        parameters: expect.objectContaining({
          required: ["scope"],
        }),
      }),
      expect.objectContaining({
        name: "read_memory_entry",
        parameters: expect.objectContaining({
          required: ["scope", "file_name"],
        }),
      }),
    ]);
    expect(bridge.listVisibleToolNames(minimalAgent([]))).toEqual([]);
  });

  it("dispatches list_memory_index and read_memory_entry calls to memory tools", () => {
    const dataRoot = makeTempDataRoot();
    writeFile(dataRoot, ["memory", "sessions", "s1", "MEMORY.md"], "# Session Memory\n");
    writeFile(dataRoot, ["memory", "sessions", "s1", "fact_alpha.md"], "alpha body\n");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} })),
    );
    const context = {
      agent: minimalAgent(["session"]),
      sessionId: "s1",
    };

    expect(
      bridge.executeTool(
        {
          toolName: "list_memory_index",
          arguments: { scope: "session" },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: "# Session Memory",
    });
    expect(
      bridge.executeTool(
        {
          toolName: "read_memory_entry",
          arguments: { scope: "session", file_name: "fact_alpha.md" },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: "alpha body\n",
      metadata: {
        scope: "session",
      },
    });
  });

  it("rejects tools that are not visible for the current agent", () => {
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
    );

    expect(
      bridge.executeTool(
        {
          toolName: "write_memory",
          arguments: {},
        },
        {
          agent: minimalAgent(["session"]),
          sessionId: "s1",
        },
      ),
    ).toMatchObject({
      success: false,
      output_type: "error",
      content: "工具未暴露或暂未迁移: write_memory",
    });
  });
});

function makeTempDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-runtime-tool-"));
  tempRoots.push(root);
  return root;
}

function writeFile(dataRoot: string, parts: string[], content: string): void {
  const filePath = path.join(dataRoot, ...parts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function minimalAgent(allowedScopes: string[]): AgentConfig {
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
      write_scopes: [],
      archive_scopes: [],
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
