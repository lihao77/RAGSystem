import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { AgentInvocationPort } from "../../../contracts/execution/agent-invocation.js";
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { ChildAgentInfo, RunInfo } from "../../../contracts/conversation-store/index.js";
import type { SessionParticipant, SessionParticipantListData } from "@ragsystem/api-contracts";
import type { SessionInfo, SessionTeamSnapshot } from "../../../contracts/session/session.js";
import type { AgentDelegationStorePort } from "../../../contracts/runtime/core-runtime-ports.js";
import type { AgentMailboxStorePort } from "../../../contracts/storage/agent-mailbox-repository.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { RuntimeExecutionConfigResolver } from "../execution/runtime-core-service.js";
import type { BackgroundTask, BackgroundTaskService } from "../../runtime/background-task-service.js";
import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { Envelope } from "../../../contracts/events.js";
import type {
  DelegationPort,
  AgentToolInput,
  AgentToolCall,
  ListChildAgentsCall,
  AgentMailboxWakeupHandler,
  ParticipantRunLifecyclePort,
  ParticipantRunRoute,
} from "./port.js";
import { buildAgentCallStart } from "./events.js";
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
import { toSessionIdentity } from "../../../contracts/session/session.js";

interface ChildRunInput {
  tenantId: string;
  sessionId: string;
  agentName: string;
  task: string;
  requestId: string | null;
  parentRunId: string | null;
  rootRunId: string | null;
  rootCallId: string;
  runParentCallId: string | null;
  lineageParentCallId: string | null;
  interactionRootCallId: string;
  round: number | null;
  childAgent: ChildAgentInfo;
  childRunId: string;
  resumeRunId: string | null;
  entrypoint: "agent";
  executionKind: string;
  rootTask: string;
  source: "agent_call";
  signal?: AbortSignal | undefined;
  teamSnapshot: SessionTeamSnapshot;
  workspaceRoot: string | null;
  ownsRunLease?: boolean;
  initialEnvelopes?: readonly Envelope[];
  parentThreadKey: string;
  parentChildAgentId: string | null;
  parentAgentName: string;
  parentRootRunId: string | null;
  parentParentRunId: string | null;
  parentParentCallId: string | null;
  parentLineageParentCallId: string | null;
  timeoutMs?: number | null;
}

interface ChildRunBuildSpec {
  parentAgent: AgentConfig;
  teamSnapshot: SessionTeamSnapshot;
  ctx: ToolExecContext;
  childAgent: ChildAgentInfo;
  agentName: string;
  task: string;
  rootTask: string;
  childRunId: string;
  agentCallId: string;
  runParentCallId: string | null;
  resumeRunId: string | null;
  initialEnvelopes?: readonly Envelope[];
  timeoutMs?: number | null;
}

interface ChildRunExecutionSpec {
  runInput: Omit<ChildRunInput, "signal">;
  childAgentId: string;
  childRunId: string;
  childDisplayName: string;
  description: string;
  mode: "create" | "resume";
  runInBackground: boolean;
}

interface ActiveChildRunRoute {
  runId: string;
  agentCallId: string;
  rootRunId: string | null;
  parentRunId: string | null;
  parentCallId: string | null;
  lineageParentCallId: string | null;
}

interface CollaborationMessageFields {
  message: string;
  kind: AgentToolInput["kind"];
  correlationId: AgentToolInput["correlationId"];
  replyToMessageId: AgentToolInput["replyToMessageId"];
  timeoutMs: AgentToolInput["timeoutMs"];
  runInBackground: AgentToolInput["runInBackground"];
  callId: AgentToolInput["callId"];
}

type AgentCollaborationCommand =
  | (CollaborationMessageFields & { type: "create_child"; agentName: string; contextHint: string | null | undefined })
  | (CollaborationMessageFields & { type: "message_child"; childAgentId: string })
  | (CollaborationMessageFields & { type: "message_parent" })
  | { type: "error"; message: string };

interface CreateChildCall {
  agent: AgentConfig;
  teamName: string | null;
  input: {
    agentName: string;
    task: string;
    contextHint?: string | null | undefined;
    timeoutMs?: number | null | undefined;
    runInBackground?: boolean | null | undefined;
    callId?: string | null | undefined;
  };
}

interface DeliverMessageCall {
  agent: AgentConfig;
  teamName: string | null;
  input: {
    childAgentId?: string | null | undefined;
    toParent?: boolean | null | undefined;
    message: string;
    kind?: AgentToolInput["kind"];
    correlationId?: string | null | undefined;
    replyToMessageId?: string | null | undefined;
    timeoutMs?: number | null | undefined;
    runInBackground?: boolean | null | undefined;
    callId?: string | null | undefined;
  };
}

export interface AgentDelegationLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export class AgentDelegationService implements DelegationPort, ParticipantRunLifecyclePort {
  private invocationService: AgentInvocationPort | null = null;
  private readonly activeChildRuns = new Map<string, ActiveChildRunRoute>();
  private mailboxWakeup: AgentMailboxWakeupHandler | null = null;

  constructor(
    private readonly store: AgentDelegationStorePort,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly clientEvents: ClientEventPublisher | null = null,
    private readonly backgroundTasks: BackgroundTaskService | null = null,
    private readonly dataRoot: string | null = null,
    private readonly mailbox: AgentMailboxStorePort | null = null,
    private readonly logger: AgentDelegationLogger | null = null,
    private readonly tenantId: string | null = null,
  ) {}

  setInvocationService(service: AgentInvocationPort): void {
    this.invocationService = service;
  }

  setMailboxWakeup(handler: AgentMailboxWakeupHandler | null): void {
    this.mailboxWakeup = handler;
  }

  async registerParticipantRun(route: ParticipantRunRoute): Promise<void> {
    const child = await this.store.getChildAgent(route.sessionId, route.childAgentId);
    if (!child) throw new Error(`child Agent not found: ${route.childAgentId}`);
    const existing = this.activeChildRuns.get(route.childAgentId);
    if (existing && existing.runId !== route.runId && existing.runId !== route.replacesRunId) {
      throw new Error(`child Agent already has an active Run: ${route.childAgentId}`);
    }
    const activeRoute: ActiveChildRunRoute = {
      runId: route.runId,
      agentCallId: route.agentCallId,
      rootRunId: route.rootRunId,
      parentRunId: route.parentRunId,
      parentCallId: route.parentCallId,
      lineageParentCallId: route.lineageParentCallId,
    };
    this.activeChildRuns.set(route.childAgentId, activeRoute);
    try {
      const updated = child.last_run_id === route.runId || await this.store.updateChildAgentLastRun({
        sessionId: route.sessionId,
        childAgentId: route.childAgentId,
        lastRunId: route.runId,
        expectedLastRunId: child.last_run_id,
      });
      if (!updated) throw new Error(`failed to update child Agent latest Run: ${route.childAgentId}`);
    } catch (error) {
      if (this.activeChildRuns.get(route.childAgentId) === activeRoute) {
        this.activeChildRuns.delete(route.childAgentId);
      }
      throw error;
    }
  }

