import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { AgentDelegationService } from "../../src/services/agent/delegation/index.js";
import type { AgentRunEngine } from "../../src/services/agent/execution/run-engine.js";
import type { RuntimeExecutionConfigResolver } from "../../src/services/agent/execution/runtime-core-service.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";

describe("AgentDelegationService", () => {
  it("lists child agents and resumes an existing child thread with send_message", async () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const clientEvents = new DurableClientEventPublisher(store, dispatcher);
    const workerAgent = minimalAgent("worker_agent");
    const service = new AgentDelegationService(store, runtimeCoreStub(workerAgent), clientEvents);

    // 子 run 复用 root 的 executeRun 执行核心（run-engine 那套由 runtime-core-execution 端到端覆盖）。
    // 这里 mock executeRun：验证 delegation 把 child 归属（threadKey/parent_run_id/child_agent_id/parent_call_id）
    // 正确传入统一执行核心，并模拟 recorder 的 final 落库 + 终态，让续接断言可观测。
    const seenInputs: Array<Record<string, unknown>> = [];
    const mockEngine = {
      async executeRun(input: Record<string, unknown>) {
        seenInputs.push(input);
        const threadKey = String(input.threadKey);
        const childAgentId = (input.childAgentId as string | null | undefined) ?? null;
        const runId = String(input.runId);
        const sessionId = String(input.sessionId);
        const finalMsg = store.addMessage({
          sessionId,
          role: "assistant",
          content: "resumed answer",
          threadKey,
          childAgentId,
          metadata: { agent: "worker_agent", run_id: runId, msg_type: "assistant_final" },
        });
        store.updateRunStatus(runId, sessionId, "completed", finalMsg.id);
        return { content: "resumed answer", success: true };
      },
    } as unknown as AgentRunEngine;
    service.setRunEngine(() => mockEngine);

    store.createSession("session-1", null, {
      team: "default",
      workspace_root: "E:/workspace",
    });
    const child = store.createChildAgent({
      sessionId: "session-1",
      childAgentId: "child-existing",
      agentName: "worker_agent",
      threadKey: "child:child-existing",
      parentRunId: "parent-run",
      parentCallId: "parent-call",
      metadata: {
        created_via: "call_agent",
        thread_key: "child:child-existing",
        workspace_root: "E:/workspace",
      },
    });
    store.addMessage({
      sessionId: "session-1",
      role: "assistant",
      content: "previous answer",
      threadKey: child.thread_key,
      childAgentId: child.child_agent_id,
    });

    expect(
      service.listChildAgents({ agentName: "worker_agent" }, { agent: minimalAgent("orchestrator_agent"), sessionId: "session-1" }),
    ).toMatchObject({
      success: true,
      content: {
        items: [
          expect.objectContaining({
            child_agent_id: "child-existing",
            agent_name: "worker_agent",
          }),
        ],
        total: 1,
      },
    });

    const result = await service.sendMessage(
      {
        childAgentId: "child-existing",
        message: "继续分析",
        callId: "resume-call",
      },
      {
        agent: minimalAgent("orchestrator_agent"),
        sessionId: "session-1",
        runId: "parent-run",
        requestId: "request-1",
        currentAgentName: "orchestrator_agent",
        teamName: "default",
        workspaceRoot: "E:/workspace",
      },
    );

    expect(result).toMatchObject({
      success: true,
      tool_name: "send_message",
      content: "resumed answer",
      metadata: {
        agent_name: "worker_agent",
        child_agent_id: "child-existing",
        agent_call_id: expect.stringMatching(/^call_/),
        parent_call_id: "resume-call",
        mode: "resume",
      },
    });
    expect(result.llm_hint).toBeNull();

    // delegation 给 executeRun 传了正确的 child 归属：统一执行核心靠 parent_call_id/child_agent_id 区分父子
    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).toMatchObject({
      sessionId: "session-1",
      threadKey: "child:child-existing",
      parentRunId: "parent-run",
      childAgentId: "child-existing",
      rootCallId: result.metadata.agent_call_id,
      executionKind: "send_message",
    });

    const updatedChild = store.getChildAgent("session-1", "child-existing");
    expect(updatedChild?.last_run_id).toBe(result.metadata.run_id);
    const childMessages = store.listMessages("session-1", 20, 0, "child:child-existing").items;
    expect(childMessages.map((message) => [message.role, message.content, message.child_agent_id])).toEqual([
      ["assistant", "previous answer", "child-existing"],
      ["user", "继续分析", "child-existing"],
      ["assistant", "resumed answer", "child-existing"],
    ]);
    const callEvents = realtimeEvents
      .getHistory("session-1")
      .filter((event) => event.type === "call.agent.start" || event.type === "call.agent.end");
    expect(callEvents.map((event) => event.event_seq)).toEqual([1, 2]);
    expect(callEvents).toEqual([
      expect.objectContaining({
        type: "call.agent.start",
        agent_name: "orchestrator_agent",
        parent_call_id: "resume-call",
        call_id: result.metadata.agent_call_id,
        data: {
          agent_name: "worker_agent",
          description: "继续分析",
          agent_display_name: "worker_agent",
          child_agent_id: "child-existing",
          mode: "resume",
        },
      }),
      expect.objectContaining({
        type: "call.agent.end",
        agent_name: "orchestrator_agent",
        parent_call_id: "resume-call",
        call_id: result.metadata.agent_call_id,
        data: {
          agent_name: "worker_agent",
          result: "resumed answer",
          success: true,
          agent_display_name: "worker_agent",
          child_agent_id: "child-existing",
          mode: "resume",
        },
      }),
    ]);
    expect(
      store.listOutboxForReplay({ sessionId: "session-1" }).map((row) => ({
        eventType: row.event_type,
        status: row.status,
        sessionSeq: row.session_seq,
      })),
    ).toEqual([
      { eventType: "client.call.agent.start", status: "delivered", sessionSeq: 1 },
      { eventType: "client.call.agent.end", status: "delivered", sessionSeq: 2 },
    ]);
    expect(store.fetchPendingOutbox(10)).toEqual([]);
    store.close();
  });
});

