import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ToolExecutionResult } from "../../src/services/runtime/runtime-tool-types.js";
import type { MemoryToolService } from "../../src/services/tools/memory-tool-service.js";
import { MemoryToolProvider } from "../../src/services/runtime/runtime-tool-providers/memory-tool-provider.js";

describe("MemoryToolProvider", () => {
  it("lists tools from memory scope capabilities", () => {
    const provider = new MemoryToolProvider(fakeMemoryTools());

    expect(provider.listTools({ agent: minimalAgent({ allowedScopes: [] }) })).toEqual([]);
    expect(provider.listTools({ agent: minimalAgent({ allowedScopes: ["session"] }) }).map((tool) => tool.name)).toEqual([
      "list_memory_index",
      "read_memory_entry",
    ]);
    expect(
      provider
        .listTools({
          agent: minimalAgent({
            allowedScopes: ["session"],
            writeScopes: ["session"],
            archiveScopes: ["session"],
          }),
        })
        .map((tool) => tool.name),
    ).toEqual([
      "list_memory_index",
      "read_memory_entry",
      "write_memory",
      "archive_memory",
    ]);
  });

  it("dispatches memory calls through the provider protocol", async () => {
    const calls: string[] = [];
    const provider = new MemoryToolProvider(fakeMemoryTools(calls));

    expect(provider.canHandle("list_memory_index")).toBe(true);
    expect(provider.canHandle("read_file")).toBe(false);

    const listResult = await Promise.resolve(provider.executeTool({
      toolName: "list_memory_index",
      arguments: { scope: "session" },
    }, { agent: minimalAgent({ allowedScopes: ["session"] }) }));
    const writeResult = await Promise.resolve(provider.executeTool({
      toolName: "write_memory",
      arguments: {
        scope: "session",
        name: "Preference",
        description: "desc",
        memory_type: "preference",
        content: "body",
      },
    }, { agent: minimalAgent({ allowedScopes: ["session"], writeScopes: ["session"] }) }));

    expect(calls).toEqual(["list:session", "write:Preference"]);
    expect(listResult).toMatchObject({ success: true, tool_name: "list_memory_index" });
    expect(writeResult).toMatchObject({ success: true, tool_name: "write_memory" });
  });
});

function fakeMemoryTools(calls: string[] = []): MemoryToolService {
  return {
    listMemoryIndex(input: { scope: string }) {
      calls.push(`list:${input.scope}`);
      return success("list_memory_index");
    },
    readMemoryEntry(input: { fileName: string }) {
      calls.push(`read:${input.fileName}`);
      return success("read_memory_entry");
    },
    writeMemory(input: { name: string }) {
      calls.push(`write:${input.name}`);
      return success("write_memory");
    },
    archiveMemory(input: { fileName: string }) {
      calls.push(`archive:${input.fileName}`);
      return success("archive_memory");
    },
  } as unknown as MemoryToolService;
}

function success(toolName: string): ToolExecutionResult<string> {
  return {
    success: true,
    tool_name: toolName,
    summary: "ok",
    answer: null,
    output_type: "text",
    content: "ok",
    metadata: {},
    artifacts: [],
    llm_hint: null,
  };
}

function minimalAgent(input: {
  allowedScopes: string[];
  writeScopes?: string[] | undefined;
  archiveScopes?: string[] | undefined;
}): AgentConfig {
  return {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator Agent",
    description: null,
    enabled: true,
    default_entry: true,
    llm_tiers: null,
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: input.allowedScopes,
      write_scopes: input.writeScopes ?? [],
      archive_scopes: input.archiveScopes ?? [],
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