  releaseParticipantRun(input: { childAgentId: string; runId: string }): void {
    if (this.activeChildRuns.get(input.childAgentId)?.runId === input.runId) {
      this.activeChildRuns.delete(input.childAgentId);
    }
  }

  async listSessionParticipants(sessionId: string): Promise<SessionParticipantListData | null> {
    const session = await this.store.getSession(sessionId);
    if (!session) return null;
    const [children, runs] = await Promise.all([
      this.store.listChildAgents({ sessionId, limit: 10_000 }),
      this.store.listRuns(sessionId, 5_000),
    ]);
    const runById = new Map(runs.items.map((run) => [run.run_id, run]));
    const rootRun = runs.items.find((run) => run.child_agent_id === null && run.thread_key === "root") ?? null;
    const items = [
      this.toRootParticipant(session, rootRun),
      ...children.items.map((child) => this.toChildParticipant(
        session.team_snapshot,
        child,
        child.last_run_id ? runById.get(child.last_run_id) ?? null : null,
      )),
    ];
    return { items, total: items.length };
  }

  async getSessionParticipant(sessionId: string, participantId: string): Promise<SessionParticipant | null> {
    const session = await this.store.getSession(sessionId);
    if (!session) return null;
    if (participantId === "root") {
      const runs = await this.store.listRuns(sessionId, 5_000);
      const rootRun = runs.items.find((run) => run.child_agent_id === null && run.thread_key === "root") ?? null;
      return this.toRootParticipant(session, rootRun);
    }
    const child = await this.store.getChildAgent(sessionId, participantId);
    if (!child) return null;
    const lastRun = child.last_run_id ? await this.store.getRun(sessionId, child.last_run_id) : null;
    return this.toChildParticipant(session.team_snapshot, child, lastRun);
  }

  private toRootParticipant(
    session: SessionInfo,
    lastRun: RunInfo | null,
  ): SessionParticipant {
    const configured = this.runtimeCore.resolveExecutionConfig({
      agentName: session.team_snapshot.entry_agent_name,
      teamSnapshot: session.team_snapshot,
    }).agent;
    const agentName = normalizeString(lastRun?.agent_name) ?? configured?.agent_name ?? null;
    return {
      participant_id: "root",
      parent_participant_id: null,
      scope: "root",
      agent_name: agentName,
      display_name: normalizeString(lastRun?.agent_display_name)
        ?? normalizeString(configured?.display_name)
        ?? agentName
        ?? "Main Agent",
      thread_key: "root",
      lifecycle_status: "active",
      last_run_id: lastRun?.run_id ?? null,
      last_run_status: lastRun?.status ?? null,
      created_at: session.created_at,
      updated_at: lastRun?.updated_at ?? session.updated_at,
    };
  }

  private toChildParticipant(
    teamSnapshot: SessionTeamSnapshot,
    child: ChildAgentInfo,
    lastRun: RunInfo | null,
  ): SessionParticipant {
    const configured = this.runtimeCore.resolveExecutionConfig({
      agentName: child.agent_name,
      teamSnapshot,
    }).agent;
    return {
      participant_id: child.child_agent_id,
      parent_participant_id: child.parent_participant_id,
      scope: "child",
      agent_name: child.agent_name,
      display_name: normalizeString(lastRun?.agent_display_name)
        ?? normalizeString(configured?.display_name)
        ?? child.agent_name,
      thread_key: child.thread_key,
      lifecycle_status: child.status,
      last_run_id: child.last_run_id,
      last_run_status: lastRun?.status ?? null,
      created_at: child.created_at,
      updated_at: child.updated_at,
    };
  }

  /** Reconstruct a terminal mailbox result when a leased background child died with its owner. */
  async recoverBackgroundTask(task: BackgroundTask): Promise<void> {
    if (
      task.kind !== "agent"
      || task.result_type !== "agent_delegation_result"
      || !task.session_id
      || !task.run_id
      || !this.mailbox
      || !this.tenantId
    ) return;
    const childRun = await this.store.getRun(task.session_id, task.run_id);
    if (!childRun?.parent_run_id) return;
    const parent = await this.store.getRun(task.session_id, childRun.parent_run_id);
    if (!parent) return;
    const shouldInterrupt = childRun.status === "running"
      || childRun.status === "interrupted"
      || childRun.status === "cancelled"
      || task.status === "cancelled";
    const status = shouldInterrupt
      ? "interrupted"
      : childRun.status === "completed"
        ? "completed"
        : "failed";
    if (childRun.status === "running") {
      await this.store.updateRunStatus(childRun.run_id, task.session_id, "interrupted", null, "background_task_owner_lease_expired");
    }
    const content = status === "completed"
      ? `后台子 Agent ${childRun.agent_name ?? ""} 已完成；运行时在投递终态结果前重启，已恢复为 completed`
      : normalizeString(task.error) ?? `后台子 Agent 在运行时重启后以 ${status} 结束`;
    try {
      const messageId = `${childRun.run_id}:terminal_result`;
      const existing = await this.mailbox.get(task.session_id, messageId);
      const queued = existing ?? await this.mailbox.enqueue({
        messageId,
        tenantId: this.tenantId,
        sessionId: task.session_id,
        sourceRunId: childRun.run_id,
        sourceAgentCallId: childRun.agent_call_id,
        targetRunId: parent.run_id,
        targetAgentCallId: parent.agent_call_id,
        targetThreadKey: parent.thread_key,
        targetChildAgentId: parent.child_agent_id,
        kind: "result",
        correlationId: childRun.parent_call_id ?? childRun.agent_call_id,
        contentParts: [{ type: "text", text: content }],
        metadata: {
          source: "child_terminal_result_recovery",
          child_run_id: childRun.run_id,
          child_agent_call_id: childRun.agent_call_id,
          target_agent_name: parent.agent_name,
          target_root_run_id: parent.lease_root_run_id,
          target_parent_run_id: parent.parent_run_id,
          target_parent_call_id: parent.parent_call_id,
          target_parent_agent_call_id: parent.lineage_parent_call_id,
          target_lineage_parent_call_id: parent.lineage_parent_call_id,
          status,
          success: status === "completed",
          recovered: true,
          visible_to_user: false,
        },
      });
      this.notifyMailboxWakeup({
        sessionId: task.session_id,
        targetRunId: parent.run_id,
        targetAgentCallId: parent.agent_call_id,
        targetThreadKey: parent.thread_key,
        targetChildAgentId: parent.child_agent_id,
        targetAgentName: parent.agent_name ?? null,
        targetRootRunId: parent.lease_root_run_id,
        targetParentRunId: parent.parent_run_id,
        targetParentCallId: parent.parent_call_id,
        targetLineageParentCallId: parent.lineage_parent_call_id,
      });
      this.logger?.error({
        session_id: task.session_id,
        child_run_id: childRun.run_id,
        parent_run_id: parent.run_id,
        mailbox_message_id: queued.message_id,
      }, "recovered terminal result for expired background child");
    } catch (error) {
      this.logger?.error({
        session_id: task.session_id,
        child_run_id: childRun.run_id,
        parent_run_id: parent.run_id,
        error: error instanceof Error ? error.message : String(error),
      }, "failed to recover terminal result for expired background child");
      throw error;
    }
  }

