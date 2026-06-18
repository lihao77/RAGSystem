import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { AgentDelegationService } from "../../src/services/agent/agent-delegation-service.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { MemoryStore } from "../../src/services/stores/memory-store.js";
import { MemoryToolService, type RuntimeMemorySessionPort } from "../../src/tools/MemoryTools/MemoryExecution.js";
import { BackgroundTaskService } from "../../src/services/runtime/background-task-service.js";
import { CodeExecutionToolService } from "../../src/tools/CodeExecutionTool/CodeExecution.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import { LocalBashToolService } from "../../src/tools/BashTool/BashExecution.js";
import { LocalDocumentToolService } from "../../src/tools/DocumentTools/DocumentExecution.js";
import { LocalSearchToolService } from "../../src/tools/LocalSearchTools/SearchExecution.js";
import { SkillToolService } from "../../src/tools/SkillTools/SkillExecution.js";
import { PendingInteractionService } from "../../src/services/runtime/pending-interaction-service.js";
import { PermissionPolicyService } from "../../src/services/runtime/permission-policy-service.js";
import { RuntimeToolBridge } from "../../src/services/runtime/runtime-tool-bridge.js";
import { HookRuntimeService } from "../../src/services/runtime/hooks/index.js";
import { TaskToolService } from "../../src/tools/TaskTools/TaskExecution.js";
import { ModelAdapterService } from "../../src/services/integrations/model-adapter-service.js";
import { FileIndexService } from "../../src/services/stores/file-index-service.js";
import { VectorLibraryService } from "../../src/services/knowledge/vector-library-service.js";
import type { IKnowledgeConfig, IVectorStore, VectorRecord, VectorSearchHit } from "../../src/contracts/vector-store/index.js";
import type { McpService } from "../../src/services/integrations/mcp-service.js";

/**
 * 最小 IVectorStore & IKnowledgeConfig mock:search 返预设命中,配置面维护内存态。
 * 验证 bridge→search 编排(不依赖真 driver 召回)——配置面由 driver 单元测试覆盖。
 */
function makeFakeVectorStore(hit: VectorSearchHit): IVectorStore & IKnowledgeConfig {
  const vectorizers: Array<ReturnType<IKnowledgeConfig["createVectorizer"]>> = [];
  // 维护 upsertRecords 的内存态,read 方法据此返回(模拟 driver 真实存储,非空 stub)。
  const chunks: VectorRecord[] = [];
  const removeMatching = (predicate: (c: VectorRecord) => boolean): number => {
    const before = chunks.length;
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (predicate(chunks[i]!)) chunks.splice(i, 1);
    }
    return before - chunks.length;
  };
  return {
    upsertRecords: async (records) => {
      chunks.push(...records);
    },
    search: async () => [hit],
    deleteDocument: async (collection, documentId) => ({
      deleted_chunks: removeMatching((c) => c.collection === collection && c.doc_id === documentId),
    }),
    deleteCollection: async (collection) => ({
      deleted_chunks: removeMatching((c) => c.collection === collection),
    }),
    deleteByModel: async (model_id) => ({ deleted: removeMatching((c) => c.model_id === model_id) }),
    listCollections: async () => {
      const byName = new Map<string, { name: string; docs: Set<string>; total: number }>();
      for (const c of chunks) {
        let entry = byName.get(c.collection);
        if (!entry) {
          entry = { name: c.collection, docs: new Set(), total: 0 };
          byName.set(c.collection, entry);
        }
        entry.total += 1;
        entry.docs.add(c.doc_id);
      }
      return [...byName.values()].map((entry) => ({
        name: entry.name,
        total_chunks: entry.total,
        document_count: entry.docs.size,
        embedding_dimension: 64,
      }));
    },
    listDocuments: async (collection) => {
      const docs = new Map<string, { collection: string; document_id: string; chunk_count: number; metadata: null }>();
      for (const c of chunks) {
        if (c.collection !== collection) continue;
        let entry = docs.get(c.doc_id);
        if (!entry) {
          entry = { collection, document_id: c.doc_id, chunk_count: 0, metadata: null };
          docs.set(c.doc_id, entry);
        }
        entry.chunk_count += 1;
      }
      return [...docs.values()];
    },
    listChunks: async (collection) =>
      chunks
        .filter((c) => !collection || c.collection === collection)
        .map((c) => ({
          id: Number(c.id) || 0,
          collection: c.collection,
          document_id: c.doc_id,
          chunk_index: c.chunk_index,
          content: c.content,
          metadata: c.metadata,
        })),
    listAllDocuments: async () => {
      const docs = new Map<string, { collection: string; document_id: string; chunk_count: number; metadata: null }>();
      for (const c of chunks) {
        const key = `${c.collection}::${c.doc_id}`;
        let entry = docs.get(key);
        if (!entry) {
          entry = { collection: c.collection, document_id: c.doc_id, chunk_count: 0, metadata: null };
          docs.set(key, entry);
        }
        entry.chunk_count += 1;
      }
      return [...docs.values()];
    },
    countVectors: async (collection, model_id) =>
      chunks.filter((c) => c.collection === collection && c.model_id === model_id).length,
    countVectorsByModel: async (model_id) => {
      const byCol = new Map<string, number>();
      for (const c of chunks) {
        if (c.model_id === model_id) byCol.set(c.collection, (byCol.get(c.collection) ?? 0) + 1);
      }
      return [...byCol.entries()].map(([collection, count]) => ({ collection, count }));
    },
    countVectorsForDocument: async (collection, documentId, model_id) =>
      chunks.filter((c) => c.collection === collection && c.doc_id === documentId && c.model_id === model_id).length,
    countChunks: async (collection) => chunks.filter((c) => c.collection === collection).length,
    getDimension: () => 64,
    health: async () => ({
      status: "healthy",
      runtime: "mock",
      ann: true,
      collections_count: new Set(chunks.map((c) => c.collection)).size,
    }),
    close: () => {},
    listVectorizers: () => vectorizers,
    getVectorizerByKey: (key) => vectorizers.find((v) => v.vectorizer_key === key) ?? null,
    getVectorizerByModelId: (modelId) => vectorizers.find((v) => v.model_id === modelId) ?? null,
    createVectorizer: (input) => {
      const stored = {
        model_id: vectorizers.length + 1,
        vectorizer_key: input.vectorizer_key,
        provider_key: input.provider_key,
        provider_type: input.provider_type,
        model_name: input.model_name,
        distance_metric: input.distance_metric,
        created_at: new Date().toISOString(),
        vector_dimension: null,
        is_active: vectorizers.length === 0,
      };
      vectorizers.push(stored);
      return stored;
    },
    deleteVectorizer: (key) => {
      const idx = vectorizers.findIndex((v) => v.vectorizer_key === key);
      if (idx >= 0) vectorizers.splice(idx, 1);
      const next = vectorizers[0];
      if (next) next.is_active = true;
      return { next_active_key: next?.vectorizer_key ?? null };
    },
    activateVectorizer: (key) => {
      for (const v of vectorizers) v.is_active = v.vectorizer_key === key;
    },
    listRerankers: () => [],
    getReranker: () => null,
    createReranker: (input) => ({
      reranker_key: input.reranker_key,
      mode: input.mode,
      provider_key: input.provider_key,
      provider_type: input.provider_type,
      model_name: input.model_name,
      api_endpoint: input.api_endpoint,
      api_key: input.api_key,
      created_at: new Date().toISOString(),
      is_active: true,
    }),
    deleteReranker: () => ({ next_active_key: null }),
    activateReranker: () => {},
  };
}

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

