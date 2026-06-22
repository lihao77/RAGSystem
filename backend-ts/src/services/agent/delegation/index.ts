import { randomUUID } from "node:crypto";

import type { AgentRunEngine } from "../execution/run-engine.js";
import type { AgentExecutionEventPublisher } from "../execution/event-publisher.js";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ChildAgentInfo, IChildAgentStore, IMessageStore, IRunStore, ISessionStore } from "../../../contracts/conversation-store/index.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { RuntimeExecutionConfigResolver } from "../execution/runtime-core-service.js";
import type { RuntimeToolExecutionContext, ToolExecutionResult } from "../../runtime/runtime-tool-types.js";
import type { DelegationPort, AgentDelegationInput, SendMessageInput, ListChildAgentsInput } from "./port.js";
import { publishAgentCallEnd, publishAgentCallStart } from "./events.js";
import {
  applyWorkspaceOverride,
  buildChildMetadata,
  buildDelegatedTask,
  clampInteger,
  getChildWorkspaceRoot,
  normalizeString,
} from "./helpers.js";
import {
  errorResult,
  successResult,
  summarizeReadinessFailure,
  toToolResult,
  type DelegationRunResult,
} from "./results.js";

export class AgentDelegationService implements DelegationPort {
  private runEngineProvider: (() => AgentRunEngine | null) | null = null;
  private eventPublisherProvider: (() => AgentExecutionEventPublisher | null) | null = null;

  constructor(
    private readonly conversationStore: IMessageStore & IChildAgentStore & IRunStore & ISessionStore,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly clientEvents: ClientEventPublisher | null = null,
  ) {}

  setRunEngine(provider: () => AgentRunEngine | null): void {
    this.runEngineProvider = provider;
  }

  setEventPublisher(provider: () => AgentExecutionEventPublisher | null): void {
    this.eventPublisherProvider = provider;
  }

  async callAgent(input: AgentDelegationInput, context: RuntimeToolExecutionContext): Promise<ToolExecutionResult> {
    const toolName = "call_agent";
    const parentAgent = context.agent;
    const sessionId = normalizeString(context.sessionId);
    const targetAgentName = normalizeString(input.agentName);
    const task = normalizeString(input.task);
    const parentCallId = normalizeString(input.callId);
    const agentCallId = `call_${randomUUID()}`;
    if (!sessionId) {
      return errorResult("call_agent 缺少 session_id", toolName);
    }
    if (!parentAgent) {
      return errorResult("当前上下文缺少父 Agent 配置", toolName);
    }
    if (!targetAgentName) {
      return errorResult("call_agent 缺少 agent_name", toolName);
    }
    if (!task) {
      return errorResult("call_agent 缺少 task", toolName);
    }
    const allowedAgents = parentAgent.delegation.enabled_agents ?? [];
    if (!allowedAgents.length) {
      return errorResult("当前 Agent 未启用子 Agent 委派能力", toolName);
    }
    if (!allowedAgents.includes(targetAgentName)) {
      return errorResult(`目标 Agent '${targetAgentName}' 不在当前 allowlist 中`, toolName);
    }
    if (targetAgentName === parentAgent.agent_name) {
      return errorResult("不允许委派给自身", toolName);
    }

    const childAgentId = `child_${randomUUID()}`;
    const threadKey = `child:${childAgentId}`;
    const latestRootMessages = this.conversationStore.getRecentMessages(sessionId, 1, "root");
    const createdSeq = latestRootMessages.at(-1)?.seq ?? null;
    const child = this.conversationStore.createChildAgent({
      childAgentId,
      sessionId,
      agentName: targetAgentName,
      threadKey,
      createdSeq,
      createdByRunId: normalizeString(context.runId),
      createdByCallId: agentCallId,
      parentRunId: normalizeString(context.runId),
      parentCallId,
      metadata: buildChildMetadata(context, threadKey, "call_agent"),
    });

    publishAgentCallStart(this.clientEvents, {
      sessionId,
      parentRunId: normalizeString(context.runId),
      parentAgentName: parentAgent.agent_name,
      parentCallId,
      agentCallId,
      agentName: targetAgentName,
      description: task,
      childAgentId,
      mode: "create",
    });

    const result = await this.executeChildRun({
      sessionId,
      agentName: targetAgentName,
      task: buildDelegatedTask(task, input.contextHint),
      requestId: normalizeString(context.requestId),
      parentRunId: normalizeString(context.runId),
      parentCallId: agentCallId,
      rootParentCallId: normalizeString(context.parentCallId),
      round: context.round ?? null,
      childAgent: child,
      entrypoint: "call_agent",
      source: "agent_call",
      signal: context.signal,
      teamName: normalizeString(context.teamName),
      workspaceRoot: getChildWorkspaceRoot(child, context),
    });
    publishAgentCallEnd(this.clientEvents, {
      sessionId,
      parentRunId: normalizeString(context.runId),
      parentAgentName: parentAgent.agent_name,
      parentCallId,
      agentCallId,
      agentName: targetAgentName,
      result: result.content || result.summary,
      success: result.success,
      childAgentId,
      mode: "create",
    });
    return toToolResult(toolName, result, {
      agent_name: targetAgentName,
      agent_call_id: agentCallId,
      parent_call_id: parentCallId,
      child_agent_id: childAgentId,
      mode: "create",
    });
  }