  /**
   * Unified Agent collaboration command.
   *
   * An agent name creates a new logical child invocation. A child id sends a
   * durable follow-up to an existing child. Inside a child invocation, omitting
   * both targets addresses the direct parent.
   */
  async agent(call: AgentToolCall, ctx: ToolExecContext): Promise<ToolExecutionResult> {
    const command = parseAgentCommand(call.input, ctx);
    if (command.type === "error") return errorResult(command.message, "agent");

    const result = command.type === "create_child"
      ? await this.createChild({
          agent: call.agent,
          teamName: call.teamName,
          input: {
            agentName: command.agentName,
            task: command.message,
            contextHint: command.contextHint,
            timeoutMs: command.timeoutMs,
            runInBackground: command.runInBackground,
            callId: command.callId,
          },
        }, ctx)
      : await this.deliverMessage({
          agent: call.agent,
          teamName: call.teamName,
          input: {
            childAgentId: command.type === "message_child" ? command.childAgentId : undefined,
            toParent: command.type === "message_parent",
            message: command.message,
            kind: command.kind,
            correlationId: command.correlationId,
            replyToMessageId: command.replyToMessageId,
            timeoutMs: command.timeoutMs,
            runInBackground: command.runInBackground,
            callId: command.callId,
          },
        }, ctx);
    return { ...result, toolName: "agent" };
  }

