import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import {
  AgentRuntimeContextBuilder,
  RecentMessagesContextSource,
} from "../../src/services/agent/agent-runtime-context-builder.js";
import type { AgentRuntimeCore, AgentRuntimeRequest } from "../../src/services/agent/agent-runtime-core.js";
import { AgentDelegationService } from "../../src/services/agent/agent-delegation-service.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import type { RuntimeExecutionConfigResolver } from "../../src/services/runtime/runtime-core-service.js";

describe("AgentDelegationService", () => {
  it("lists child agents and resumes an existing child thread with send_message", async () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const clientEvents = new DurableClientEventPublisher(store, dispatcher);
    const workerAgent = minimalAgent("worker_agent");
    const runtimeRequests: AgentRuntimeRequest[] = [];
    const service = new AgentDelegationService(
      store,
      runtimeCoreStub(workerAgent),
      {
        async runText(request: AgentRuntimeRequest) {
          runtimeRequests.push(request);
          return {
            content: "resumed answer",
            finish_reason: "stop",
            metadata: {
              agent_name: request.agent.agent_name,
              provider_key: request.provider.key ?? null,
              provider_type: request.provider.provider_type,
              model_name: request.modelName,
            },
          };
        },
      } as unknown as AgentRuntimeCore,
      new AgentRuntimeContextBuilder([new RecentMessagesContextSource(store)]),
      clientEvents,
    );

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

    expect(runtimeRequests).toHaveLength(1);
    expect(runtimeRequests[0]?.conversation.map((message) => message.content)).toEqual([
      "previous answer",
      "继续分析",
    ]);
    expect(runtimeRequests[0]?.toolContext).toMatchObject({
      sessionId: "session-1",
      runId: expect.any(String),
      currentAgentName: "worker_agent",
      workspaceRoot: "E:/workspace",
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