  async sendMessage(input: SendMessageInput, context: RuntimeToolExecutionContext): Promise<ToolExecutionResult> {
    const toolName = "send_message";
    const sessionId = normalizeString(context.sessionId);
    const childAgentId = normalizeString(input.childAgentId);
    const message = normalizeString(input.message);
    const parentCallId = normalizeString(input.callId);
    const agentCallId = `call_${randomUUID()}`;
    if (!sessionId) {
      return errorResult("send_message 缺少 session_id", toolName);
    }
    if (!childAgentId) {
      return errorResult("send_message 缺少 child_agent_id", toolName);
    }
    if (!message) {
      return errorResult("send_message 缺少 message", toolName);
    }
    const child = this.conversationStore.getChildAgent(sessionId, childAgentId);
    if (!child) {
      return errorResult(`子 Agent '${childAgentId}' 不存在`, toolName);
    }
    if (child.status !== "active") {
      return errorResult(`子 Agent '${childAgentId}' 当前不可用`, toolName);
    }

    publishAgentCallStart(this.clientEvents, {
      sessionId,
      parentRunId: normalizeString(context.runId),
      parentAgentName: context.agent?.agent_name ?? normalizeString(context.currentAgentName) ?? "send_message",
      parentCallId,
      agentCallId,
      agentName: child.agent_name,
      description: message,
      childAgentId,
      mode: "resume",
    });

    const result = await this.executeChildRun({
      sessionId,
      agentName: child.agent_name,
      task: message,
      requestId: normalizeString(context.requestId),
      parentRunId: normalizeString(context.runId),
      parentCallId: agentCallId,
      rootParentCallId: normalizeString(context.parentCallId),
      round: context.round ?? null,
      childAgent: child,
      entrypoint: "send_message",
      source: "agent_call",
      signal: context.signal,
      teamName: normalizeString(context.teamName),
      workspaceRoot: getChildWorkspaceRoot(child, context),
    });
    publishAgentCallEnd(this.clientEvents, {
      sessionId,
      parentRunId: normalizeString(context.runId),
      parentAgentName: context.agent?.agent_name ?? normalizeString(context.currentAgentName) ?? "send_message",
      parentCallId,
      agentCallId,
      agentName: child.agent_name,
      result: result.content || result.summary,
      success: result.success,
      childAgentId,
      mode: "resume",
    });
    return toToolResult(toolName, result, {
      agent_name: child.agent_name,
      agent_call_id: agentCallId,
      parent_call_id: parentCallId,
      child_agent_id: childAgentId,
      mode: "resume",
    });
  }

  listChildAgents(input: ListChildAgentsInput, context: RuntimeToolExecutionContext): ToolExecutionResult {
    const sessionId = normalizeString(context.sessionId);
    if (!sessionId) {
      return errorResult("list_child_agents 缺少 session_id", "list_child_agents");
    }
    const agentName = normalizeString(input.agentName);
    const limit = clampInteger(input.limit ?? 20, 1, 100);
    const result = this.conversationStore.listChildAgents({
      sessionId,
      agentName,
      limit,
    });
    const items = result.items.map((item) => ({
      child_agent_id: item.child_agent_id,
      agent_name: item.agent_name,
      status: item.status,
      last_run_id: item.last_run_id,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }));
    return successResult(
      {
        items,
        total: result.total,
      },
      {
        summary: agentName ? `找到 ${items.length} 个 ${agentName} child agent` : `找到 ${items.length} 个 child agent`,
        outputType: "json",
        metadata: {
          agent_name: agentName,
          session_id: sessionId,
        },
        toolName: "list_child_agents",
      },
    );
  }