  private async createChild(call: CreateChildCall, ctx: ToolExecContext): Promise<ToolExecutionResult> {
    const { agent: parentAgent, teamName, input } = call;
    const toolName = "agent";
    const sessionId = normalizeString(ctx.sessionId);
    const targetAgentName = normalizeString(input.agentName);
    const task = normalizeString(input.task);
    const parentCallId = normalizeString(input.callId);
    const parentRunId = normalizeString(ctx.runId);
    const parentParticipantId = normalizeString(ctx.currentChildAgentId);
    if (!sessionId) {
      return errorResult("agent 缺少 session_id", toolName);
    }
    const session = await this.store.getSession(sessionId);
    if (!session) return errorResult(`会话 '${sessionId}' 不存在`, toolName);
    if (!targetAgentName) {
      return errorResult("agent 创建模式缺少 agent_name", toolName);
    }
    if (!task) {
      return errorResult("agent 创建模式缺少 message", toolName);
    }
    if (!parentRunId || !parentCallId) {
      return errorResult("agent 缺少 run_id 或 call_id", toolName);
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
    if (input.runInBackground && !parentAgent.tasks?.background) {
      return errorResult("当前 Agent 未启用 tasks.background，不能后台委派子 Agent", toolName);
    }
    if (input.runInBackground && (!this.backgroundTasks || !this.dataRoot)) {
      return errorResult("子 Agent 后台委派暂不可用", toolName);
    }

    const existingChild = await this.store.findChildAgentByCreator({
      sessionId,
      createdByRunId: parentRunId,
      createdByCallId: parentCallId,
      parentParticipantId,
    });
    const matchingChild = existingChild?.agent_name === targetAgentName ? existingChild : null;
    const existingRun = matchingChild?.last_run_id
      ? await this.store.getRun(sessionId, matchingChild.last_run_id)
      : null;
    if (matchingChild && (existingRun?.status === "running" || this.activeChildRuns.has(matchingChild.child_agent_id))) {
      return errorResult(
        `该 agent 调用对应的子 Agent '${matchingChild.child_agent_id}' 仍在运行，请查询现有后台任务，勿重复委派`,
        toolName,
      );
    }
    const resumedRun = existingRun?.status === "suspended" ? existingRun : null;
    const childAgentId = resumedRun && matchingChild ? matchingChild.child_agent_id : `child_${randomUUID()}`;
    const threadKey = resumedRun && matchingChild ? matchingChild.thread_key : `child:${childAgentId}`;
    const resumedAgentCallId = resumedRun?.agent_call_id ?? null;
    const agentCallId = resumedAgentCallId ?? `call_${randomUUID()}`;
    const childRunId = resumedRun?.run_id ?? randomUUID();
    const child = resumedRun && matchingChild
      ? matchingChild
      : await this.store.createChildAgent({
          childAgentId,
          sessionId,
          agentName: targetAgentName,
          threadKey,
          parentParticipantId,
          createdSeq: (await this.store.getRecentMessages(sessionId, 1, "root")).at(-1)?.seq ?? null,
          createdByRunId: parentRunId,
          createdByCallId: parentCallId,
          parentRunId,
          parentCallId,
          metadata: buildChildMetadata(ctx, "agent"),
        });

    const childDisplayName = this.resolveChildDisplayName(targetAgentName, session.team_snapshot);
    const initialEnvelopes = !resumedRun ? [buildAgentCallStart({
        sessionId,
        runId: childRunId,
        parentRunId,
        parentAgentName: parentAgent.agent_name,
        parentCallId,
        rootParentCallId: normalizeString(ctx.currentCallId) ?? normalizeString(ctx.parentCallId) ?? normalizeString(ctx.rootCallId),
        agentCallId,
        agentName: targetAgentName,
        childDisplayName,
        description: task,
        childAgentId,
        mode: "create",
      })] : undefined;

    const runInput = this.buildChildRunInput({
      parentAgent,
      teamSnapshot: session.team_snapshot,
      ctx,
      childAgent: child,
      agentName: targetAgentName,
      task: buildDelegatedTask(task, input.contextHint),
      rootTask: ctx.rootTask ?? task,
      childRunId,
      agentCallId,
      runParentCallId: parentCallId,
      resumeRunId: resumedRun?.run_id ?? null,
      ...(initialEnvelopes ? { initialEnvelopes } : {}),
      ...(clampMailboxTimeout(input.timeoutMs) ? { timeoutMs: clampMailboxTimeout(input.timeoutMs) } : {}),
    });
    return this.runChildInvocation({
      runInput,
      childAgentId,
      childRunId,
      childDisplayName,
      description: task,
      mode: resumedRun ? "resume" : "create",
      runInBackground: input.runInBackground === true,
    }, ctx);
  }

  private async deliverMessage(call: DeliverMessageCall, ctx: ToolExecContext): Promise<ToolExecutionResult> {
    const { agent: parentAgent, teamName, input } = call;
    const toolName = "agent";
    const sessionId = normalizeString(ctx.sessionId);
    const childAgentId = normalizeString(input.childAgentId);
    const toParent = input.toParent === true;
    const message = normalizeString(input.message);
    const parentCallId = normalizeString(input.callId);
    const agentCallId = `call_${randomUUID()}`;
    if (!sessionId) {
      return errorResult("agent 缺少 session_id", toolName);
    }
    const session = await this.store.getSession(sessionId);
    if (!session) return errorResult(`会话 '${sessionId}' 不存在`, toolName);
    if (!childAgentId && !toParent) {
      return errorResult("agent 通信模式缺少 child_agent_id", toolName);
    }
    if (!message) {
      return errorResult("agent 通信模式缺少 message", toolName);
    }
    if (toParent) {
      if (input.runInBackground) return errorResult("to_parent 消息不能再次后台委派", toolName);
      return this.deliverMessageToParent(call, ctx, message, parentCallId, toolName);
    }
    if (!childAgentId) return errorResult("agent 通信模式缺少 child_agent_id", toolName);
    const child = await this.store.getChildAgent(sessionId, childAgentId);
    if (!child) {
      return errorResult(`子 Agent '${childAgentId}' 不存在`, toolName);
    }
    if (child.status !== "active") {
      return errorResult(`子 Agent '${childAgentId}' 当前不可用`, toolName);
    }
    const callerParticipantId = normalizeString(ctx.currentChildAgentId);
    if (child.parent_participant_id !== callerParticipantId) {
      return errorResult(`子 Agent '${childAgentId}' 不是当前 Agent 的直接 child`, toolName);
    }
    const allowedAgents = parentAgent.delegation.enabled_agents ?? [];
    if (!allowedAgents.includes(child.agent_name)) {
      return errorResult(`目标 child Agent '${child.agent_name}' 不在当前 allowlist 中`, toolName);
    }
    if (input.runInBackground && !parentAgent.tasks?.background) {
      return errorResult("当前 Agent 未启用 tasks.background，不能后台委派子 Agent", toolName);
    }
    if (input.runInBackground && (!this.backgroundTasks || !this.dataRoot)) {
      return errorResult("子 Agent 后台委派暂不可用", toolName);
    }
    const activeChildRoute = this.activeChildRuns.get(childAgentId) ?? null;
    const lastRun = child.last_run_id ? await this.store.getRun(sessionId, child.last_run_id) : null;
    const runningChildRoute = activeChildRoute ?? (lastRun?.status === "running" ? {
      runId: lastRun.run_id,
      agentCallId: lastRun.agent_call_id,
      rootRunId: lastRun.lease_root_run_id,
      parentRunId: lastRun.parent_run_id,
      parentCallId: lastRun.parent_call_id,
      lineageParentCallId: lastRun.lineage_parent_call_id,
    } : null);
    const kind = input.kind ?? "request";
    if (!runningChildRoute && lastRun?.status === "suspended") {
      return errorResult(
        `子 Agent '${childAgentId}' 当前处于 suspended，不能通过 agent 创建新 run；请先恢复或取消其交互`,
        toolName,
      );
    }
    if (!runningChildRoute && kind === "cancel" && !lastRun) {
      return successResult({
        child_agent_id: childAgentId,
        status: "no_active_run",
      }, {
        summary: `子 Agent ${child.agent_name} 当前没有可取消的运行实例`,
        outputType: "json",
        metadata: { agent_name: child.agent_name, child_agent_id: childAgentId },
        toolName,
      });
    }
    if (!runningChildRoute && kind === "cancel" && lastRun) {
      if (["completed", "failed", "interrupted", "cancelled"].includes(lastRun.status)) {
        return successResult({
          child_agent_id: childAgentId,
          target_run_id: lastRun.run_id,
          status: "already_finished",
          previous_status: lastRun.status,
        }, {
          summary: `子 Agent ${child.agent_name} 已处于终态，无需取消`,
          outputType: "json",
          metadata: { agent_name: child.agent_name, child_agent_id: childAgentId, run_id: lastRun.run_id },
          toolName,
        });
      }
      return errorResult(`子 Agent '${childAgentId}' 当前没有可取消的运行实例`, toolName);
    }
    if (runningChildRoute) {
      if (!this.mailbox) {
        return errorResult("运行中的子 Agent 暂不支持消息投递（mailbox 未注入）", toolName);
      }
      const tenantId = normalizeString(ctx.tenantId);
      if (!tenantId) return errorResult("agent 缺少 tenant_id", toolName);
      const sourceRunId = normalizeString(ctx.runId);
      const sourceAgentCallId = normalizeString(ctx.currentCallId) ?? normalizeString(ctx.rootCallId) ?? parentCallId;
      const targetAgentCallId = normalizeString(runningChildRoute.agentCallId);
      const timeoutMs = clampMailboxTimeout(input.timeoutMs);
      const queued = await this.mailbox.enqueue({
        messageId: randomUUID(),
        tenantId,
        sessionId,
        sourceRunId,
        sourceAgentCallId,
        targetRunId: runningChildRoute.runId,
        targetAgentCallId,
        targetThreadKey: child.thread_key,
        targetChildAgentId: childAgentId,
        kind,
        correlationId: normalizeString(input.correlationId),
        replyToMessageId: normalizeString(input.replyToMessageId),
        contentParts: [{ type: "text", text: message }],
        ...(timeoutMs ? { expiresAt: new Date(Date.now() + timeoutMs).toISOString() } : {}),
        metadata: {
          source: "agent",
          direction: "parent_to_child",
          source_agent_name: parentAgent.agent_name,
          source_child_agent_id: normalizeString(ctx.currentChildAgentId),
          parent_tool_call_id: parentCallId,
          target_agent_name: child.agent_name,
          target_child_agent_id: childAgentId,
          target_thread_key: child.thread_key,
          target_root_run_id: runningChildRoute.rootRunId ?? runningChildRoute.runId,
          target_parent_run_id: runningChildRoute.parentRunId ?? normalizeString(ctx.runId),
          target_parent_call_id: runningChildRoute.parentCallId ?? parentCallId,
          target_lineage_parent_call_id: runningChildRoute.lineageParentCallId ?? normalizeString(ctx.parentCallId),
        },
      });
      this.notifyMailboxWakeup({
        sessionId,
        targetRunId: runningChildRoute.runId,
        targetAgentCallId,
        targetThreadKey: child.thread_key,
        targetChildAgentId: childAgentId,
        targetAgentName: child.agent_name,
        targetRootRunId: runningChildRoute.rootRunId ?? runningChildRoute.runId,
        targetParentRunId: runningChildRoute.parentRunId ?? normalizeString(ctx.runId),
        targetParentCallId: runningChildRoute.parentCallId ?? parentCallId,
        targetLineageParentCallId: runningChildRoute.lineageParentCallId ?? normalizeString(ctx.parentCallId),
        sourceMessageId: queued.message_id,
        correlationId: queued.correlation_id,
      });
      return successResult({
        message_id: queued.message_id,
        child_agent_id: childAgentId,
        target_run_id: runningChildRoute.runId,
        status: "queued",
        kind: queued.kind,
        correlation_id: queued.correlation_id,
        expires_at: queued.expires_at,
      }, {
        summary: `消息已进入子 Agent ${child.agent_name} 的队列；尚未确认接收、处理或回复`,
        outputType: "json",
        metadata: {
          agent_name: child.agent_name,
          child_agent_id: childAgentId,
          run_id: runningChildRoute.runId,
          message_id: queued.message_id,
          mailbox_kind: queued.kind,
          mailbox_queued: true,
        },
        toolName,
        llmHint: "status=queued 仅表示消息已持久化入队。目标 Agent 尚未 ACK，也不代表已按消息执行；在收到后续 response/result 前，不要向用户声称目标已收到、已停止或已完成。",
      });
    }

    const childDisplayName = this.resolveChildDisplayName(child.agent_name, session.team_snapshot);
    const childRunId = randomUUID();
    const initialEnvelopes = [buildAgentCallStart({
      sessionId,
      runId: childRunId,
      parentRunId: normalizeString(ctx.runId),
      parentAgentName: parentAgent.agent_name,
      parentCallId,
      rootParentCallId: normalizeString(ctx.currentCallId) ?? normalizeString(ctx.parentCallId) ?? normalizeString(ctx.rootCallId),
      agentCallId,
      agentName: child.agent_name,
      childDisplayName,
      description: message,
      childAgentId,
      mode: "resume",
    })];

    const runInput = this.buildChildRunInput({
      parentAgent,
      teamSnapshot: session.team_snapshot,
      ctx,
      childAgent: child,
      agentName: child.agent_name,
      task: message,
      rootTask: ctx.rootTask ?? message,
      childRunId,
      agentCallId,
      runParentCallId: parentCallId,
      resumeRunId: null,
      initialEnvelopes,
      ...(clampMailboxTimeout(input.timeoutMs) ? { timeoutMs: clampMailboxTimeout(input.timeoutMs) } : {}),
    });
    return this.runChildInvocation({
      runInput,
      childAgentId,
      childRunId,
      childDisplayName,
      description: message,
      mode: "resume",
      runInBackground: input.runInBackground === true,
    }, ctx);
  }

  /** Route a child-originated progress/request/response/cancel message to its exact parent run. */
  private async deliverMessageToParent(
    call: DeliverMessageCall,
    ctx: ToolExecContext,
    message: string,
    sourceToolCallId: string | null,
    toolName: string,
  ): Promise<ToolExecutionResult> {
    if (!ctx.parentRunId || !ctx.currentChildAgentId) {
      return errorResult("当前 Agent 没有可投递的父 invocation", toolName);
    }
    if (!this.mailbox) return errorResult("Agent mailbox 未注入，无法向父 Agent 投递消息", toolName);
    const tenantId = normalizeString(ctx.tenantId);
    const sessionId = normalizeString(ctx.sessionId);
    if (!tenantId || !sessionId) return errorResult("agent 缺少 tenant_id 或 session_id", toolName);
    const parent = await this.store.getRun(sessionId, ctx.parentRunId);
    if (!parent) return errorResult(`父 Agent run '${ctx.parentRunId}' 不存在`, toolName);
    const current = await this.store.getChildAgent(sessionId, ctx.currentChildAgentId);
    if (!current || current.parent_participant_id !== (parent.child_agent_id ?? null)) {
      return errorResult("当前 Agent 与目标父 invocation 不存在有效的直接 lineage", toolName);
    }
    const kind = call.input.kind ?? "response";
    const timeoutMs = clampMailboxTimeout(call.input.timeoutMs);
    const messageId = randomUUID();
    const queued = await this.mailbox.enqueue({
      messageId,
      tenantId,
      sessionId,
      sourceRunId: normalizeString(ctx.runId),
      sourceAgentCallId: normalizeString(ctx.currentCallId) ?? normalizeString(ctx.rootCallId),
      targetRunId: parent.run_id,
      targetAgentCallId: parent.agent_call_id,
      targetThreadKey: parent.thread_key ?? "root",
      targetChildAgentId: parent.child_agent_id ?? null,
      kind,
      correlationId: normalizeString(call.input.correlationId) ?? sourceToolCallId,
      replyToMessageId: normalizeString(call.input.replyToMessageId),
      contentParts: [{ type: "text", text: message }],
      ...(timeoutMs ? { expiresAt: new Date(Date.now() + timeoutMs).toISOString() } : {}),
      metadata: {
        source: "agent",
        direction: "child_to_parent",
        source_agent_name: current.agent_name,
        source_child_agent_id: ctx.currentChildAgentId,
        child_agent_id: ctx.currentChildAgentId,
        child_run_id: ctx.runId,
        target_agent_name: parent.agent_name ?? null,
        target_child_agent_id: parent.child_agent_id ?? null,
        target_thread_key: parent.thread_key ?? "root",
        target_root_run_id: parent.lease_root_run_id ?? parent.run_id,
        target_parent_run_id: parent.parent_run_id ?? null,
        target_parent_call_id: parent.parent_call_id ?? null,
        target_parent_agent_call_id: parent.lineage_parent_call_id,
        target_lineage_parent_call_id: parent.lineage_parent_call_id ?? null,
        visible_to_user: false,
      },
    });
    this.notifyMailboxWakeup({
      sessionId,
      targetRunId: parent.run_id,
      targetAgentCallId: parent.agent_call_id,
      targetThreadKey: parent.thread_key ?? "root",
      targetChildAgentId: parent.child_agent_id ?? null,
      targetAgentName: parent.agent_name ?? null,
      targetRootRunId: parent.lease_root_run_id ?? parent.run_id,
      targetParentRunId: parent.parent_run_id ?? null,
      targetParentCallId: parent.parent_call_id ?? null,
      targetLineageParentCallId: parent.lineage_parent_call_id ?? null,
      sourceMessageId: queued.message_id,
      correlationId: queued.correlation_id,
    });
    return successResult({
      message_id: queued.message_id,
      target: "parent",
      target_run_id: parent.run_id,
      status: "queued",
      kind: queued.kind,
      correlation_id: queued.correlation_id,
      expires_at: queued.expires_at,
    }, {
      summary: `消息已进入父 Agent 队列；尚未确认接收、处理或回复`,
      outputType: "json",
      metadata: {
        message_id: queued.message_id,
        mailbox_kind: queued.kind,
        mailbox_queued: true,
        direction: "child_to_parent",
      },
      toolName,
      llmHint: "status=queued 仅表示消息已持久化入队。父 Agent 尚未 ACK，也不代表已读取或处理；在收到后续响应前，不要把入队描述为已送达或已完成。",
    });
  }

  async listChildAgents(call: ListChildAgentsCall, ctx: ToolExecContext): Promise<ToolExecutionResult> {
    const { input } = call;
    const sessionId = normalizeString(ctx.sessionId);
    if (!sessionId) {
      return errorResult("list_child_agents 缺少 session_id", "list_child_agents");
    }
    const agentName = normalizeString(input.agentName);
    const parentParticipantId = normalizeString(ctx.currentChildAgentId);
    const allowedAgents = [...new Set(call.agent.delegation.enabled_agents ?? [])].filter(Boolean);
    if (!allowedAgents.length) {
      return errorResult("当前 Agent 未启用子 Agent 委派能力", "list_child_agents");
    }
    if (agentName && !allowedAgents.includes(agentName)) {
      return errorResult(`目标 Agent '${agentName}' 不在当前 allowlist 中`, "list_child_agents");
    }
    const limit = clampInteger(input.limit ?? 20, 1, 100);
    const results = agentName
      ? [await this.store.listChildAgents({ sessionId, agentName, parentParticipantId, limit })]
      : await Promise.all(allowedAgents.map((allowedAgent) => this.store.listChildAgents({
          sessionId,
          agentName: allowedAgent,
          parentParticipantId,
          limit,
        })));
    const childItems = [...new Map(results.flatMap((result) => result.items)
      .map((item) => [item.child_agent_id, item] as const)).values()]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, limit);
    const items = await Promise.all(childItems.map(async (item) => {
      const lastRun = item.last_run_id ? await this.store.getRun(sessionId, item.last_run_id) : null;
      return {
        child_agent_id: item.child_agent_id,
        agent_name: item.agent_name,
        status: item.status,
        last_run_id: item.last_run_id,
        last_run_status: lastRun?.status ?? (this.activeChildRuns.has(item.child_agent_id) ? "starting" : null),
        created_at: item.created_at,
        updated_at: item.updated_at,
      };
    }));
    return successResult(
      {
        items,
        total: results.reduce((total, result) => total + result.total, 0),
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

  private buildChildRunInput(spec: ChildRunBuildSpec): Omit<ChildRunInput, "signal"> {
    const parentRunId = normalizeString(spec.ctx.runId);
    return {
      tenantId: normalizeString(spec.ctx.tenantId) ?? "",
      sessionId: normalizeString(spec.ctx.sessionId) ?? "",
      agentName: spec.agentName,
      task: spec.task,
      requestId: normalizeString(spec.ctx.requestId),
      parentRunId,
      rootRunId: normalizeString(spec.ctx.rootRunId) ?? parentRunId,
      rootCallId: spec.agentCallId,
      runParentCallId: spec.runParentCallId,
      lineageParentCallId: normalizeString(spec.ctx.currentCallId) ?? normalizeString(spec.ctx.parentCallId),
      interactionRootCallId: normalizeString(spec.ctx.rootCallId) ?? spec.runParentCallId ?? spec.agentCallId,
      round: spec.ctx.round ?? null,
      childAgent: spec.childAgent,
      childRunId: spec.childRunId,
      resumeRunId: spec.resumeRunId,
      entrypoint: "agent",
      executionKind: spec.ctx.executionKind ?? "agent",
      rootTask: spec.rootTask,
      source: "agent_call",
      teamSnapshot: spec.teamSnapshot,
      workspaceRoot: getChildWorkspaceRoot(spec.childAgent, spec.ctx),
      parentThreadKey: normalizeString(spec.ctx.threadKey) ?? "root",
      parentChildAgentId: normalizeString(spec.ctx.currentChildAgentId),
      parentAgentName: spec.parentAgent.agent_name,
      parentRootRunId: normalizeString(spec.ctx.rootRunId) ?? parentRunId,
      parentParentRunId: normalizeString(spec.ctx.parentRunId),
      parentParentCallId: normalizeString(spec.ctx.runParentCallId),
      parentLineageParentCallId: normalizeString(spec.ctx.parentCallId),
      ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.initialEnvelopes ? { initialEnvelopes: spec.initialEnvelopes } : {}),
    };
  }

  private async runChildInvocation(
    spec: ChildRunExecutionSpec,
    ctx: ToolExecContext,
  ): Promise<ToolExecutionResult> {
    const toolName = "agent";
    const { runInput, childAgentId, childRunId, childDisplayName, description, mode } = spec;
    const activeRoute: ActiveChildRunRoute = {
      runId: childRunId,
      agentCallId: runInput.rootCallId,
      rootRunId: runInput.rootRunId,
      parentRunId: runInput.parentRunId,
      parentCallId: runInput.runParentCallId,
      lineageParentCallId: runInput.lineageParentCallId,
    };
    this.activeChildRuns.set(childAgentId, activeRoute);
    if (spec.runInBackground) {
      let backgroundTask: BackgroundTask;
      try {
        backgroundTask = this.backgroundTasks!.runCallable({
          outputDir: path.join(os.tmpdir(), "ragsystem-background", runInput.sessionId),
          description: `${childDisplayName}: ${description.slice(0, 120)}`,
          sessionId: runInput.sessionId,
          runId: childRunId,
          ownerTaskId: normalizeString(ctx.taskId),
          kind: "agent",
          resultType: this.mailbox ? "agent_delegation_result" : "agent_delegation_fallback",
          clientEvents: this.clientEvents,
          run: async ({ signal }) => {
            try {
              return await this.executeChildRun({ ...runInput, ownsRunLease: true, signal });
            } finally {
              if (this.activeChildRuns.get(childAgentId) === activeRoute) this.activeChildRuns.delete(childAgentId);
            }
          },
        });
      } catch (error) {
        if (this.activeChildRuns.get(childAgentId) === activeRoute) this.activeChildRuns.delete(childAgentId);
        throw error;
      }
      return successResult(
        {
          task_id: backgroundTask.task_id,
          background_task_id: backgroundTask.task_id,
          background_started: true,
          child_agent_id: childAgentId,
          run_id: childRunId,
          status: "running",
        },
        {
          summary: mode === "create"
            ? `子 Agent ${childDisplayName} 已在后台启动`
            : `子 Agent ${childDisplayName} 已在后台续接`,
          outputType: "json",
          metadata: {
            agent_name: runInput.agentName,
            agent_call_id: runInput.rootCallId,
            parent_call_id: runInput.runParentCallId,
            child_agent_id: childAgentId,
            run_id: childRunId,
            background_task_id: backgroundTask.task_id,
            task_id: backgroundTask.task_id,
            background_started: true,
            mode,
          },
          toolName,
        },
      );
    }

    let result: DelegationRunResult;
    try {
      result = await this.executeChildRun({ ...runInput, signal: ctx.signal });
    } finally {
      if (this.activeChildRuns.get(childAgentId) === activeRoute) this.activeChildRuns.delete(childAgentId);
    }
    return toToolResult(toolName, result, {
      agent_name: runInput.agentName,
      agent_call_id: runInput.rootCallId,
      parent_call_id: runInput.runParentCallId,
      child_agent_id: childAgentId,
      mode,
    });
  }

  /** 提前解析 child agent 展示名（agent_started/ended payload.display_name）；resolve 失败回退 agent_name。 */
  private resolveChildDisplayName(agentName: string, teamSnapshot: SessionTeamSnapshot): string {
    const resolved = this.runtimeCore.resolveExecutionConfig({ agentName, teamSnapshot });
    return resolved.agent?.display_name || agentName;
  }

  private async executeChildRun(input: ChildRunInput): Promise<DelegationRunResult> {
    try {
      return await this.executeChildRunImpl(input);
    } catch (error) {
      const run = await this.store.getRun(input.sessionId, input.childRunId);
      const suspended = run?.status === "suspended"
        || (error instanceof Error && error.name === "RecoverableInterrupt");
      if (!suspended) {
        await this.enqueueChildTerminalResult(input, {
          success: false,
          content: error instanceof Error ? error.message : String(error),
          summary: error instanceof Error ? error.message : String(error),
          outputType: "error",
          metadata: {
            run_id: input.childRunId,
            agent_name: input.agentName,
            child_agent_id: input.childAgent.child_agent_id,
          },
        });
      }
      throw error;
    }
  }

  private async executeChildRunImpl(input: ChildRunInput): Promise<DelegationRunResult> {
    const resolved = this.runtimeCore.resolveExecutionConfig({
      agentName: input.agentName,
      teamSnapshot: input.teamSnapshot,
    });
    if (!resolved.readiness.configuration_ready || !resolved.agent || !resolved.provider || !resolved.modelName) {
      return this.enqueueChildTerminalResult(input, {
        success: false,
        content: summarizeReadinessFailure(resolved.readiness.requirements),
        summary: summarizeReadinessFailure(resolved.readiness.requirements),
        outputType: "error",
        metadata: {
          agent_name: input.agentName,
          child_agent_id: input.childAgent.child_agent_id,
        },
      });
    }

    const childRunId = input.childRunId;
    const targetAgent = applyWorkspaceOverride(resolved.agent, input.workspaceRoot);
    const session = await this.store.getSession(input.sessionId);
    if (!session) throw new Error(`delegation session not found: ${input.sessionId}`);
    throwIfAborted(input.signal);
    if (input.resumeRunId) {
      await this.store.updateRunStatus(childRunId, input.sessionId, "running", null);
    } else {
      // 首次调用才写入任务消息；恢复时直接复用 child thread 中的悬空 tool_use。
      await this.store.addMessage({
        sessionId: input.sessionId,
        role: "user",
        content: input.task,
        contentParts: [{ type: "text", text: input.task }],
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
    throwIfAborted(input.signal);

    const invocationService = this.invocationService;
    if (!invocationService) {
      const message = "AgentInvocationService 未注入，无法执行子 Agent";
      return this.enqueueChildTerminalResult(input, {
        success: false,
        content: message,
        summary: message,
        outputType: "error",
        metadata: {
          agent_name: targetAgent.agent_name,
          child_agent_id: input.childAgent.child_agent_id,
        },
      });
    }

    // 子 run 复用 root 的 executeRun 执行核心：prepare/kernel/事件/recorder 全部统一，
    // 靠 threadKey=child:xxx + parent_run_id/parent_call_id/child_agent_id 区分归属。
    // observation 落子 thread、step 落子 run_id，续聊 prepare 重建完整上下文、工作栏按 parent_call_id 展示。
    // 在执行前记录 last_run_id，确保子 run 挂起抛异常时仍可由原 agent 调用找回。
    await this.store.updateChildAgentLastRun({
      sessionId: input.sessionId,
      childAgentId: input.childAgent.child_agent_id,
      lastRunId: childRunId,
    });
    throwIfAborted(input.signal);

    const handle = invocationService.invoke({
      scope: "child",
      mode: input.resumeRunId ? "resume" : "create",
      execution: input.ownsRunLease ? "background" : "foreground",
      sessionId: input.sessionId,
      sessionIdentity: toSessionIdentity(session),
      runId: childRunId,
      taskId: randomUUID(),
      rootCallId: input.rootCallId,
      interactionRootCallId: input.interactionRootCallId,
      parentCallId: input.runParentCallId,
      lineageParentCallId: input.lineageParentCallId,
      requestId: input.requestId ?? "",
      task: input.task,
      startedAt: new Date(),
      ...(input.signal ? { signal: input.signal } : {}),
      agent: targetAgent,
      provider: resolved.provider,
      modelName: resolved.modelName,
      threadKey: input.childAgent.thread_key,
      rootRunId: input.rootRunId ?? input.parentRunId ?? childRunId,
      parentRunId: input.parentRunId,
      childAgentId: input.childAgent.child_agent_id,
      ...(input.ownsRunLease ? { ownsRunLease: true } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      executionKind: input.executionKind,
      rootTask: input.ownsRunLease ? input.task : input.rootTask,
      ...(input.initialEnvelopes ? { initialEnvelopes: input.initialEnvelopes } : {}),
    });
    const outcome = await handle.promise;

    if (outcome.suspended) {
      const interactionKind = outcome.interactionKind ?? "approval";
      const content = interactionKind === "approval"
        ? "后台子 Agent 正在等待审批"
        : "后台子 Agent 正在等待用户输入";
      return {
        success: true,
        suspended: true,
        interaction_kind: interactionKind,
        content,
        summary: content,
        outputType: "json",
        metadata: {
          run_id: childRunId,
          agent_name: targetAgent.agent_name,
          child_agent_id: input.childAgent.child_agent_id,
          thread_key: input.childAgent.thread_key,
          suspended: true,
          interaction_kind: interactionKind,
        },
      };
    }

    const result: DelegationRunResult = {
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
    return this.enqueueChildTerminalResult(input, result);
  }

  private async enqueueChildTerminalResult(
    input: ChildRunInput,
    result: DelegationRunResult,
  ): Promise<DelegationRunResult> {
    if (!input.ownsRunLease || !this.mailbox || !input.tenantId || !input.parentRunId || result.suspended) return result;
    const parent = await this.store.getRun(input.sessionId, input.parentRunId);
    if (!parent) return result;
    const status = result.success
      ? "completed"
      : input.signal?.aborted
        ? "interrupted"
        : "failed";
    const content = normalizeString(result.content)
      ?? normalizeString(result.summary)
      ?? `子 Agent ${status}`;
    try {
      const queued = await this.mailbox.enqueue({
        messageId: `${input.childRunId}:terminal_result`,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        sourceRunId: input.childRunId,
        sourceAgentCallId: input.rootCallId,
        targetRunId: parent.run_id,
        targetAgentCallId: parent.agent_call_id,
        targetThreadKey: parent.thread_key,
        targetChildAgentId: parent.child_agent_id,
        kind: "result",
        correlationId: input.runParentCallId ?? input.rootCallId,
        contentParts: [{ type: "text", text: content }],
        metadata: {
          source: "child_terminal_result",
          direction: "child_to_parent",
          source_agent_name: input.childAgent.agent_name,
          source_child_agent_id: input.childAgent.child_agent_id,
          child_agent_id: input.childAgent.child_agent_id,
          child_run_id: input.childRunId,
          child_agent_call_id: input.rootCallId,
          target_agent_name: parent.agent_name ?? input.parentAgentName,
          target_child_agent_id: parent.child_agent_id ?? null,
          target_thread_key: parent.thread_key,
          target_root_run_id: input.parentRootRunId,
          target_parent_run_id: input.parentParentRunId,
          target_parent_call_id: input.parentParentCallId,
          target_parent_agent_call_id: input.parentLineageParentCallId,
          target_lineage_parent_call_id: input.parentLineageParentCallId,
          status,
          success: result.success,
          visible_to_user: false,
        },
      });
      this.notifyMailboxWakeup({
        sessionId: input.sessionId,
        targetRunId: parent.run_id,
        targetAgentCallId: parent.agent_call_id,
        targetThreadKey: parent.thread_key,
        targetChildAgentId: parent.child_agent_id,
        targetAgentName: parent.agent_name ?? input.parentAgentName,
        targetRootRunId: input.parentRootRunId,
        targetParentRunId: input.parentParentRunId,
        targetParentCallId: input.parentParentCallId,
        targetLineageParentCallId: input.parentLineageParentCallId,
        sourceMessageId: queued.message_id,
        correlationId: queued.correlation_id,
      });
      return {
        ...result,
        metadata: {
          ...result.metadata,
          mailbox_message_id: queued.message_id,
          mailbox_result_queued: true,
        },
      };
    } catch (error) {
      this.logger?.error({
        session_id: input.sessionId,
        child_run_id: input.childRunId,
        parent_run_id: input.parentRunId,
        error: error instanceof Error ? error.message : String(error),
      }, "failed to enqueue child terminal result");
      throw error;
    } finally {
      await this.wakePendingMessagesForCompletedChild(input);
    }
  }

  private async wakePendingMessagesForCompletedChild(input: ChildRunInput): Promise<void> {
    if (!this.mailbox?.listPending) return;
    try {
      const pending = await this.mailbox.listPending({
        sessionId: input.sessionId,
        targetRunId: input.childRunId,
        targetAgentCallId: input.rootCallId,
        targetThreadKey: input.childAgent.thread_key,
        targetChildAgentId: input.childAgent.child_agent_id,
        limit: 100,
      });
      for (const message of pending) {
        const metadata = message.metadata ?? {};
        this.notifyMailboxWakeup({
          sessionId: input.sessionId,
          targetRunId: input.childRunId,
          targetAgentCallId: input.rootCallId,
          targetThreadKey: input.childAgent.thread_key,
          targetChildAgentId: input.childAgent.child_agent_id,
          targetAgentName: input.childAgent.agent_name,
          targetRootRunId: input.childRunId,
          targetParentRunId: input.parentRunId,
          targetParentCallId: input.runParentCallId,
          targetLineageParentCallId: normalizeString(metadata.target_lineage_parent_call_id)
            ?? input.lineageParentCallId,
          sourceMessageId: message.message_id,
          correlationId: message.correlation_id,
        });
      }
    } catch (error) {
      this.logger?.error({
        session_id: input.sessionId,
        child_run_id: input.childRunId,
        error: error instanceof Error ? error.message : String(error),
      }, "failed to wake pending child Agent messages");
    }
  }

  private notifyMailboxWakeup(target: Parameters<AgentMailboxWakeupHandler>[0]): void {
    try {
      this.mailboxWakeup?.(target);
    } catch (error) {
      this.logger?.error({
        session_id: target.sessionId,
        target_run_id: target.targetRunId,
        target_agent_call_id: target.targetAgentCallId,
        error: error instanceof Error ? error.message : String(error),
      }, "failed to wake Agent mailbox target");
    }
  }

}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("子 Agent 执行已取消");
  error.name = "AbortError";
  throw error;
}

function clampMailboxTimeout(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(600_000, Math.max(1, Math.floor(value)));
}

function parseAgentCommand(
  input: AgentToolInput,
  ctx: ToolExecContext,
): AgentCollaborationCommand {
  const agentName = normalizeString(input.agentName);
  const childAgentId = normalizeString(input.childAgentId);
  const message = normalizeString(input.message);
  if (!message) return { type: "error", message: "agent 缺少 message" };
  if (agentName && childAgentId) {
    return { type: "error", message: "agent 不能同时指定 agent_name 和 child_agent_id" };
  }
  const fields: CollaborationMessageFields = {
    message,
    kind: input.kind,
    correlationId: input.correlationId,
    replyToMessageId: input.replyToMessageId,
    timeoutMs: input.timeoutMs,
    runInBackground: input.runInBackground,
    callId: input.callId,
  };
  if (agentName) {
    return {
      ...fields,
      type: "create_child",
      agentName,
      contextHint: input.contextHint,
    };
  }
  if (childAgentId) {
    return { ...fields, type: "message_child", childAgentId };
  }
  if (ctx.parentRunId && ctx.currentChildAgentId) {
    return { ...fields, type: "message_parent" };
  }
  return {
    type: "error",
    message: "agent 需要 agent_name 创建子 Agent，或在 child 上下文中省略目标向父 Agent 发消息",
  };
}
