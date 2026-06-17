import { randomUUID } from "node:crypto";

import type { AgentRuntimeContextBuilder } from "./agent-runtime-context-builder.js";
import type { AgentRuntimeCore, AgentRuntimeEvent, AgentRuntimeRequest } from "./agent-runtime-core.js";
import { buildAgentPromptContext, type AgentPromptConfigResolver } from "./agent-prompt-builder.js";
import type { IMessageStore, IChildAgentStore, IRunStore, ISessionStore, ChildAgentInfo } from "../stores/conversation-store/index.js";
import type { ClientEventPublisher } from "../runtime/event-outbox/client-event-publisher.js";
import type { RuntimeExecutionConfigResolver } from "../runtime/runtime-core-service.js";
import type { RuntimeToolExecutionContext, RuntimeToolExecutor, ToolExecutionResult } from "../runtime/runtime-tool-types.js";
import { publishAgentCallEnd, publishAgentCallStart } from "./agent-delegation-service/events.js";
import {
  applyWorkspaceOverride,
  buildChildMetadata,
  buildDelegatedTask,
  buildRuntimeToolContext,
  clampInteger,
  getChildWorkspaceRoot,
  normalizeString,
} from "./agent-delegation-service/helpers.js";
import {
  errorResult,
  successResult,
  summarizeReadinessFailure,
  toToolResult,
  type DelegationRunResult,
} from "./agent-delegation-service/results.js";

export interface AgentDelegationInput {
  agentName: string;
  task: string;
  contextHint?: string | null | undefined;
  callId?: string | null | undefined;
}

export interface SendMessageInput {
  childAgentId: string;
  message: string;
  callId?: string | null | undefined;
}

export interface ListChildAgentsInput {
  agentName?: string | null | undefined;
  limit?: number | null | undefined;
}

export class AgentDelegationService {
  private runtimeToolsProvider: (() => RuntimeToolExecutor | null) | null = null;

  constructor(
    private readonly conversationStore: IMessageStore & IChildAgentStore & IRunStore & ISessionStore,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly agentRuntimeCore: AgentRuntimeCore,
    private readonly contextBuilder: AgentRuntimeContextBuilder,
    private readonly clientEvents: ClientEventPublisher | null = null,
    private readonly promptConfigResolver: AgentPromptConfigResolver | null = null,
  ) {}

  setRuntimeToolsProvider(provider: () => RuntimeToolExecutor | null): void {
    this.runtimeToolsProvider = provider;
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

    try {
      const context = this.contextBuilder.buildContext({
        sessionId: input.sessionId,
        agent: targetAgent,
        threadKey: input.childAgent.thread_key,
        historyLimit: 50,
        microcompact: true,
      });
      const runtimeTools = this.runtimeToolsProvider?.() ?? undefined;
      const promptContext = buildAgentPromptContext({
        agent: targetAgent,
        toolExecutor: runtimeTools,
        configResolver: this.promptConfigResolver,
        teamName: input.teamName,
      });
      const runtimeRequest: AgentRuntimeRequest = {
        agent: targetAgent,
        provider: resolved.provider,
        modelName: resolved.modelName,
        conversation: context.conversation,
        toolExecutor: runtimeTools,
        promptContext,
        onModelRequestSuccess: () =>
          this.refreshStablePrefixCache(
            input.sessionId,
            input.childAgent.thread_key,
            context.metadata.stable_prefix_fingerprint,
          ),
        toolContext: buildRuntimeToolContext(targetAgent, {
          sessionId: input.sessionId,
          runId: childRunId,
          taskId: null,
          requestId: input.requestId,
          sessionMetadata: this.conversationStore.getSession(input.sessionId)?.metadata ?? {},
          childAgent: input.childAgent,
          workspaceRoot: input.workspaceRoot,
          parentCallId: input.parentCallId,
          signal: input.signal,
        }),
        onEvent: (_event: AgentRuntimeEvent) => undefined,
      };
      if (input.signal !== undefined) {
        runtimeRequest.signal = input.signal;
      }
      const response = await this.agentRuntimeCore.runText(runtimeRequest);
      const assistantMessage = this.conversationStore.addMessage({
        sessionId: input.sessionId,
        role: "assistant",
        content: response.content,
        metadata: {
          agent: targetAgent.agent_name,
          run_id: childRunId,
          request_id: input.requestId,
          msg_type: "assistant_final",
          execution_kind: input.entrypoint,
          source: input.source,
          child_agent_id: input.childAgent.child_agent_id,
        },
        threadKey: input.childAgent.thread_key,
        childAgentId: input.childAgent.child_agent_id,
      });
      this.conversationStore.updateRunStatus(childRunId, input.sessionId, "completed", assistantMessage.id);
      this.conversationStore.updateChildAgentLastRun({
        sessionId: input.sessionId,
        childAgentId: input.childAgent.child_agent_id,
        lastRunId: childRunId,
      });
      return {
        success: true,
        content: response.content,
        summary: response.content.slice(0, 500),
        outputType: "text",
        metadata: {
          run_id: childRunId,
          agent_name: targetAgent.agent_name,
          child_agent_id: input.childAgent.child_agent_id,
          thread_key: input.childAgent.thread_key,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.conversationStore.updateRunStatus(childRunId, input.sessionId, input.signal?.aborted ? "interrupted" : "failed");
      return {
        success: false,
        content: message,
        summary: message,
        outputType: "error",
        metadata: {
          run_id: childRunId,
          agent_name: targetAgent.agent_name,
          child_agent_id: input.childAgent.child_agent_id,
          thread_key: input.childAgent.thread_key,
        },
      };
    }
  }

  private refreshStablePrefixCache(
    sessionId: string,
    threadKey: string,
    stablePrefixFingerprint: string | null | undefined,
  ): void {
    try {
      this.conversationStore.updateSessionMetadata(sessionId, {
        _pipeline_caches: {
          [threadKey]: {
            fp: stablePrefixFingerprint?.trim() || "no_stable_prefix",
            t: Date.now() / 1000,
          },
        },
      });
    } catch {
      // Cache refresh is opportunistic; the model response should still complete.
    }
  }

}
