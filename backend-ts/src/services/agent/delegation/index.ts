import { randomUUID } from "node:crypto";

import type { AgentRunEngine } from "../execution/run-engine.js";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ChildAgentInfo, IChildAgentStore, IMessageStore, IRunStore, ISessionStore } from "../../../contracts/conversation-store/index.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { RuntimeExecutionConfigResolver } from "../execution/runtime-core-service.js";
import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import type {
  DelegationPort,
  AgentDelegationCall,
  SendMessageCall,
  ListChildAgentsCall,
} from "./port.js";
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

  constructor(
    private readonly conversationStore: IMessageStore & IChildAgentStore & IRunStore & ISessionStore,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly clientEvents: ClientEventPublisher | null = null,
  ) {}

  setRunEngine(provider: () => AgentRunEngine | null): void {
    this.runEngineProvider = provider;
  }

  async callAgent(call: AgentDelegationCall, ctx: ToolExecContext): Promise<ToolExecutionResult> {
    const { agent: parentAgent, teamName, input } = call;
    const toolName = "call_agent";
    const sessionId = normalizeString(ctx.sessionId);
    const targetAgentName = normalizeString(input.agentName);
    const task = normalizeString(input.task);
    const parentCallId = normalizeString(input.callId);
    const parentRunId = normalizeString(ctx.runId);
    if (!sessionId) {
      return errorResult("call_agent 缺少 session_id", toolName);
    }
    if (!targetAgentName) {
      return errorResult("call_agent 缺少 agent_name", toolName);
    }
    if (!task) {
      return errorResult("call_agent 缺少 task", toolName);
    }
    if (!parentRunId || !parentCallId) {
      return errorResult("call_agent 缺少 run_id 或 call_id", toolName);
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

    const existingChild = this.conversationStore.findChildAgentByCreator({
      sessionId,
      createdByRunId: parentRunId,
      createdByCallId: parentCallId,
    });
    const matchingChild = existingChild?.agent_name === targetAgentName ? existingChild : null;
    const existingRun = matchingChild?.last_run_id
      ? this.conversationStore.getRun(sessionId, matchingChild.last_run_id)
      : null;
    const resumedRun = existingRun?.status === "suspended" ? existingRun : null;
    const childAgentId = resumedRun && matchingChild ? matchingChild.child_agent_id : `child_${randomUUID()}`;
    const threadKey = resumedRun && matchingChild ? matchingChild.thread_key : `child:${childAgentId}`;
    const resumedAgentCallId = resumedRun && matchingChild
      ? normalizeString(matchingChild.metadata.agent_call_id) ?? resumedRun.parent_call_id
      : null;
    const agentCallId = resumedAgentCallId ?? `call_${randomUUID()}`;
    const child = resumedRun && matchingChild
      ? matchingChild
      : this.conversationStore.createChildAgent({
          childAgentId,
          sessionId,
          agentName: targetAgentName,
          threadKey,
          createdSeq: this.conversationStore.getRecentMessages(sessionId, 1, "root").at(-1)?.seq ?? null,
          createdByRunId: parentRunId,
          createdByCallId: parentCallId,
          parentRunId,
          parentCallId,
          metadata: {
            ...buildChildMetadata(ctx, threadKey, "call_agent"),
            agent_call_id: agentCallId,
          },
        });

    const childDisplayName = this.resolveChildDisplayName(targetAgentName, normalizeString(teamName));
    if (!resumedRun) {
      publishAgentCallStart(this.clientEvents, {
        sessionId,
        parentRunId,
        parentAgentName: parentAgent.agent_name,
        parentCallId,
        rootParentCallId: normalizeString(ctx.parentCallId),
        agentCallId,
        agentName: targetAgentName,
        childDisplayName,
        description: task,
        childAgentId,
        mode: "create",
      });
    }

    const result = await this.executeChildRun({
      sessionId,
      agentName: targetAgentName,
      task: buildDelegatedTask(task, input.contextHint),
      requestId: normalizeString(ctx.requestId),
      parentRunId,
      parentCallId: agentCallId,
      rootParentCallId: normalizeString(ctx.parentCallId),
      round: ctx.round ?? null,
      childAgent: child,
      resumeRunId: resumedRun?.run_id ?? null,
      entrypoint: "call_agent",
      executionKind: ctx.executionKind ?? "call_agent",
      rootTask: ctx.rootTask ?? task,
      source: "agent_call",
      signal: ctx.signal,
      teamName: normalizeString(teamName),
      workspaceRoot: getChildWorkspaceRoot(child, ctx),
    });
    publishAgentCallEnd(this.clientEvents, {
      sessionId,
      parentRunId,
      parentAgentName: parentAgent.agent_name,
      parentCallId,
      rootParentCallId: normalizeString(ctx.parentCallId),
      agentCallId,
      agentName: targetAgentName,
      childDisplayName,
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

  async sendMessage(call: SendMessageCall, ctx: ToolExecContext): Promise<ToolExecutionResult> {
    const { agent: parentAgent, teamName, input } = call;
    const toolName = "send_message";
    const sessionId = normalizeString(ctx.sessionId);
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

    const childDisplayName = this.resolveChildDisplayName(child.agent_name, normalizeString(teamName));
    publishAgentCallStart(this.clientEvents, {
      sessionId,
      parentRunId: normalizeString(ctx.runId),
      parentAgentName: parentAgent.agent_name,
      parentCallId,
      rootParentCallId: normalizeString(ctx.parentCallId),
      agentCallId,
      agentName: child.agent_name,
      childDisplayName,
      description: message,
      childAgentId,
      mode: "resume",
    });

    const result = await this.executeChildRun({
      sessionId,
      agentName: child.agent_name,
      task: message,
      requestId: normalizeString(ctx.requestId),
      parentRunId: normalizeString(ctx.runId),
      parentCallId: agentCallId,
      rootParentCallId: normalizeString(ctx.parentCallId),
      round: ctx.round ?? null,
      childAgent: child,
      resumeRunId: null,
      entrypoint: "send_message",
      executionKind: ctx.executionKind ?? "send_message",
      rootTask: ctx.rootTask ?? message,
      source: "agent_call",
      signal: ctx.signal,
      teamName: normalizeString(teamName),
      workspaceRoot: getChildWorkspaceRoot(child, ctx),
    });
    publishAgentCallEnd(this.clientEvents, {
      sessionId,
      parentRunId: normalizeString(ctx.runId),
      parentAgentName: parentAgent.agent_name,
      parentCallId,
      rootParentCallId: normalizeString(ctx.parentCallId),
      agentCallId,
      agentName: child.agent_name,
      childDisplayName,
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

  listChildAgents(call: ListChildAgentsCall, ctx: ToolExecContext): ToolExecutionResult {
    const { input } = call;
    const sessionId = normalizeString(ctx.sessionId);
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

  /** 提前解析 child agent 展示名（agent_started/ended payload.display_name）；resolve 失败回退 agent_name。 */
  private resolveChildDisplayName(agentName: string, teamName: string | null): string {
    const resolved = this.runtimeCore.resolveExecutionConfig({ agentName, teamName });
    return resolved.agent?.display_name || agentName;
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
    resumeRunId: string | null;
    entrypoint: "call_agent" | "send_message";
    executionKind: string;
    rootTask: string;
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

    const childRunId = input.resumeRunId ?? randomUUID();
    const targetAgent = applyWorkspaceOverride(resolved.agent, input.workspaceRoot);
    if (input.resumeRunId) {
      this.conversationStore.updateRunStatus(childRunId, input.sessionId, "running", null);
    } else {
      // 首次调用才写入任务消息；恢复时直接复用 child thread 中的悬空 tool_use。
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
    }

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

    // 在执行前记录 last_run_id，确保子 run 挂起抛异常时仍可由原 call_agent 找回。
    this.conversationStore.updateChildAgentLastRun({
      sessionId: input.sessionId,
      childAgentId: input.childAgent.child_agent_id,
      lastRunId: childRunId,
    });

    const outcome = await runEngine.executeRun({
      sessionId: input.sessionId,
      runId: childRunId,
      taskId: randomUUID(),
      rootCallId: input.parentCallId ?? `call_${childRunId}`,
      parentCallId: input.rootParentCallId,
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
      executionKind: input.executionKind,
      rootTask: input.rootTask,
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

}