function createDurableClientEvents(): {
  store: ConversationStore;
  realtimeEvents: RealtimeEventHub;
  clientEvents: DurableClientEventPublisher;
} {
  const store = createConversationStore({ dbPath: ":memory:" });
  const realtimeEvents = new RealtimeEventHub();
  const dispatcher = new OutboxDispatcher(store, realtimeEvents);
  return {
    store,
    realtimeEvents,
    clientEvents: new DurableClientEventPublisher(store, dispatcher),
  };
}

describe("RuntimeToolBridge", () => {
  it("exposes memory tools from agent memory scope capabilities", () => {
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
    );

    expect(bridge.listVisibleToolNames(minimalAgent(["session"]))).toEqual([
      "list_memory_index",
      "read_memory_entry",
    ]);
    expect(bridge.listVisibleToolNames(minimalAgent(["session"], [], [], ["session"], ["session"]))).toEqual([
      "list_memory_index",
      "read_memory_entry",
      "write_memory",
      "archive_memory",
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

  it("exposes and dispatches agent delegation tools only when delegation is configured", async () => {
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
    );
    const agent = minimalAgent([], [], ["plan_agent"]);
    const calls: Array<{ input: unknown; sessionId: string | null | undefined }> = [];
    const fakeDelegation = {
      async callAgent(input: unknown, context: { sessionId?: string | null }) {
        calls.push({ input, sessionId: context.sessionId });
        return delegationSuccess("call_agent", "delegated");
      },
      listChildAgents() {
        return delegationSuccess("list_child_agents", { items: [], total: 0 });
      },
      sendMessage() {
        return delegationSuccess("send_message", "resumed");
      },
    } as unknown as AgentDelegationService;

    expect(bridge.listVisibleToolNames(agent)).toEqual([]);

    bridge.setAgentDelegation(fakeDelegation);

    expect(bridge.listVisibleToolNames(agent)).toEqual(["call_agent", "list_child_agents", "send_message"]);
    await expect(
      bridge.executeTool(
        {
          toolName: "call_agent",
          callId: "delegate-1",
          arguments: {
            agent_name: "plan_agent",
            task: "拆解迁移任务",
            context_hint: "只输出步骤",
          },
        },
        {
          agent,
          sessionId: "s1",
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      tool_name: "call_agent",
      content: "delegated",
    });
    expect(calls).toEqual([
      {
        input: {
          agentName: "plan_agent",
          task: "拆解迁移任务",
          contextHint: "只输出步骤",
          callId: "delegate-1",
        },
        sessionId: "s1",
      },
    ]);
  });

  it("normalizes call id into runtime tool execution context", async () => {
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
    );
    const agent = minimalAgent([], [], ["plan_agent"]);
    const calls: Array<{ input: unknown; context: unknown }> = [];
    const fakeDelegation = {
      async callAgent(input: unknown, context: unknown) {
        calls.push({ input, context });
        return delegationSuccess("call_agent", "delegated");
      },
      listChildAgents() {
        return delegationSuccess("list_child_agents", { items: [], total: 0 });
      },
      sendMessage() {
        return delegationSuccess("send_message", "resumed");
      },
    } as unknown as AgentDelegationService;
    bridge.setAgentDelegation(fakeDelegation);

    await bridge.executeTool(
      {
        toolName: "call_agent",
        callId: "delegate-ctx-1",
        arguments: {
          agent_name: "plan_agent",
          task: "拆解迁移任务",
        },
      },
      {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        parentCallId: "call-root",
        currentAgentName: "orchestrator_agent",
      },
    );

    expect(calls).toMatchObject([
      {
        input: {
          callId: "delegate-ctx-1",
        },
        context: {
          sessionId: "s1",
          runId: "run-1",
          requestId: "req-1",
          parentCallId: "call-root",
          currentAgentName: "orchestrator_agent",
          toolCallId: "delegate-ctx-1",
        },
      },
    ]);
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

  it("exposes and executes knowledge tools when knowledge base is enabled", async () => {
    const dataRoot = makeTempDataRoot();
    const fileIndex = new FileIndexService({ dbPath: ":memory:", dataRoot });
    const fakeStore = makeFakeVectorStore({
      id: "1",
      doc_id: "rag-doc",
      document_id: "rag-doc",
      collection: "kb",
      content: "TypeScript backend now supports RAG knowledge base retrieval.",
      metadata: { source_file: "migration.md" },
      vector_score: 0.8,
      keyword_score: 0,
      hybrid_score: 0,
    });
    const vectorLibrary = new VectorLibraryService(
      fileIndex,
      new ModelAdapterService({ providersConfigPath: "" }),
      {
        vectorStore: fakeStore,
        knowledgeConfig: fakeStore,
      },
    );
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      vectorLibrary,
    );
    const agent = {
      ...minimalAgent([]),
      knowledge_base: {
        enabled: true,
        default_collection: "kb",
        default_search_mode: "hybrid",
        default_top_k: 2,
        default_rerank: false,
        default_reranker_key: null,
      },
    } satisfies AgentConfig;

    await vectorLibrary.indexDocument({
      collection_name: "kb",
      document_id: "rag-doc",
      text: "TypeScript backend now supports RAG knowledge base retrieval.",
      metadata: { source_file: "migration.md" },
    });

    expect(bridge.listVisibleToolNames(minimalAgent([]))).toEqual([]);
    expect(bridge.listVisibleToolNames(agent)).toEqual([
      "search_knowledge_base",
      "list_knowledge_collections",
    ]);

    const searchResult = await Promise.resolve(bridge.executeTool(
      {
        toolName: "search_knowledge_base",
        arguments: { query: "RAG retrieval" },
      },
      { agent },
    ));
    expect(searchResult).toMatchObject({
      success: true,
      tool_name: "search_knowledge_base",
      content: expect.stringContaining("migration.md"),
      metadata: {
        count: 1,
        collection: "kb",
        search_mode: "hybrid",
      },
    });

    const collectionsResult = await Promise.resolve(bridge.executeTool(
      {
        toolName: "list_knowledge_collections",
        arguments: {},
      },
      { agent },
    ));
    expect(collectionsResult).toMatchObject({
      success: true,
      tool_name: "list_knowledge_collections",
      content: "- kb: 1 文档, 1 分块",
      metadata: { count: 1 },
    });

    vectorLibrary.close();
    fileIndex.close();
  });

  it("exposes and executes connected MCP tools for enabled servers", async () => {
    const mcpCalls: Array<{ toolName: string; args: Record<string, unknown> | undefined }> = [];
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        listRuntimeTools(enabledServers: string[]) {
          return enabledServers.includes("mock")
            ? [{
                name: "mcp__mock__echo",
                description: "[MCP:mock] Echo text",
                parameters: { type: "object", properties: { text: { type: "string" } } },
                source: "mcp",
                category: "mcp",
                riskLevel: "low",
                server_name: "mock",
                original_tool_name: "echo",
              }]
            : [];
        },
        async callRuntimeTool(toolName: string, args: Record<string, unknown> | undefined) {
          mcpCalls.push({ toolName, args });
          return delegationSuccess(toolName, `echo:${String(args?.text ?? "")}`);
        },
      } as unknown as McpService,
    );
    const agent = {
      ...minimalAgent([]),
      mcp: { enabled_servers: ["mock"] },
    } satisfies AgentConfig;

    expect(bridge.listVisibleToolNames(minimalAgent([]))).toEqual([]);
    expect(bridge.listVisibleToolNames(agent)).toEqual(["mcp__mock__echo"]);

    const result = await Promise.resolve(bridge.executeTool(
      {
        toolName: "mcp__mock__echo",
        arguments: { text: "hello" },
      },
      { agent },
    ));
    expect(result).toMatchObject({
      success: true,
      tool_name: "mcp__mock__echo",
      content: "echo:hello",
    });
    expect(mcpCalls).toEqual([
      {
        toolName: "mcp__mock__echo",
        args: { text: "hello" },
      },
    ]);
  });

  it("dispatches write_memory and archive_memory calls to memory tools", () => {
    const dataRoot = makeTempDataRoot();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} })),
    );
    const context = {
      agent: minimalAgent(["session"], [], [], ["session"], ["session"]),
      sessionId: "s1",
    };

    expect(
      bridge.executeTool(
        {
          toolName: "write_memory",
          arguments: {
            scope: "session",
            name: "Alpha Fact",
            description: "alpha fact",
            memory_type: "fact",
            content: "alpha body",
          },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "write_memory",
      content: {
        file_name: "fact_Alpha-Fact.md",
        scope: "session",
      },
    });
    expect(
      bridge.executeTool(
        {
          toolName: "archive_memory",
          arguments: {
            scope: "session",
            file_name: "fact_Alpha-Fact.md",
          },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "archive_memory",
      content: {
        archived: true,
        file_name: "fact_Alpha-Fact.md",
      },
    });
  });

  it("exposes and executes read_file when enabled by agent config", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-alpha");
    writeAbsoluteFile(path.join(workspaceRoot, "notes", "sample.txt"), "line 1\nline 2\nline 3\n");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["read_file"]);

    expect(bridge.listVisibleToolNames(agent)).toEqual(["read_file"]);
    expect(
      bridge.executeTool(
        {
          toolName: "read_file",
          arguments: { file_path: "notes/sample.txt", offset: 2, limit: 1 },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).toMatchObject({
      success: true,
      tool_name: "read_file",
      content: "line 2",
      metadata: {
        total_lines: 3,
        start_line: 2,
        end_line: 2,
        has_more: true,
        next_offset: 3,
      },
    });
  });

  it("rejects invalid read_file pagination like the Python backend", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-read-invalid");
    writeAbsoluteFile(path.join(workspaceRoot, "sample.txt"), "line 1\n");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["read_file"]);
    const context = { agent, sessionId: "s1", workspaceRoot };

    expect(
      bridge.executeTool(
        {
          toolName: "read_file",
          arguments: { file_path: "sample.txt", offset: 0 },
        },
        context,
      ),
    ).toMatchObject({
      success: false,
      output_type: "error",
      content: "offset 必须 >= 1",
    });
    expect(
      bridge.executeTool(
        {
          toolName: "read_file",
          arguments: { file_path: "sample.txt", limit: 0 },
        },
        context,
      ),
    ).toMatchObject({
      success: false,
      output_type: "error",
      content: "limit 必须 >= 1",
    });
  });

  it("previews JSON, CSV, YAML, and text structures through managed paths", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-preview");
    writeAbsoluteFile(
      path.join(workspaceRoot, "data", "sample.json"),
      '{"name":"dataset","items":[{"id":1,"tags":["a","b"],"meta":{"city":"Nanning"}}]}',
    );
    writeAbsoluteFile(path.join(workspaceRoot, "data", "sample.csv"), "name,age,active\nAlice,30,true\nBob,28,false\n");
    writeAbsoluteFile(path.join(workspaceRoot, "data", "sample.yaml"), "service:\n  name: api\n  replicas: 3\nfeatures:\n  - search\n  - export\n");
    writeAbsoluteFile(path.join(workspaceRoot, "data", "notes.txt"), "alpha\n\nbeta line\ncharlie\n");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["preview_data_structure"]);
    const context = {
      agent,
      sessionId: "s1",
      workspaceRoot,
    };

    expect(bridge.listVisibleToolNames(agent)).toEqual(["preview_data_structure"]);
    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "data/sample.json" },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "preview_data_structure",
      output_type: "json",
      content: {
        file_type: "json",
        structure: {
          type: "object",
          fields: {
            name: { type: "string" },
            items: {
              type: "array",
              item_structure: {
                fields: {
                  id: { types: ["integer"] },
                },
              },
            },
          },
        },
      },
    });
    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "data/sample.csv", max_preview_rows: 1 },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: {
        file_type: "csv",
        structure: {
          root_type: "table",
          columns: ["name", "age", "active"],
          sample_row_count: 1,
          column_types: {
            age: { types: ["integer"] },
            active: { types: ["boolean"] },
          },
          sample_rows: [
            {
              name: "Alice",
            },
          ],
        },
      },
    });
    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "data/sample.yaml", max_depth: 2 },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: {
        file_type: "yaml",
        structure: {
          type: "object",
          fields: {
            service: { type: "object" },
            features: { type: "array" },
          },
        },
      },
    });
    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "data/notes.txt", max_preview_rows: 2 },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: {
        file_type: "txt",
        structure: {
          root_type: "text",
          total_lines: 4,
          non_empty_lines: 3,
          preview_lines: ["alpha", ""],
        },
      },
    });
  });

  it("rejects invalid preview_data_structure limits", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-preview-invalid");
    writeAbsoluteFile(path.join(workspaceRoot, "sample.json"), "{}");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["preview_data_structure"]);

    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "sample.json", max_depth: 0 },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).toMatchObject({
      success: false,
      output_type: "error",
      content: expect.stringContaining("max_depth"),
    });
  });

  it("executes write_file and edit_file through managed workspace paths", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-beta");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["write_file", "edit_file"]);
    const context = {
      agent,
      sessionId: "s1",
      workspaceRoot,
    };

    expect(bridge.listVisibleToolNames(agent)).toEqual(["write_file", "edit_file"]);
    expect(
      bridge.executeTool(
        {
          toolName: "write_file",
          arguments: {
            file_path: "notes/todo.txt",
            content: "before\n",
          },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "write_file",
      output_type: "text",
      content: {
        display_path: expect.stringContaining("notes/todo.txt"),
      },
    });

    expect(
      bridge.executeTool(
        {
          toolName: "edit_file",
          arguments: {
            file_path: "notes/todo.txt",
            old_string: "before",
            new_string: "after",
          },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "edit_file",
      content: {
        replacements: 1,
        diff_preview: expect.stringContaining("-before"),
      },
    });
    expect(fs.readFileSync(path.join(workspaceRoot, "notes", "todo.txt"), "utf8")).toBe("after\n");
  });

  it("executes glob and grep through managed workspace paths", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-search");
    writeAbsoluteFile(path.join(workspaceRoot, "src", "alpha.ts"), "export const alpha = 1;\n");
    writeAbsoluteFile(path.join(workspaceRoot, "src", "beta.ts"), "export const beta = alpha + 1;\n");
    writeAbsoluteFile(path.join(workspaceRoot, "notes.txt"), "Alpha note\n");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      null,
      null,
      null,
      new LocalSearchToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["glob", "grep"]);
    const context = {
      agent,
      sessionId: "s1",
      workspaceRoot,
    };

    expect(bridge.listVisibleToolNames(agent)).toEqual(["glob", "grep"]);
    expect(
      bridge.executeTool(
        {
          toolName: "glob",
          arguments: { pattern: "**/*.ts" },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "glob",
      content: {
        files: ["src/alpha.ts", "src/beta.ts"],
        count: 2,
      },
    });
    expect(
      bridge.executeTool(
        {
          toolName: "grep",
          arguments: { pattern: "alpha", glob: "**/*.ts", case_sensitive: true },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "grep",
      content: {
        count: 2,
        matches: [
          { file: "src/alpha.ts", line_number: 1 },
          { file: "src/beta.ts", line_number: 1 },
        ],
      },
    });
  });

  it("executes todo_write as a session-scoped runtime tool", () => {
    const dataRoot = makeTempDataRoot();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} })),
      null,
      null,
      null,
      null,
      null,
      new LocalSearchToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["todo_write"]);

    expect(
      bridge.executeTool(
        {
          toolName: "todo_write",
          arguments: {
            todos: [
              { content: "迁移 glob", status: "completed" },
              { content: "迁移 RAG", status: "pending", active_form: "正在迁移 RAG" },
            ],
          },
        },
        { agent, sessionId: "s1" },
      ),
    ).toMatchObject({
      success: true,
      tool_name: "todo_write",
      content: {
        count: 2,
        pending_count: 1,
        completed_count: 1,
      },
    });
    expect(
      bridge.executeTool(
        {
          toolName: "todo_write",
          arguments: { todos: [{ content: "bad", status: "blocked" }] },
        },
        { agent, sessionId: "s1" },
      ),
    ).toMatchObject({
      success: false,
      output_type: "error",
      content: expect.stringContaining("status 非法值"),
    });
  });

  it("executes Python code in a restricted sandbox with managed workspace files", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace");
    writeAbsoluteFile(path.join(workspaceRoot, "sample.json"), "{\"name\":\"workspace\"}");
    const codeExecution = new CodeExecutionToolService({ dataRoot });
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      codeExecution,
    );
    codeExecution.setRuntimeTools(bridge);
    const agent = {
      ...minimalAgent([], ["execute_code"]),
      custom_params: {
        workspace_root: workspaceRoot,
      },
    };

    const result = await bridge.executeTool(
      {
        toolName: "execute_code",
        arguments: {
          code: [
            "print('hello sandbox')",
            "content = open('sample.json', 'r').read()",
            "with open('result.txt', 'w') as f:",
            "    f.write('generated')",
            "result = {'content': content, 'sandbox_dir': SANDBOX_DIR}",
          ].join("\n"),
        },
      },
      {
        agent,
        sessionId: "code-session",
        runId: "run-1",
      },
    );

    expect(result).toMatchObject({
      success: true,
      tool_name: "execute_code",
      content: {
        content: "{\"name\":\"workspace\"}",
      },
      metadata: {
        stdout: expect.stringContaining("hello sandbox"),
        tool_calls_count: 0,
      },
    });
    expect(fs.readFileSync(path.join(dataRoot, "sessions", "code-session", "sandbox", "result.txt"), "utf8")).toBe("generated");

    const forbiddenImport = await bridge.executeTool(
      {
        toolName: "execute_code",
        arguments: {
          code: "import os\nresult = os.getcwd()",
        },
      },
      { agent, sessionId: "code-session" },
    );
    expect(forbiddenImport).toMatchObject({
      success: false,
      content: expect.stringContaining("禁止导入模块: os"),
    });
  });

  it("allows execute_code to call code-callable tools and rejects direct-only file tools", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace");
    writeAbsoluteFile(path.join(workspaceRoot, "sample.json"), "{\"items\":[1,2]}");
    const documentTools = new LocalDocumentToolService({ dataRoot });
    const codeExecution = new CodeExecutionToolService({ dataRoot });
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      documentTools,
      null,
      null,
      null,
      null,
      null,
      null,
      codeExecution,
    );
    codeExecution.setRuntimeTools(bridge);
    const agent = {
      ...minimalAgent([], ["execute_code", "preview_data_structure", "read_file"]),
      custom_params: {
        workspace_root: workspaceRoot,
      },
    };

    await expect(
      bridge.executeTool(
        {
          toolName: "execute_code",
          arguments: {
            code: "result = call_tool('preview_data_structure', {'file_path': 'sample.json'})",
          },
        },
        { agent, sessionId: "code-session", runId: "run-1" },
      ),
    ).resolves.toMatchObject({
      success: true,
      content: expect.objectContaining({
        file_type: "json",
      }),
      metadata: {
        tool_calls_count: 1,
      },
    });

    await expect(
      bridge.executeTool(
        {
          toolName: "execute_code",
          arguments: {
            code: "result = call_tool('read_file', {'file_path': 'sample.json'})",
          },
        },
        { agent, sessionId: "code-session", runId: "run-1" },
      ),
    ).resolves.toMatchObject({
      success: false,
      content: expect.stringContaining("不允许从代码调用"),
    });
  });

  it("enforces allowed_callers without relying on the execute_code sandbox", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace");
    writeAbsoluteFile(path.join(workspaceRoot, "sample.json"), "{\"items\":[1,2]}");
    const documentTools = new LocalDocumentToolService({ dataRoot });
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      documentTools,
    );
    const agent = {
      ...minimalAgent([], ["preview_data_structure", "read_file"]),
      custom_params: {
        workspace_root: workspaceRoot,
      },
    };
    const context = { agent, sessionId: "code-session", runId: "run-1" };

    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "sample.json" },
        },
        { ...context, caller: "code_execution" },
      ),
    ).toMatchObject({
      success: true,
      content: {
        file_type: "json",
      },
    });

    expect(
      bridge.executeTool(
        {
          toolName: "read_file",
          arguments: { file_path: "sample.json" },
        },
        { ...context, caller: "code_execution" },
      ),
    ).toMatchObject({
      success: false,
      content: expect.stringContaining("不允许从代码调用"),
    });
  });

  it("exposes and executes Skill tools when skills auto injection is enabled", async () => {
    const dataRoot = makeTempDataRoot();
    const skillsRoot = path.join(dataRoot, "skills-root");
    writeSkillFixture(path.join(skillsRoot, "demo-skill"), {
      name: "demo-skill",
      description: "demo skill",
      body: "# Demo Skill\n",
    });
    const skillTools = new SkillToolService({
      dataRoot,
      builtinSkillsRoot: skillsRoot,
      userGlobalSkillsRoot: path.join(dataRoot, "global-skills"),
    });
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      skillTools,
    );
    const agent = {
      ...minimalAgent([], []),
      skills: { enabled_skills: ["demo-skill"], auto_inject: true },
    };
    const noSkillAgent = {
      ...minimalAgent([], []),
      skills: { enabled_skills: [], auto_inject: true },
    };

    expect(bridge.listVisibleToolNames(noSkillAgent)).toEqual([]);
    expect(bridge.listVisibleToolNames(agent)).toEqual([
      "activate_skill",
      "load_skill_resource",
      "execute_skill_script",
      "get_skill_info",
    ]);
    expect(
      bridge.executeTool(
        {
          toolName: "get_skill_info",
          arguments: { skill_name: "demo-skill" },
        },
        { agent, sessionId: "skill-session" },
      ),
    ).toMatchObject({
      success: true,
      content: {
        name: "demo-skill",
        description: "demo skill",
      },
    });
  });

  it("auto exposes workspace Skill tools for default entry agents", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace");
    writeSkillFixture(path.join(workspaceRoot, ".ragsystem", "skills", "workspace-skill"), {
      name: "workspace-skill",
      description: "workspace skill",
      body: "# Workspace Skill\n",
    });
    const skillTools = new SkillToolService({
      dataRoot,
      builtinSkillsRoot: path.join(dataRoot, "builtin-empty"),
      userGlobalSkillsRoot: path.join(dataRoot, "global-skills"),
    });
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      skillTools,
    );
    const agent = {
      ...minimalAgent([], []),
      custom_params: { workspace_root: workspaceRoot },
      skills: { enabled_skills: [], auto_inject: true },
    };

    expect(bridge.listVisibleToolNames(agent)).toEqual([
      "activate_skill",
      "load_skill_resource",
      "execute_skill_script",
      "get_skill_info",
    ]);
    expect(
      bridge.executeTool(
        { toolName: "get_skill_info", arguments: { skill_name: "workspace-skill" } },
        { agent, sessionId: "skill-session", workspaceRoot },
      ),
    ).toMatchObject({
      success: true,
      content: {
        name: "workspace-skill",
      },
    });
  });

  it("runs hook lifecycle handlers around tool execution", async () => {
    const dataRoot = makeTempDataRoot();
    const hooks = new HookRuntimeService({ enabled: false });
    hooks.registerHandler("test:annotate-before", () => ({
      continueExecution: true,
      blockExecution: false,
      blockReason: "",
      tags: ["before-tag"],
      metadata: { before_seen: true },
      additionalContext: ["extra context"],
    }));
    hooks.registerHandler("test:annotate-after", ({ context }) => ({
      continueExecution: true,
      blockExecution: false,
      blockReason: "",
      tags: ["after-tag"],
      metadata: { result_success: context.resultSnapshot.success },
    }));
    hooks.registerHook({
      id: "annotate-before",
      name: "Annotate Before",
      events: ["tool.before_execute"],
      matcher: { toolNames: ["write_file"] },
      backend: { type: "function", target: "test:annotate-before" },
    });
    hooks.registerHook({
      id: "annotate-after",
      name: "Annotate After",
      events: ["tool.after_execute"],
      matcher: { toolNames: ["write_file"], whenResultSuccess: true },
      backend: { type: "function", target: "test:annotate-after" },
    });
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
      null,
      null,
      null,
      hooks,
    );

    const result = await bridge.executeTool(
      {
        toolName: "write_file",
        arguments: {
          file_path: "notes/hook.txt",
          content: "hooked",
        },
      },
      {
        agent: minimalAgent([], ["write_file"]),
        sessionId: "hook-session",
      },
    );

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      hook_additional_context: { before_execute: ["extra context"] },
      hook_phase_metadata: {
        before_execute: { before_seen: true },
        after_execute: { result_success: true },
      },
      hook_tags: {
        before_execute: ["before-tag"],
        after_execute: ["after-tag"],
      },
    });
  });

  it("allows before-execute hooks to block tool execution", async () => {
    const dataRoot = makeTempDataRoot();
    const hooks = new HookRuntimeService({ enabled: false });
    hooks.registerHandler("test:block", () => ({
      continueExecution: false,
      blockExecution: true,
      blockReason: "blocked by hook",
      tags: ["blocked"],
    }));
    hooks.registerHook({
      id: "block-writes",
      name: "Block Writes",
      events: ["tool.before_execute"],
      matcher: { toolNames: ["write_file"] },
      backend: { type: "function", target: "test:block" },
    });
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
      null,
      null,
      null,
      hooks,
    );

    const result = await bridge.executeTool(
      {
        toolName: "write_file",
        arguments: {
          file_path: "notes/blocked.txt",
          content: "blocked",
        },
      },
      {
        agent: minimalAgent([], ["write_file"]),
        sessionId: "hook-block-session",
      },
    );

    expect(result.success).toBe(false);
    expect(result.summary).toBe("blocked by hook");
    expect(result.metadata).toMatchObject({
      hook_blocked: true,
      hook_phase: "before_execute",
      hook_tags: { before_execute: ["blocked"] },
    });
    expect(fs.existsSync(path.join(dataRoot, "workspace", "notes", "blocked.txt"))).toBe(false);
  });

  it("executes web_fetch against an HTTP endpoint", async () => {
    const dataRoot = makeTempDataRoot();
    const server = await startHttpServer("<html><body><h1>Alpha</h1><p>Beta content</p></body></html>");
    try {
      const bridge = new RuntimeToolBridge(
        new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} })),
        null,
        null,
        null,
        null,
        null,
        new LocalSearchToolService({ dataRoot }),
      );
      const agent = minimalAgent([], ["web_fetch"]);

      await expect(
        Promise.resolve(
          bridge.executeTool(
            {
              toolName: "web_fetch",
              arguments: { url: server.url },
            },
            { agent, sessionId: "s1" },
          ),
        ),
      ).resolves.toMatchObject({
        success: true,
        tool_name: "web_fetch",
        content: expect.stringContaining("Beta content"),
        metadata: {
          status_code: 200,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("allows direct absolute writes under session exports when run_id is absent", () => {
    const dataRoot = makeTempDataRoot();
    const agent = minimalAgent([], ["write_file"]);
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const filePath = path.join(dataRoot, "sessions", "s1", "exports", "report.txt");

    const result = bridge.executeTool(
      {
        toolName: "write_file",
        arguments: {
          file_path: filePath,
          content: "report",
        },
      },
      { agent, sessionId: "s1" },
    );

    expect(result).toMatchObject({
      success: true,
      content: {
        file_path: filePath,
      },
    });
    expect(fs.readFileSync(filePath, "utf8")).toBe("report");
  });

  it("asks for approval before reading external absolute paths", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-read-external");
    const externalRoot = makeTempDataRoot();
    const externalFile = path.join(externalRoot, "external.txt");
    writeAbsoluteFile(externalFile, "external content");
    const { store, realtimeEvents, clientEvents } = createDurableClientEvents();
    const pendingInteractions = new PendingInteractionService(clientEvents);
    const permissionPolicy = new PermissionPolicyService();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      pendingInteractions,
      permissionPolicy,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["read_file"]);

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "read_file",
          callId: "read-external-call",
          arguments: { file_path: externalFile },
        },
        {
          agent,
          sessionId: "s1",
          runId: "run-read-external",
          workspaceRoot,
        },
      ),
    );

    const approvalRequired = realtimeEvents.getHistory("s1").find((event) => event.type === "interaction.required");
    expect(approvalRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "approval",
      approval_id: expect.any(String),
      approval_type: "tool_execution",
      tool_call_id: "read-external-call",
      tool_name: "read_file",
      risk_level: "low",
      permission_mode: "standard",
      approval_reason: "路径越界访问需要审批",
      approval_reason_codes: ["ask-path"],
      approved_external_paths: [externalFile],
      arguments: {
        file_path: externalFile,
      },
    });

    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;
    expect(
      pendingInteractions.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: true,
        message: "允许读取外部文件",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
    });

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      tool_name: "read_file",
      content: "external content",
      metadata: {
        approval_message: "允许读取外部文件",
        approval: {
          reason: "路径越界访问需要审批",
          note: "允许读取外部文件",
          reason_codes: ["ask-path"],
          approved_external_paths: [externalFile],
        },
      },
    });
    store.close();
  });

  it("still requires run_id for explicit exports writes", () => {
    const dataRoot = makeTempDataRoot();
    const agent = minimalAgent([], ["write_file"]);
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );

    expect(
      bridge.executeTool(
        {
          toolName: "write_file",
          arguments: {
            file_path: "report.txt",
            file_path_space: "exports",
            content: "report",
          },
        },
        { agent, sessionId: "s1" },
      ),
    ).toMatchObject({
      success: false,
      output_type: "error",
      content: expect.stringContaining("exports 路径缺少 run_id"),
    });
  });

  it("asks for approval before using external execute_bash working directories", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-external");
    const externalRoot = makeTempDataRoot();
    const { store, realtimeEvents, clientEvents } = createDurableClientEvents();
    const pendingInteractions = new PendingInteractionService(clientEvents);
    const permissionPolicy = new PermissionPolicyService();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      pendingInteractions,
      permissionPolicy,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          callId: "bash-external-call",
          arguments: {
            command: "echo external-ok",
            working_dir: externalRoot,
          },
        },
        {
          agent,
          sessionId: "s1",
          runId: "run-bash-external",
          workspaceRoot,
        },
      ),
    );

    const approvalRequired = realtimeEvents.getHistory("s1").find((event) => event.type === "interaction.required");
    expect(approvalRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "approval",
      approval_id: expect.any(String),
      approval_type: "bash_command",
      tool_call_id: "bash-external-call",
      tool_name: "execute_bash",
      risk_level: "low",
      approval_reason: "路径越界访问需要审批",
      approval_reason_codes: ["ask-path"],
      approved_external_paths: [externalRoot],
      arguments: expect.objectContaining({
        command: "echo external-ok",
        working_dir: externalRoot,
        classification: "read_only",
      }),
    });

    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;
    expect(
      pendingInteractions.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: true,
        message: "允许外部工作目录",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
    });

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      tool_name: "execute_bash",
      metadata: {
        approval_message: "允许外部工作目录",
        approval: {
          reason: "路径越界访问需要审批",
          note: "允许外部工作目录",
          reason_codes: ["ask-path"],
          approved_external_paths: [externalRoot],
        },
      },
    });
    store.close();
  });

  it("exposes and executes execute_bash when enabled by agent config", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    expect(bridge.listVisibleToolNames(agent)).toEqual(["execute_bash"]);
    await expect(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "echo hello",
          },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      tool_name: "execute_bash",
      content: {
        stdout: expect.stringContaining("hello"),
        return_code: 0,
        interrupted: false,
        background_started: false,
        classification: "read_only",
      },
      metadata: {
        classification: "read_only",
        risk_level: "low",
      },
    });
  });

  it("exposes task workflow and background tools from task capability config", () => {
    const dataRoot = makeTempDataRoot();
    const backgroundTasks = new BackgroundTaskService();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      null,
      null,
      new TaskToolService(backgroundTasks, { dataRoot }),
    );
    const workflowAgent = minimalAgent([]);
    workflowAgent.tasks = { workflow: true, background: false };
    const backgroundAgent = minimalAgent([]);
    backgroundAgent.tasks = { workflow: false, background: true };
    const explicitOutputAgent = minimalAgent([], ["task_output"]);

    expect(bridge.listVisibleToolNames(workflowAgent)).toEqual([
      "task_create",
      "task_get",
      "task_update",
      "task_list",
    ]);
    expect(bridge.listVisibleToolNames(backgroundAgent)).toEqual(["task_output", "task_stop"]);
    expect(bridge.listVisibleToolNames(explicitOutputAgent)).toEqual(["task_output"]);
  });

  it("creates, updates, lists, and links session tasks", async () => {
    const dataRoot = makeTempDataRoot();
    const backgroundTasks = new BackgroundTaskService();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      null,
      null,
      new TaskToolService(backgroundTasks, { dataRoot }),
    );
    const agent = minimalAgent([]);
    agent.tasks = { workflow: true, background: false };
    const context = { agent, sessionId: "s1" };

    const first = await Promise.resolve(
      bridge.executeTool(
        {
          toolName: "task_create",
          arguments: {
            subject: "Build task graph",
            description: "Track migration steps",
            active_form: "Building task graph",
            metadata: { priority: "high", temporary: "yes" },
          },
        },
        context,
      ),
    );
    expect(first).toMatchObject({
      success: true,
      content: {
        task: {
          id: "1",
          subject: "Build task graph",
          status: "pending",
          metadata: { priority: "high", temporary: "yes" },
        },
      },
      metadata: {
        task_id: "1",
        session_id: "s1",
      },
    });

    const second = await Promise.resolve(
      bridge.executeTool(
        {
          toolName: "task_create",
          arguments: {
            subject: "Run verification",
            description: "Verify migrated task tooling",
          },
        },
        context,
      ),
    );
    expect(second).toMatchObject({
      success: true,
      content: {
        task: {
          id: "2",
          blocked_by: [],
        },
      },
    });

    await expect(
      Promise.resolve(
        bridge.executeTool(
          {
            toolName: "task_update",
            arguments: {
              task_id: "1",
              status: "in_progress",
              owner: "orchestrator_agent",
              add_blocks: ["2"],
              metadata: { temporary: null },
            },
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      success: true,
      content: {
        task_id: "1",
        updated_fields: expect.arrayContaining(["status", "owner", "blocks", "metadata"]),
        status_change: { from: "pending", to: "in_progress" },
      },
    });

    await expect(
      Promise.resolve(
        bridge.executeTool(
          {
            toolName: "task_get",
            arguments: { task_id: "2" },
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      success: true,
      content: {
        task: {
          id: "2",
          blocked_by: ["1"],
        },
      },
    });

    await expect(
      Promise.resolve(
        bridge.executeTool(
          {
            toolName: "task_update",
            arguments: { task_id: "1", status: "completed" },
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      success: true,
      content: {
        status_change: { from: "in_progress", to: "completed" },
      },
    });

    await expect(
      Promise.resolve(bridge.executeTool({ toolName: "task_list", arguments: {} }, context)),
    ).resolves.toMatchObject({
      success: true,
      content: {
        tasks: [
          {
            id: "1",
            subject: "Build task graph",
            status: "completed",
            owner: "orchestrator_agent",
            blocked_by: [],
          },
          {
            id: "2",
            subject: "Run verification",
            status: "pending",
            owner: "",
            blocked_by: [],
          },
        ],
      },
      metadata: {
        count: 2,
        session_id: "s1",
      },
    });

    const stored = JSON.parse(fs.readFileSync(path.join(dataRoot, "tasks", "s1", "1.json"), "utf8")) as Record<string, unknown>;
    expect(stored.metadata).toEqual({ priority: "high" });
  });

  it("preserves empty-string task updates like the Python task tool", async () => {
    const dataRoot = makeTempDataRoot();
    const backgroundTasks = new BackgroundTaskService();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({})),
      null,
      null,
      null,
      null,
      new TaskToolService(backgroundTasks, { dataRoot }),
    );
    const agent = minimalAgent([]);
    agent.tasks = { workflow: true, background: false };
    const context = { agent, sessionId: "s1" };

    await Promise.resolve(
      bridge.executeTool(
        {
          toolName: "task_create",
          arguments: {
            subject: "Clear mutable fields",
            description: "Verify empty-string updates",
            active_form: "Clearing mutable fields",
          },
        },
        context,
      ),
    );
    await Promise.resolve(
      bridge.executeTool(
        {
          toolName: "task_update",
          arguments: {
            task_id: "1",
            owner: "agent-a",
          },
        },
        context,
      ),
    );

    await expect(
      Promise.resolve(
        bridge.executeTool(
          {
            toolName: "task_update",
            arguments: {
              task_id: "1",
              owner: "",
              active_form: "",
            },
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      success: true,
      content: {
        updated_fields: expect.arrayContaining(["owner", "active_form"]),
      },
    });

    await expect(
      Promise.resolve(
        bridge.executeTool(
          {
            toolName: "task_get",
            arguments: { task_id: "1" },
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      success: true,
      content: {
        task: {
          owner: "",
          active_form: "",
        },
      },
    });
  });

  it("starts background bash, exposes output through task_output, and emits completion events", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-background");
    const { store, realtimeEvents, clientEvents } = createDurableClientEvents();
    const backgroundTasks = new BackgroundTaskService();
    const taskTools = new TaskToolService(backgroundTasks, { dataRoot });
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null, backgroundTasks, clientEvents }),
      taskTools,
    );
    const agent = minimalAgent([], ["execute_bash", "task_output"]);
    agent.tasks = { workflow: false, background: true };
    const context = {
      agent,
      sessionId: "s1",
      runId: "run-bg-1",
      taskId: "owner-task-1",
      workspaceRoot,
    };

    const started = await Promise.resolve(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "echo background-output",
            run_in_background: true,
            timeout: 10,
            description: "background echo",
          },
        },
        context,
      ),
    );
    expect(started).toMatchObject({
      success: true,
      tool_name: "execute_bash",
      content: {
        background_started: true,
        background_task_id: expect.any(String),
        return_code: null,
      },
      metadata: {
        background_started: true,
        background_task_id: expect.any(String),
        background_output_path: expect.stringContaining("/sessions/s1/transient/bg_"),
        run_id: "run-bg-1",
        background_kind: "bash",
        cancel_supported: true,
      },
    });

    const backgroundTaskId = (started.content as { background_task_id: string }).background_task_id;
    await waitFor(() => realtimeEvents.getHistory("s1").some((event) => event.type === "background.task.completed"));

    expect(realtimeEvents.getHistory("s1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "background.task.completed",
          session_id: "s1",
          run_id: "run-bg-1",
          data: expect.objectContaining({
            background_task_id: backgroundTaskId,
            status: "completed",
            return_code: 0,
            success: true,
            owner_task_id: "owner-task-1",
            result_type: "bash_output",
          }),
        }),
      ]),
    );
    expect(
      store.listOutboxForReplay({ sessionId: "s1" }).map((row) => ({
        eventType: row.event_type,
        status: row.status,
        sessionSeq: row.session_seq,
      })),
    ).toEqual([
      { eventType: "client.background.task.completed", status: "delivered", sessionSeq: 1 },
    ]);

    await expect(
      Promise.resolve(
        bridge.executeTool(
          {
            toolName: "task_output",
            arguments: { task_id: backgroundTaskId, max_chars: 8000 },
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      success: true,
      tool_name: "task_output",
      content: {
        task_id: backgroundTaskId,
        status: "completed",
        completed: true,
        return_code: 0,
        result_type: "bash_output",
        kind: "bash",
        cancel_supported: true,
        output: expect.stringContaining("background-output"),
      },
      metadata: {
        task_id: backgroundTaskId,
        status: "completed",
        completed: true,
      },
    });
    store.close();
  });

  it("rejects background bash when tasks.background is disabled", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-background-disabled");
    const backgroundTasks = new BackgroundTaskService();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null, backgroundTasks }),
      new TaskToolService(backgroundTasks, { dataRoot }),
    );
    const agent = minimalAgent([], ["execute_bash"]);
    agent.tasks = { workflow: false, background: false };

    await expect(
      Promise.resolve(
        bridge.executeTool(
          {
            toolName: "execute_bash",
            arguments: {
              command: "echo should-not-background",
              run_in_background: true,
            },
          },
          { agent, sessionId: "s1", workspaceRoot },
        ),
      ),
    ).resolves.toMatchObject({
      success: false,
      tool_name: "execute_bash",
      content: expect.stringContaining("未启用 tasks.background"),
      metadata: {
        background_started: false,
      },
    });
    expect(backgroundTasks.drainPendingNotifications("s1")).toEqual([]);
  });

  it("stops cancellable background bash tasks", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-stop");
    const { store, realtimeEvents, clientEvents } = createDurableClientEvents();
    const backgroundTasks = new BackgroundTaskService();
    const permissionPolicy = new PermissionPolicyService();
    permissionPolicy.setMode("dangerously_skip_permissions");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      permissionPolicy,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null, backgroundTasks, clientEvents }),
      new TaskToolService(backgroundTasks, { dataRoot }),
    );
    const agent = minimalAgent([], ["execute_bash"]);
    agent.tasks = { workflow: false, background: true };
    const context = {
      agent,
      sessionId: "s1",
      runId: "run-bg-stop",
      workspaceRoot,
    };

    const started = await Promise.resolve(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "node -e \"setTimeout(function(){}, 5000)\"",
            run_in_background: true,
            timeout: 10,
            description: "long running node",
          },
        },
        context,
      ),
    );
    expect(started).toMatchObject({
      success: true,
      content: {
        background_started: true,
        background_task_id: expect.any(String),
      },
    });

    const backgroundTaskId = (started.content as { background_task_id: string }).background_task_id;
    await expect(
      Promise.resolve(
        bridge.executeTool(
          {
            toolName: "task_stop",
            arguments: { task_id: backgroundTaskId },
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      success: true,
      tool_name: "task_stop",
      content: {
        task_id: backgroundTaskId,
        found: true,
        stop_requested: true,
        previous_status: "running",
        current_status: "cancelled",
        cancel_supported: true,
      },
      metadata: {
        task_id: backgroundTaskId,
        status: "cancelled",
      },
    });
    await waitFor(
      () =>
        realtimeEvents.getHistory("s1").some(
          (event) =>
            event.type === "background.task.completed" &&
            (event.data as { background_task_id?: string } | undefined)?.background_task_id === backgroundTaskId,
        ),
      5000,
    );
    expect(store.listOutboxForReplay({ sessionId: "s1" })).toEqual([
      expect.objectContaining({
        event_type: "client.background.task.completed",
        status: "delivered",
      }),
    ]);
    store.close();
  });

  it("blocks unsafe execute_bash command syntax before approval", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-block");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    await expect(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "echo $(whoami)",
          },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).toMatchObject({
      success: false,
      tool_name: "execute_bash",
      content: expect.stringContaining("命令安全检查失败"),
    });
  });

  it("asks for approval before execute_bash write commands", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-approval");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const { store, realtimeEvents, clientEvents } = createDurableClientEvents();
    const pendingInteractions = new PendingInteractionService(clientEvents);
    const permissionPolicy = new PermissionPolicyService();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      pendingInteractions,
      permissionPolicy,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          callId: "bash-approval-call",
          arguments: {
            command: "mkdir created_dir",
            description: "create a test directory",
          },
        },
        {
          agent,
          sessionId: "s1",
          runId: "run-bash-approval",
          taskId: "task-bash-approval",
          requestId: "req-bash-approval",
          workspaceRoot,
        },
      ),
    );

    const approvalRequired = realtimeEvents.getHistory("s1").find((event) => event.type === "interaction.required");
    expect(approvalRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "approval",
      approval_id: expect.any(String),
      approval_type: "bash_command",
      tool_call_id: "bash-approval-call",
      tool_name: "execute_bash",
      risk_level: "medium",
      approval_reason: "当前策略要求人工审批",
      arguments: expect.objectContaining({
        command: "mkdir created_dir",
        command_segments: ["mkdir"],
        classification: "write",
      }),
    });

    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;
    expect(
      pendingInteractions.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: true,
        message: "允许创建目录",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
    });

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      tool_name: "execute_bash",
      metadata: {
        approval_required_commands: ["mkdir"],
        approval_message: "允许创建目录",
        approval: {
          reason: "当前策略要求人工审批",
          note: "允许创建目录",
        },
      },
    });
    expect(fs.existsSync(path.join(workspaceRoot, "created_dir"))).toBe(true);
    store.close();
  });

  it("terminates execute_bash when timeout is reached", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-timeout");
    const permissionPolicy = new PermissionPolicyService();
    permissionPolicy.setMode("dangerously_skip_permissions");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      permissionPolicy,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    await expect(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "node -e \"setTimeout(function(){}, 2000)\"",
            timeout: 1,
          },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      tool_name: "execute_bash",
      summary: expect.stringContaining("命令执行超时"),
      content: {
        interrupted: true,
      },
      metadata: {
        classification: "interpreter",
        risk_level: "high",
      },
    });
  });

  it("marks execute_bash truncated only when stdout exceeds the output limit", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-stdout-truncate");
    const permissionPolicy = new PermissionPolicyService();
    permissionPolicy.setMode("dangerously_skip_permissions");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      permissionPolicy,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null, maxOutputChars: 5 }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    await expect(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "node -e \"process.stdout.write('abcdefghijkl')\"",
          },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      tool_name: "execute_bash",
      summary: "命令执行完成，返回码 0（stdout 已截断）",
      content: {
        stdout: "abcde",
      },
      metadata: {
        truncated: true,
      },
    });
  });

  it("clips long execute_bash stderr without marking stdout truncation", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-stderr-truncate");
    const permissionPolicy = new PermissionPolicyService();
    permissionPolicy.setMode("dangerously_skip_permissions");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      permissionPolicy,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);
    const result = await Promise.resolve(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "node -e \"process.stderr.write('e'.repeat(2105))\"",
          },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    );

    expect(result).toMatchObject({
      success: true,
      tool_name: "execute_bash",
      summary: "命令执行完成，返回码 0",
      metadata: {
        truncated: false,
      },
    });
    expect((result.content as { stderr: string }).stderr).toHaveLength(2000);
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

  it("runs request_user_input through pending user input interactions", async () => {
    const { store, realtimeEvents, clientEvents } = createDurableClientEvents();
    const pendingInteractions = new PendingInteractionService(clientEvents);
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
      pendingInteractions,
    );

    expect(bridge.listVisibleToolNames(minimalAgent([]))).toEqual(["request_user_input"]);

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "request_user_input",
          callId: "input-call-1",
          arguments: {
            prompt: "使用哪个 memory scope？",
            input_type: "select",
            options: ["session", "workspace"],
          },
        },
        {
          agent: minimalAgent([]),
          sessionId: "s1",
          runId: "run-1",
          taskId: "task-1",
          requestId: "req-1",
          currentAgentName: "orchestrator_agent",
        },
      ),
    );

    const interactionRequired = realtimeEvents.getHistory("s1").find((event) => event.type === "interaction.required");
    expect(interactionRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "user_input",
      input_id: expect.any(String),
      tool_call_id: "input-call-1",
      tool_name: "request_user_input",
      prompt: "使用哪个 memory scope？",
      input_type: "select",
      options: ["session", "workspace"],
      run_id: "run-1",
      task_id: "task-1",
      request_id: "req-1",
    });

    const inputRequired = realtimeEvents.getHistory("s1").find((event) => event.type === "user.input_required");
    expect(inputRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "user_input",
      input_id: expect.any(String),
      tool_call_id: "input-call-1",
      tool_name: "request_user_input",
      prompt: "使用哪个 memory scope？",
      input_type: "select",
      options: ["session", "workspace"],
      run_id: "run-1",
      task_id: "task-1",
      request_id: "req-1",
    });

    const inputId = (inputRequired?.data as { input_id: string }).input_id;
    expect((interactionRequired?.data as { interaction_id: string }).interaction_id).toBe(inputId);
    expect(bridge.listVisibleToolNames(minimalAgent(["session"]))).toEqual([
      "request_user_input",
      "list_memory_index",
      "read_memory_entry",
    ]);
    expect(inputId).toBeTruthy();
    expect(pendingInteractions.isUserInputPending("s1", inputId)).toBe(true);
    expect(pendingInteractions.respondUserInput("s1", inputId, { value: "session" })).toBe(true);

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      tool_name: "request_user_input",
      summary: "用户输入已接收",
      content: "session",
      metadata: {
        input_id: inputId,
        input_type: "select",
        options: ["session", "workspace"],
        degraded: false,
      },
    });
    store.close();
  });

  it("waits for approval before executing tools when policy asks", async () => {
    const dataRoot = makeTempDataRoot();
    writeFile(dataRoot, ["memory", "sessions", "s1", "MEMORY.md"], "# Approved Memory\n");
    const { store, realtimeEvents, clientEvents } = createDurableClientEvents();
    const pendingInteractions = new PendingInteractionService(clientEvents);
    const permissionPolicy = new PermissionPolicyService();
    permissionPolicy.setMode("strict");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} })),
      pendingInteractions,
      permissionPolicy,
    );

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "list_memory_index",
          callId: "approval-call-1",
          arguments: { scope: "session" },
        },
        {
          agent: minimalAgent(["session"]),
          sessionId: "s1",
          runId: "run-approval-1",
          taskId: "task-approval-1",
          requestId: "req-approval-1",
          currentAgentName: "orchestrator_agent",
        },
      ),
    );

    const approvalRequired = realtimeEvents.getHistory("s1").find((event) => event.type === "interaction.required");
    expect(approvalRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "approval",
      approval_id: expect.any(String),
      approval_type: "tool_execution",
      tool_call_id: "approval-call-1",
      tool_name: "list_memory_index",
      risk_level: "low",
      permission_mode: "strict",
      approval_reason: "严格模式：low 风险工具需要审批",
      approval_reason_codes: ["ask-risk"],
    });

    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;
    expect(pendingInteractions.isApprovalPending("s1", approvalId)).toBe(true);
    expect(
      pendingInteractions.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: true,
        message: "允许读取",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
    });

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      tool_name: "list_memory_index",
      content: "# Approved Memory",
      metadata: {
        approval_message: "允许读取",
        approval: {
          reason: "严格模式：low 风险工具需要审批",
          note: "允许读取",
          reason_codes: ["ask-risk"],
        },
      },
    });
    store.close();
  });

  it("returns a tool error when approval is denied", async () => {
    const { store, realtimeEvents, clientEvents } = createDurableClientEvents();
    const pendingInteractions = new PendingInteractionService(clientEvents);
    const permissionPolicy = new PermissionPolicyService();
    permissionPolicy.setMode("strict");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({ s1: {} })),
      pendingInteractions,
      permissionPolicy,
    );

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "list_memory_index",
          callId: "approval-call-deny",
          arguments: { scope: "session" },
        },
        {
          agent: minimalAgent(["session"]),
          sessionId: "s1",
        },
      ),
    );
    const approvalRequired = realtimeEvents.getHistory("s1").find((event) => event.type === "interaction.required");
    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;

    expect(
      pendingInteractions.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: false,
        message: "不允许",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
    });

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      output_type: "error",
      content: "工具 list_memory_index 执行已被拒绝：不允许",
      metadata: {
        approval: {
          reason: "严格模式：low 风险工具需要审批",
          note: "不允许",
          reason_codes: ["ask-risk"],
        },
      },
    });
    store.close();
  });
});

function makeTempDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-runtime-tool-"));
  tempRoots.push(root);
  return root;
}

function writeFile(dataRoot: string, parts: string[], content: string): void {
  const filePath = path.join(dataRoot, ...parts);
  writeAbsoluteFile(filePath, content);
}

function writeAbsoluteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeSkillFixture(
  skillDir: string,
  input: { name: string; description: string; body: string },
): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n${input.body}`,
    "utf8",
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function startHttpServer(body: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not bind to a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function delegationSuccess<T>(toolName: string, content: T) {
  return {
    success: true,
    tool_name: toolName,
    summary: "ok",
    answer: null,
    output_type: typeof content === "string" ? "text" : "json",
    content,
    metadata: {},
    artifacts: [],
    llm_hint: null,
  };
}

function minimalAgent(
  allowedScopes: string[],
  enabledTools: string[] = [],
  delegatedAgents: string[] = [],
  writeScopes: string[] = [],
  archiveScopes: string[] = [],
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
    tools: { enabled_tools: enabledTools },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: allowedScopes,
      write_scopes: writeScopes,
      archive_scopes: archiveScopes,
    },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: delegatedAgents },
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
