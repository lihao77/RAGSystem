import { describe, expect, it } from "vitest";
import { toolContext } from "../helpers/tool-context.js";

import type { AgentConfig } from "../../src/contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/integrations/model-adapter.js";
import { AgentDelegationService } from "../../src/services/agent/delegation/index.js";
import type { AgentRunEngine } from "../../src/services/agent/execution/run-engine.js";
import type { RuntimeExecutionConfigResolver } from "../../src/services/agent/execution/runtime-core-service.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

describe("AgentDelegationService", () => {
  it("keeps grandchild durable and wire call lineage distinct", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "lineage-session", null);
    const workerAgent = minimalAgent("worker_agent");
    const parentAgent = minimalAgent("parent_agent");
    parentAgent.delegation.enabled_agents = ["worker_agent"];
    const service = new AgentDelegationService(store, runtimeCoreStub(workerAgent));
    const seenInputs: Array<Record<string, unknown>> = [];
    service.setRunEngine(() => ({
      async executeRun(input: Record<string, unknown>) {
        seenInputs.push(input);
        return { content: "done", success: true };
      },
    } as unknown as AgentRunEngine));

    await service.callAgent({
      agent: parentAgent,
      teamName: null,
      input: { agentName: "worker_agent", task: "grandchild", callId: "tool-grandchild" },
    }, toolContext({
      sessionId: "lineage-session",
      runId: "child-run",
      rootRunId: "root-run",
      rootCallId: "root-call-0",
      currentCallId: "agent-call-1",
      parentCallId: "root-call-0",
      toolCallId: "tool-grandchild",
    }));

    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).toMatchObject({
      parentRunId: "child-run",
      parentCallId: "tool-grandchild",
      lineageParentCallId: "agent-call-1",
      rootRunId: "root-run",
      interactionRootCallId: "root-call-0",
    });
    expect(seenInputs[0]?.rootCallId).toMatch(/^call_/);
    store.close();
  });

  it("call_agent 重执行时续原 suspended child run", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const clientEvents = new DurableClientEventPublisher(store, dispatcher);
    const workerAgent = minimalAgent("worker_agent");
    const parentAgent = minimalAgent("orchestrator_agent");
    parentAgent.delegation.enabled_agents = ["worker_agent"];
    const service = new AgentDelegationService(store, runtimeCoreStub(workerAgent), clientEvents);
    store.createSession(LOCAL_TENANT_ID, "resume-session", null, { workspace_root: "E:/workspace" });
    store.createRun({
      sessionId: "resume-session",
      runId: "parent-run",
      status: "suspended",
      agentName: "orchestrator_agent",
    });
    store.createChildAgent({
      sessionId: "resume-session",
      childAgentId: "child-resume",
      agentName: "worker_agent",
      threadKey: "child:child-resume",
      createdByRunId: "parent-run",
      createdByCallId: "tool-call-resume",
      parentRunId: "parent-run",
      parentCallId: "tool-call-resume",
      lastRunId: "child-run",
      metadata: { workspace_root: "E:/workspace", agent_call_id: "agent-call-original" },
    });
    store.createRun({
      sessionId: "resume-session",
      runId: "child-run",
      status: "suspended",
      agentName: "worker_agent",
      threadKey: "child:child-resume",
      parentRunId: "parent-run",
      parentCallId: "agent-call-original",
      childAgentId: "child-resume",
    });
    store.addMessage({
      sessionId: "resume-session",
      role: "assistant",
      content: "等待审批",
      threadKey: "child:child-resume",
      childAgentId: "child-resume",
      toolCalls: [{ id: "approval-tool", type: "function", function: { name: "execute_bash", arguments: "{}" } }],
    });

    const seenInputs: Array<Record<string, unknown>> = [];
    const mockEngine = {
      async executeRun(input: Record<string, unknown>) {
        seenInputs.push(input);
        expect(store.getRun("resume-session", "child-run")?.status).toBe("running");
        return { content: "恢复完成", success: true };
      },
    } as unknown as AgentRunEngine;
    service.setRunEngine(() => mockEngine);

    const result = await service.callAgent({
      agent: parentAgent,
      teamName: null,
      input: {
        agentName: "worker_agent",
        task: "继续原任务",
        callId: "tool-call-resume",
      },
    }, toolContext({
      sessionId: "resume-session",
      runId: "parent-run",
      rootRunId: "parent-run",
      rootCallId: "root-call",
      currentCallId: "root-call",
      toolCallId: "tool-call-resume",
      executionKind: "daemon.cron",
      currentAgentName: "orchestrator_agent",
      workspaceRoot: "E:/workspace",
    }));

    expect(result).toMatchObject({
      success: true,
      content: "恢复完成",
      metadata: {
        run_id: "child-run",
        child_agent_id: "child-resume",
        agent_call_id: "agent-call-original",
      },
    });
    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).toMatchObject({
      runId: "child-run",
      threadKey: "child:child-resume",
      parentRunId: "parent-run",
      parentCallId: "tool-call-resume",
      lineageParentCallId: "root-call",
      rootRunId: "parent-run",
      rootCallId: "agent-call-original",
      interactionRootCallId: "root-call",
      executionKind: "daemon.cron",
    });
    expect(store.listChildAgents({ sessionId: "resume-session" }).total).toBe(1);
    expect(store.listMessages("resume-session", 20, 0, "child:child-resume").items).toHaveLength(1);
    expect(realtimeEvents.getHistory("resume-session").filter((event) => event.type === "agent_started")).toEqual([]);
    store.close();
  });

  it("lists child agents and resumes an existing child thread with send_message", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
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

    store.createSession(LOCAL_TENANT_ID, "session-1", null, {
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
      service.listChildAgents(
        {
          agent: minimalAgent("orchestrator_agent"),
          teamName: null,
          input: { agentName: "worker_agent" },
        },
        toolContext({ sessionId: "session-1" }),
      ),
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
        agent: minimalAgent("orchestrator_agent"),
        teamName: "default",
        input: {
          childAgentId: "child-existing",
          message: "继续分析",
          callId: "resume-call",
        },
      },
      toolContext({
        sessionId: "session-1",
        runId: "parent-run",
        requestId: "request-1",
        currentAgentName: "orchestrator_agent",
        workspaceRoot: "E:/workspace",
      }),
    );

    expect(result).toMatchObject({
      success: true,
      toolName: "send_message",
      content: "resumed answer",
      metadata: {
        agent_name: "worker_agent",
        child_agent_id: "child-existing",
        agent_call_id: expect.stringMatching(/^call_/),
        parent_call_id: "resume-call",
        mode: "resume",
      },
    });
    expect(result.llmHint).toBeNull();

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
    // delegation 的 child agent_started/ended 由 publishAgentCallStart/End 独占发（单发）；
    // agent_id=子 agent、call_id=子 agent call_id；本场景 context 未带 root parent call_id，
    // 故 lineage.parent_call_id 不出现。event_seq 已统一为 seq。
    const callEvents = realtimeEvents
      .getHistory("session-1")
      .filter((event) => event.type === "agent_started" || event.type === "agent_ended");
    expect(callEvents.map((event) => event.seq)).toEqual([1, 2]);
    expect(callEvents).toEqual([
      expect.objectContaining({
        type: "agent_started",
        agent_id: "worker_agent",
        call_id: result.metadata.agent_call_id,
        payload: {
          phase: "start",
          task: "继续分析",
          display_name: "worker_agent",
          invocation_call_id: "resume-call",
        },
      }),
      expect.objectContaining({
        type: "agent_ended",
        agent_id: "worker_agent",
        call_id: result.metadata.agent_call_id,
        payload: {
          phase: "end",
          result: "resumed answer",
          success: true,
          display_name: "worker_agent",
          invocation_call_id: "resume-call",
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
      { eventType: "client.agent_started", status: "delivered", sessionSeq: 1 },
      { eventType: "client.agent_ended", status: "delivered", sessionSeq: 2 },
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
    skills: { enabled_skills: [] },
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