  private async executeChildRun(input: {
    sessionId: string;
    agentName: string;
    task: string;
    requestId: string | null;
    parentRunId: string | null;
    parentCallId: string | null;
    rootParentCallId: string | null;
    round: number | null;
    childAgent: ChildAgentInfo;
    entrypoint: "call_agent" | "send_message";
    source: "agent_call";
    signal?: AbortSignal | undefined;
    teamName: string | null;
    workspaceRoot: string | null;
  }): Promise<DelegationRunResult> {
    const resolved = this.runtimeCore.resolveExecutionConfig({
      agentName: input.agentName,
      teamName: input.teamName,
    });
    if (!resolved.readiness.configuration_ready || !resolved.agent || !resolved.provider || !resolved.modelName) {
      return {
        success: false,
        content: summarizeReadinessFailure(resolved.readiness.requirements),
        summary: summarizeReadinessFailure(resolved.readiness.requirements),
        outputType: "error",
        metadata: {
          agent_name: input.agentName,
          child_agent_id: input.childAgent.child_agent_id,
        },
      };
    }

    const childRunId = randomUUID();
    const targetAgent = applyWorkspaceOverride(resolved.agent, input.workspaceRoot);
    this.conversationStore.createRun({
      runId: childRunId,
      sessionId: input.sessionId,
      entrypoint: input.entrypoint,
      status: "running",
      taskSummary: input.task.slice(0, 200),
      agentName: targetAgent.agent_name,
      threadKey: input.childAgent.thread_key,
      parentRunId: input.parentRunId,
      parentCallId: input.parentCallId,
      childAgentId: input.childAgent.child_agent_id,
    });
    this.conversationStore.addMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.task,
      metadata: {
        agent: targetAgent.agent_name,
        run_id: childRunId,
        request_id: input.requestId,
        execution_kind: input.entrypoint,
        source: input.source,
        child_agent_id: input.childAgent.child_agent_id,
      },
      threadKey: input.childAgent.thread_key,
      childAgentId: input.childAgent.child_agent_id,
    });

    // 发 kind:subtask execution.step（前端 projector 据此创建子 agent 容器节点，
    // 子 run 的工具 step 靠 parent_call_id=agentCallId 挂到该容器下）。
    this.publishSubtaskStep("start", {
      sessionId: input.sessionId,
      runId: input.parentRunId,
      parentCallId: input.parentCallId,
      rootParentCallId: input.rootParentCallId,
      agent: targetAgent,
      task: input.task,
      childAgentId: input.childAgent.child_agent_id,
      round: input.round,
    });

    const runEngine = this.runEngineProvider?.();
    if (!runEngine) {
      const message = "RunEngine 未注入，无法执行子 Agent";
      return {
        success: false,
        content: message,
        summary: message,
        outputType: "error",
        metadata: {
          agent_name: targetAgent.agent_name,
          child_agent_id: input.childAgent.child_agent_id,
        },
      };
    }

    // 子 run 复用 root 的 executeRun 执行核心：prepare/kernel/事件/recorder 全部统一，
    // 靠 threadKey=child:xxx + parent_run_id/parent_call_id/child_agent_id 区分归属。
    // observation 落子 thread、step 落子 run_id，续聊 prepare 重建完整上下文、工作栏按 parent_call_id 展示。
    const abortController = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) {
        abortController.abort();
      } else {
        input.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      }
    }

    const outcome = await runEngine.executeRun({
      sessionId: input.sessionId,
      runId: childRunId,
      taskId: randomUUID(),
      rootCallId: input.parentCallId ?? `call_${childRunId}`,
      requestId: input.requestId ?? "",
      task: input.task,
      startedAt: new Date(),
      abortController,
      agent: targetAgent,
      provider: resolved.provider,
      modelName: resolved.modelName,
      threadKey: input.childAgent.thread_key,
      parentRunId: input.parentRunId,
      childAgentId: input.childAgent.child_agent_id,
      executionKind: input.entrypoint,
    });

    this.conversationStore.updateChildAgentLastRun({
      sessionId: input.sessionId,
      childAgentId: input.childAgent.child_agent_id,
      lastRunId: childRunId,
    });

    this.publishSubtaskStep("end", {
      sessionId: input.sessionId,
      runId: input.parentRunId,
      parentCallId: input.parentCallId,
      rootParentCallId: input.rootParentCallId,
      agent: targetAgent,
      task: input.task,
      childAgentId: input.childAgent.child_agent_id,
      round: input.round,
      status: outcome.success ? "success" : "error",
      resultPreview: outcome.content.slice(0, 500),
    });

    return {
      success: outcome.success,
      content: outcome.content,
      summary: outcome.content.slice(0, 500),
      outputType: outcome.success ? "text" : "error",
      metadata: {
        run_id: childRunId,
        agent_name: targetAgent.agent_name,
        child_agent_id: input.childAgent.child_agent_id,
        thread_key: input.childAgent.thread_key,
      },
    };
  }

  private publishSubtaskStep(phase: "start" | "end", input: {
    sessionId: string;
    runId: string | null;
    parentCallId: string | null;
    rootParentCallId: string | null;
    agent: AgentConfig;
    task: string;
    childAgentId: string;
    status?: string;
    resultPreview?: string;
    round: number | null;
  }): void {
    const eventPublisher = this.eventPublisherProvider?.();
    if (!eventPublisher || !input.parentCallId || !input.runId) {
      return;
    }
    const payload: Record<string, unknown> = {
      kind: "subtask",
      phase,
      step_id: `${input.parentCallId}:subtask`,
      parent_step_id: null,
      call_id: input.parentCallId,
      parent_call_id: input.rootParentCallId,
      agent_name: input.agent.agent_name,
      agent_display_name: input.agent.display_name || input.agent.agent_name,
      round: input.round ?? null,
      round_index: null,
      order: null,
      child_agent_id: input.childAgentId,
      status: phase === "start" ? "running" : (input.status ?? "success"),
    };
    if (phase === "start") {
      payload.description = input.task.slice(0, 200);
    } else {
      payload.result_preview = input.resultPreview ?? "";
    }
    eventPublisher.addExecutionStepAndPublish(input.sessionId, input.runId, payload, {
      type: "execution.step",
      session_id: input.sessionId,
      run_id: input.runId,
      data: payload,
    });
  }

}