function runtimeCoreStub(agent: AgentConfig): RuntimeExecutionConfigResolver {
  const provider: ModelProviderConfig = {
    name: "my",
    key: "my_deepseek",
    provider_type: "deepseek",
    api_key: "sk-test",
    models: ["deepseek-chat"],
    model_map: {
      chat: "deepseek-chat",
    },
  };
  const readiness = {
    kind: "runtime_core",
    status: "ready",
    configuration_ready: true,
    execution_runtime_migrated: true,
    can_execute: true,
    agent: {
      agent_name: agent.agent_name,
      display_name: agent.display_name,
      enabled: true,
      default_entry: false,
      source: "agent_config",
    },
    llm: {
      provider: "my",
      provider_type: "deepseek",
      model_name: "deepseek-chat",
      source: "agent_config.default",
    },
    provider: {
      configured: true,
      provider_key: "my_deepseek",
      provider_name: "my",
      provider_type: "deepseek",
      model_available: true,
      api_key_configured: true,
    },
    requirements: [],
    boundary: "test runtime",
  };
  return {
    getReadiness() {
      return readiness;
    },
    resolveExecutionConfig() {
      return {
        readiness,
        agent,
        provider,
        modelName: "deepseek-chat",
      };
    },
  } as RuntimeExecutionConfigResolver;
}

function minimalAgent(agentName: string): AgentConfig {
  return {
    agent_name: agentName,
    display_name: agentName,
    description: null,
    enabled: true,
    default_entry: false,
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
      auto_inject: false,
      allowed_scopes: [],
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
    custom_params: {
      behavior: {
        system_prompt: `${agentName} system prompt`,
      },
    },
  };
}
