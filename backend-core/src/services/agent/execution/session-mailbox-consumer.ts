import { createHash, randomUUID } from "node:crypto";
import { partsToPlainText } from "@ragsystem/agent-protocol";

import type {
  AgentInvocationChildInput,
  AgentInvocationHandle,
  AgentInvocationOutcome,
  AgentInvocationPort,
  AgentInvocationRootInput,
} from "../../../contracts/execution/agent-invocation.js";
import type {
  AgentMailboxMessage,
  AgentMailboxStorePort,
  AgentMailboxWakeupTarget,
} from "../../../contracts/storage/agent-mailbox-repository.js";
import type { ExecutionResultReader } from "../../../contracts/execution/execution-storage.js";
import type { ExecutionSessionPort } from "../../../contracts/session/session-application.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import type { Goal, GoalContinuationReason, GoalStore } from "../../../contracts/runtime/goals.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { ParticipantRunLifecyclePort } from "../delegation/port.js";
import { terminalReasonDisplay } from "../../../contracts/storage/runtime-finalization.js";
import { toSessionIdentity, type SessionIdentity } from "../../../contracts/session/session.js";
import { resolveExecutionAgentFor, type ReadinessResolution } from "./readiness.js";
import { readSessionRequestOverrides, type SessionRequestOverrides } from "./session-request-overrides.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { RunInfo } from "../../../contracts/conversation-store/index.js";
import type { TenantId } from "../../../identity/types.js";
import { asString } from "./helpers.js";

/**
 * 统一队列的唯一消费组件（§10 最终架构）：会话空闲检查（onSessionIdle /
 * triggerBgNotificationRun）与收件人唤醒快路径（onMailboxWakeup /
 * triggerAgentMailboxRun）两个触发口，共享同一套守卫、同一个续跑函数与同一个
 * Agent 解析点。两触发口不可合一：唤醒路径须能在 root run 运行期间拉起子 Agent
 * 续跑，空闲检查遇到运行中会话早退，可达集不同。运行中消息的另一认领方是活动
 * run 的 refresh（runtime-adapter），那是"running 情况"的本体，不在此组件内。
 */
export class SessionMailboxConsumer {
  private readonly idleLaunches = new Set<string>();
  private readonly mailboxLaunches = new Map<string, MailboxLaunchState>();

  constructor(private readonly deps: SessionMailboxConsumerDeps) {}

  /**
   * BackgroundTaskService 的单一 session-level trigger 消费者。本地 Set 合并同一进程的
   * 重复 idle 事件，GoalStore.claimContinuation 再用持久化 generation/pending 防止多实例
   * 重复续跑。只有 root run、后台任务和待消费通知都空闲时，active Goal 才会续跑。
   */
  triggerBgNotificationRun(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || this.idleLaunches.has(normalizedSessionId)) return;
    this.idleLaunches.add(normalizedSessionId);
    void this.startSessionIdleRun(normalizedSessionId)
      .catch(() => undefined)
      .finally(() => this.idleLaunches.delete(normalizedSessionId));
  }

  /** Wake one exact participant target for queued Agent communication. */
  triggerAgentMailboxRun(target: AgentMailboxWakeupTarget): void {
    const sessionId = target.sessionId.trim();
    const targetRunId = target.targetRunId.trim();
    if (!sessionId || !targetRunId) return;
    const key = `${sessionId}:${targetRunId}:${target.targetAgentCallId ?? ""}`;
    const existing = this.mailboxLaunches.get(key);
    if (existing) {
      existing.target = target;
      existing.dirty = true;
      return;
    }
    const state: MailboxLaunchState = { target, dirty: false };
    this.mailboxLaunches.set(key, state);
    void this.drainAgentMailboxTarget(state)
      .catch(() => undefined)
      .finally(() => {
        if (this.mailboxLaunches.get(key) !== state) return;
        this.mailboxLaunches.delete(key);
        if (state.dirty) this.triggerAgentMailboxRun(state.target);
      });
  }

  async completeAgentMailboxContinuation(input: AgentMailboxContinuationCompletionInput): Promise<void> {
    const { mailbox, runReader } = this.deps;
    if (!mailbox || !runReader || !input.parentRunId) return;
    const parent = await runReader.getRun(input.sessionId, input.parentRunId);
    if (!parent) return;
    const repliedMessage = input.replyToMessageId && !input.correlationId
      ? await mailbox.get(input.sessionId, input.replyToMessageId)
      : null;
    const content = input.outcome.content.trim()
      || (input.outcome.success ? "子 Agent 已完成消息处理" : "子 Agent 消息处理失败");
    const queued = await mailbox.enqueue({
      messageId: `${input.sourceRunId}:terminal_result`,
      tenantId: this.deps.tenantId,
      sessionId: input.sessionId,
      sourceRunId: input.sourceRunId,
      sourceAgentCallId: input.sourceAgentCallId,
      targetRunId: parent.run_id,
      targetAgentCallId: parent.agent_call_id,
      targetThreadKey: parent.thread_key,
      targetChildAgentId: parent.child_agent_id,
      kind: "result",
      correlationId: input.correlationId
        ?? repliedMessage?.correlation_id
        ?? input.replyToMessageId
        ?? input.sourceAgentCallId,
      replyToMessageId: input.replyToMessageId ?? null,
      contentParts: input.outcome.contentParts?.length
        ? input.outcome.contentParts
        : [{ type: "text", text: content }],
      metadata: {
        source: "agent_message_continuation_result",
        direction: "child_to_parent",
        source_agent_name: input.sourceAgentName,
        source_child_agent_id: input.sourceChildAgentId,
        child_agent_id: input.sourceChildAgentId,
        child_run_id: input.sourceRunId,
        child_agent_call_id: input.sourceAgentCallId,
        target_agent_name: parent.agent_name,
        target_child_agent_id: parent.child_agent_id,
        target_thread_key: parent.thread_key,
        target_root_run_id: parent.lease_root_run_id,
        target_parent_run_id: parent.parent_run_id,
        target_parent_call_id: parent.parent_call_id,
        target_parent_agent_call_id: parent.lineage_parent_call_id,
        target_lineage_parent_call_id: parent.lineage_parent_call_id,
        status: input.outcome.success ? "completed" : "failed",
        success: input.outcome.success,
        visible_to_user: false,
      },
    });
    this.triggerAgentMailboxRun({
      sessionId: input.sessionId,
      targetRunId: parent.run_id,
      targetAgentCallId: parent.agent_call_id,
      targetThreadKey: parent.thread_key,
      targetChildAgentId: parent.child_agent_id,
      targetAgentName: parent.agent_name,
      targetRootRunId: parent.lease_root_run_id,
      targetParentRunId: parent.parent_run_id,
      targetParentCallId: parent.parent_call_id,
      targetLineageParentCallId: parent.lineage_parent_call_id,
      sourceMessageId: queued.message_id,
      correlationId: queued.correlation_id,
    });
  }

  private async durableActiveRunId(sessionId: string): Promise<string | null> {
    return (await this.deps.runtimeStorage.operations.getActiveRootRun?.(sessionId))?.runId ?? null;
  }

  private resolveExecutionAgent(input: {
    agentName?: string | null;
    teamSnapshot: SessionIdentity["teamSnapshot"];
    selectedLlm?: string | null;
  }): ReadinessResolution {
    return resolveExecutionAgentFor(this.deps.runtimeCore, input);
  }

  private async drainAgentMailboxTarget(state: MailboxLaunchState): Promise<void> {
    for (;;) {
      state.dirty = false;
      const disposition = await this.startAgentMailboxRun(state.target);
      if (disposition === "deferred") {
        if (state.dirty) continue;
        return;
      }
      if (disposition !== "completed") return;
      const next = await this.findStablePendingMailboxTarget(state);
      if (!next) return;
      state.target = next;
    }
  }

  private async findStablePendingMailboxTarget(
    state: MailboxLaunchState,
  ): Promise<AgentMailboxWakeupTarget | null> {
    state.dirty = false;
    const pending = await this.findPendingMailboxTarget(state.target);
    if (pending) return pending;
    return state.dirty ? state.target : null;
  }

  private async findPendingMailboxTarget(
    target: AgentMailboxWakeupTarget,
  ): Promise<AgentMailboxWakeupTarget | null> {
    const pending = await this.deps.mailbox?.listPending?.({
      sessionId: target.sessionId,
      targetRunId: target.targetRunId,
      targetAgentCallId: target.targetAgentCallId,
      targetThreadKey: target.targetThreadKey,
      targetChildAgentId: target.targetChildAgentId,
      limit: 1,
    }) ?? [];
    const first = pending[0];
    return first?.target_run_id ? toMailboxWakeupTarget(first) : null;
  }

  private async startAgentMailboxRun(target: AgentMailboxWakeupTarget): Promise<MailboxLaunchDisposition> {
    const { backgroundTasks, mailbox, runReader, sessions, invocationService, participantRuns, statusTracker } = this.deps;
    const targetsChild = Boolean(target.targetChildAgentId);
    if (!targetsChild) {
      const currentStatus = statusTracker.getStatusBySession(target.sessionId)?.status;
      if (currentStatus === "running" || currentStatus === "suspended") return "deferred";
      if (await this.durableActiveRunId(target.sessionId)) return "deferred";
      if (await backgroundTasks?.hasRunningTasksDurable(target.sessionId)) return "deferred";
    }
    if (!mailbox || !runReader) return "skipped";
    const durableTarget = await runReader.getRun(target.sessionId, target.targetRunId);
    if (!durableTarget) return "skipped";
    if (!mailboxTargetMatchesRun(target, durableTarget)) return "skipped";
    if (durableTarget.status === "running" || durableTarget.status === "suspended") return "deferred";
    if (!target.sourceMessageId) {
      const pendingTarget = await this.findPendingMailboxTarget(target);
      if (!pendingTarget) return "skipped";
      target = pendingTarget;
    }
    const sourceMessage = target.sourceMessageId
      ? await mailbox.get(target.sessionId, target.sourceMessageId)
      : null;
    if (!sourceMessage || sourceMessage.status !== "queued") return "skipped";
    const durableSourceTarget = toMailboxWakeupTarget(sourceMessage);
    if (!mailboxTargetMatchesRun(durableSourceTarget, durableTarget)) return "skipped";
    target = durableSourceTarget;
    const session = await sessions.getSession(target.sessionId);
    if (!session) return "skipped";
    const sessionIdentity = toSessionIdentity(session);
    // 会话级设定（模型/思考档位）只作用于主智能体（替换 default 档）；子 Agent
    // 续跑走自己的 tier 配置，与 delegation 同口径。Agent 解析与其他渠道共用
    // resolveExecutionAgent（agentName 来自目标 run 记录）。
    const sessionOverrides = readSessionRequestOverrides(sessionIdentity.metadata);
    const rootSelectedLlm = targetsChild ? null : sessionOverrides.selectedLlm;
    const ready = this.resolveExecutionAgent({
      agentName: durableTarget.agent_name,
      teamSnapshot: sessionIdentity.teamSnapshot,
      selectedLlm: rootSelectedLlm,
    });
    if (!ready.ok) return "skipped";
    const continuationIds = mailboxContinuationIds(target);
    if (!continuationIds) return "skipped";
    const { runId, taskId, rootCallId } = continuationIds;
    const task = "处理来自 Agent 的消息，并继续当前任务。";
    const base = {
      mode: "create" as const,
      execution: "background" as const,
      sessionId: target.sessionId,
      sessionIdentity,
      runId,
      taskId,
      rootCallId,
      requestId: `${MAILBOX_CONTINUATION_REQUEST_PREFIX}${target.sourceMessageId}`,
      task,
      // mailbox 续接无父工具上下文可继承，回退会话 owner 作为 run 用户身份。
      userId: sessionIdentity.ownerUserId,
      executionKind: "system.agent_message",
      agent: ready.agent,
      provider: ready.provider,
      modelName: ready.modelName,
      mailboxTargetRunId: target.targetRunId,
      mailboxTargetAgentCallId: target.targetAgentCallId,
    };
    let participantRegistered = false;
    let completedChildTarget: AgentMailboxWakeupTarget | null = null;
    try {
      if (target.targetChildAgentId) {
        await participantRuns.registerParticipantRun({
          sessionId: target.sessionId,
          childAgentId: target.targetChildAgentId,
          runId,
          agentCallId: rootCallId,
          rootRunId: runId,
          parentRunId: target.targetParentRunId,
          parentCallId: target.targetParentCallId,
          lineageParentCallId: target.targetLineageParentCallId,
          replacesRunId: target.targetRunId,
        });
        participantRegistered = true;
      }
      const started = target.targetChildAgentId
        ? invocationService.invoke({
            ...base,
            scope: "child",
            startedAt: new Date(),
            threadKey: target.targetThreadKey,
            rootRunId: runId,
            interactionRootCallId: target.targetAgentCallId ?? rootCallId,
            parentRunId: target.targetParentRunId,
            parentCallId: target.targetParentCallId,
            lineageParentCallId: target.targetLineageParentCallId,
            childAgentId: target.targetChildAgentId,
            initialMessage: mailboxContinuationInitialMessage(sourceMessage, runId),
            participantExpectedLastRunId: target.targetRunId,
            initialMailboxMessageId: sourceMessage.message_id,
            ownsRunLease: true,
          })
        : invocationService.invoke({
            ...base,
            scope: "root",
            rootCallId,
            ...(rootSelectedLlm ? { selectedLlm: { provider: ready.provider, modelName: ready.modelName } } : {}),
            ...(sessionOverrides.thinkingLevel ? { thinkingLevel: sessionOverrides.thinkingLevel } : {}),
            rootMailboxMessage: {
              id: sourceMessage.message_id,
              inputType: sourceMessage.input_type,
              sourceKind: sourceMessage.source_kind,
              visibleToUser: sourceMessage.visible_to_user,
              sentAt: sourceMessage.sent_at ?? sourceMessage.created_at,
              contentParts: sourceMessage.content_parts,
              metadata: sourceMessage.metadata,
            },
          });
      try {
        await started.durableStarted;
      } catch (error) {
        if (!targetsChild && isActiveRootRunConflict(error)) return "deferred";
        throw error;
      }
      const outcome = await started.promise;
      if (targetsChild && !outcome.suspended) {
        completedChildTarget = {
          ...target,
          targetRunId: runId,
          targetAgentCallId: rootCallId,
          targetRootRunId: runId,
        };
        await this.completeAgentMailboxContinuation({
          sessionId: target.sessionId,
          sourceRunId: runId,
          sourceAgentCallId: rootCallId,
          sourceAgentName: target.targetAgentName ?? ready.agent.agent_name,
          sourceChildAgentId: target.targetChildAgentId!,
          parentRunId: target.targetParentRunId,
          correlationId: target.correlationId ?? null,
          replyToMessageId: target.sourceMessageId ?? null,
          outcome,
        });
      }
      return outcome.suspended ? "skipped" : "completed";
    } finally {
      if (participantRegistered && target.targetChildAgentId) {
        participantRuns.releaseParticipantRun({
          childAgentId: target.targetChildAgentId,
          runId,
        });
      }
      try {
        if (completedChildTarget) {
          const pending = await this.findPendingMailboxTarget(completedChildTarget);
          if (pending) this.triggerAgentMailboxRun(pending);
        }
      } finally {
        backgroundTasks?.scheduleAutoTrigger(target.sessionId);
      }
    }
  }

  private async recoverMailboxContinuationResults(sessionId: string): Promise<void> {
    const { mailbox, runReader } = this.deps;
    if (!mailbox || !runReader?.listRuns || !runReader.getMessageById) return;
    const pageSize = 500;
    for (let offset = 0;; offset += pageSize) {
      const runs = await runReader.listRuns(sessionId, pageSize, offset);
      for (const run of runs.items) {
        if (
          run.entrypoint !== "system.agent_message"
          || !run.child_agent_id
          || !run.parent_run_id
          || !["completed", "failed", "interrupted"].includes(run.status)
          || !run.request_id?.startsWith(MAILBOX_CONTINUATION_REQUEST_PREFIX)
        ) {
          continue;
        }
        const sourceMessageId = run.request_id.slice(MAILBOX_CONTINUATION_REQUEST_PREFIX.length).trim();
        if (!sourceMessageId) continue;
        const sourceMessage = await mailbox.get(sessionId, sourceMessageId);
        if (!sourceMessage) continue;
        if (sourceMessage.status === "queued" || sourceMessage.status === "claimed") {
          const settled = await mailbox.settle({ sessionId, messageId: sourceMessageId });
          if (!settled) continue;
        }
        const existingResult = await mailbox.get(sessionId, `${run.run_id}:terminal_result`);
        if (existingResult) {
          if (existingResult.status === "queued" && existingResult.target_run_id) {
            this.triggerAgentMailboxRun(toMailboxWakeupTarget(existingResult));
          }
          continue;
        }
        const finalMessage = run.final_message_id
          ? await runReader.getMessageById(sessionId, run.final_message_id)
          : null;
        const failedStatus = run.status === "interrupted" ? "interrupted" : "failed";
        const fallbackContent = run.status === "completed"
          ? "子 Agent 已完成消息处理"
          : terminalReasonDisplay(
              failedStatus,
              run.terminal_reason?.trim() || (failedStatus === "failed" ? "未提供失败原因" : "未提供中断原因"),
            );
        await this.completeAgentMailboxContinuation({
          sessionId,
          sourceRunId: run.run_id,
          sourceAgentCallId: run.agent_call_id,
          sourceAgentName: run.agent_name ?? "agent",
          sourceChildAgentId: run.child_agent_id,
          parentRunId: run.parent_run_id,
          correlationId: sourceMessage.correlation_id,
          replyToMessageId: sourceMessageId,
          outcome: {
            content: finalMessage ? partsToPlainText(finalMessage.content_parts) : fallbackContent,
            contentParts: finalMessage?.content_parts ?? [{ type: "text", text: fallbackContent }],
            success: run.status === "completed",
            runId: run.run_id,
          },
        });
      }
      if (runs.items.length < pageSize || offset + runs.items.length >= runs.total) break;
    }
  }

  private async startSessionIdleRun(sessionId: string): Promise<void> {
    const { backgroundTasks, goalStore, mailbox, sessions, statusTracker } = this.deps;
    let claimedGoal: Goal | null = null;
    let claimedNotifications: AgentMailboxMessage[] = [];
    let releaseOwned = true;
    const releaseClaim = async (): Promise<void> => {
      if (!claimedGoal || !goalStore) return;
      await goalStore.releaseContinuation(
        sessionId,
        claimedGoal.id,
        claimedGoal.continuation_generation,
      );
    };

    try {
      await this.recoverMailboxContinuationResults(sessionId);
      const currentGoal = await goalStore?.getCurrent(sessionId) ?? null;
      const markReason = async (reason: GoalContinuationReason): Promise<void> => {
        if (currentGoal && goalStore?.setContinuationReason) {
          await goalStore.setContinuationReason(sessionId, currentGoal.id, reason);
        }
      };
      const status = statusTracker.getStatusBySession(sessionId)?.status;
      if (
        status === "running"
        || status === "suspended"
      ) {
        await markReason("run_still_running");
        return;
      }
      if (await backgroundTasks?.hasRunningTasksDurable(sessionId)) {
        await markReason("background_tasks_running");
        return;
      }
      // 统一队列按优先级消费：排队用户消息 > 定向 run 唤醒 > 后台通知（与 goal 续跑
      // 合并）。listPending 是全类型 FIFO——scan 而非只看首条，通知排在前时不会挡住
      // 用户消息补跑。
      const pendingMailbox = await mailbox?.listPending?.({ sessionId, limit: 100 }) ?? [];
      const firstUserMessage = pendingMailbox.find((message) => message.input_type === "user_message" && message.target_thread_key === "root");
      if (firstUserMessage) {
        const existingSession = await sessions.getSession(sessionId);
        if (!existingSession) return;
        const sessionIdentity = toSessionIdentity(existingSession);
        // 排队用户消息的补跑同样走会话级设定：消息入队时的选择即当时落库的设定。
        const overrides = readSessionRequestOverrides(sessionIdentity.metadata);
        const ready = this.resolveExecutionAgent({
          teamSnapshot: sessionIdentity.teamSnapshot,
          selectedLlm: overrides.selectedLlm,
        });
        if (!ready.ok) return;
        const started = this.deps.launchSystemRun({
          sessionIdentity,
          // 系统触发的 root run 无请求 identity，回退会话 owner 作为 run 用户身份
          //（memory 等按 user 归属的工具依赖 ToolExecContext.userId）。
          userId: sessionIdentity.ownerUserId,
          requestId: `session_followup_${firstUserMessage.message_id}`,
          task: "处理待接收的用户消息，并继续当前任务。",
          executionKind: "session_followup",
          ready,
          overrides,
          rootMailboxMessage: {
            id: firstUserMessage.message_id,
            inputType: firstUserMessage.input_type,
            sourceKind: "user",
            visibleToUser: firstUserMessage.visible_to_user,
            sentAt: firstUserMessage.sent_at ?? firstUserMessage.created_at,
            contentParts: firstUserMessage.content_parts,
            metadata: firstUserMessage.metadata,
          },
        });
        await started.durableStarted;
        return;
      }
      const firstTargeted = pendingMailbox.find((message) => message.target_run_id);
      if (firstTargeted) {
        this.triggerAgentMailboxRun(toMailboxWakeupTarget(firstTargeted));
        return;
      }
      const hasIdleMessages = pendingMailbox.some(isIdleSystemMessage);
      const hasQueuedGoal = pendingMailbox.some((message) => message.input_type === "goal_continuation");
      if (!hasIdleMessages && currentGoal?.status !== "active") {
        if (currentGoal) await markReason(currentGoal.status === "paused" ? "manual_paused" : "goal_not_active");
        return;
      }

      const existingSession = await sessions.getSession(sessionId);
      if (!existingSession) return;
      const sessionIdentity = toSessionIdentity(existingSession);
      // goal 续跑 / 后台通知拉起的主智能体同走会话级设定（用户此前选定的模型与档位）。
      const overrides = readSessionRequestOverrides(sessionIdentity.metadata);
      const ready = this.resolveExecutionAgent({
        teamSnapshot: sessionIdentity.teamSnapshot,
        selectedLlm: overrides.selectedLlm,
      });
      if (!ready.ok) {
        await markReason("readiness_failed");
        return;
      }

      // Session/agent readiness may require SaaS I/O. Claim only after those checks pass so a
      // configuration failure or an intervening user run does not consume a continuation attempt.
      const readyStatus = statusTracker.getStatusBySession(sessionId)?.status;
      if (
        readyStatus === "running"
        || readyStatus === "suspended"
      ) {
        await markReason("run_still_running");
        return;
      }
      if (await backgroundTasks?.hasRunningTasksDurable(sessionId)) {
        await markReason("background_tasks_running");
        return;
      }
      if (!hasQueuedGoal && currentGoal?.status === "active" && goalStore) {
        if (currentGoal.continuation_pending && currentGoal.continuation_claimed_at) {
          await markReason("continuation_pending");
        }
        claimedGoal = await goalStore.claimContinuation(sessionId, {
          maxContinuations: 20,
          maxNoProgress: 3,
          leaseTimeoutMs: 120_000,
        });
      }
      // goal 生产者：预算门控（maxContinuations/maxNoProgress/租约）通过后向统一
      // 队列投递一条 goal_continuation 等待行，消费与其他系统消息同通道（claim →
      // 合并渲染 → durableStarted 后 ack）。循环由队列本身串行化：行被消费才起
      // run，run 终态（scheduleAutoTrigger）才触发下一轮生产。预算已在 claim 时
      // 计数，工作由持久行承载，投递成功即释放认领。
      if (claimedGoal && mailbox) {
        await mailbox.enqueue({
          messageId: `goalcont_${claimedGoal.id}_${claimedGoal.continuation_generation}`,
          tenantId: this.deps.tenantId,
          sessionId,
          targetThreadKey: "root",
          kind: "request",
          inputType: "goal_continuation",
          sourceKind: "system",
          visibleToUser: false,
          sentAt: new Date().toISOString(),
          contentParts: [{ type: "text", text: renderGoalContinuation(claimedGoal) }],
          metadata: {
            source: "goal_continuation",
            goal_id: claimedGoal.id,
            goal_generation: claimedGoal.continuation_generation,
          },
        });
        releaseOwned = false;
        await releaseClaim();
        claimedGoal = null;
      }

      // Re-read durable background work after the asynchronous continuation claim. If another
      // instance started work meanwhile, finally releases this claim for a later idle attempt.
      if (await backgroundTasks?.hasRunningTasksDurable(sessionId)) {
        await markReason("background_tasks_running");
        return;
      }
      // The durable gate above yields. Re-read local status after it resolves, then keep the
      // remaining path synchronous through startRun so a same-process user run cannot interleave.
      const latestStatus = statusTracker.getStatusBySession(sessionId)?.status;
      if (latestStatus === "running" || latestStatus === "suspended") {
        await markReason("run_still_running");
        return;
      }
      claimedNotifications = await this.claimIdleNotifications(sessionId);
      if (!claimedNotifications.length) {
        const latestGoal = await goalStore?.getCurrent(sessionId) ?? null;
        if (latestGoal?.status === "active" && latestGoal.continuation_pending && goalStore?.setContinuationReason) {
          await goalStore.setContinuationReason(sessionId, latestGoal.id, "continuation_pending");
        }
        return;
      }
      const task = claimedNotifications
        .map((message) => renderMailboxContentParts(message.content_parts))
        .filter(Boolean)
        .join("\n\n");
      const goalRow = claimedNotifications.find((message) => message.input_type === "goal_continuation") ?? null;
      const source = goalRow ? "goal_continuation" : "background_notification";
      const started = this.deps.launchSystemRun({
        sessionIdentity,
        userId: sessionIdentity.ownerUserId,
        requestId: `${goalRow ? "goal_continue" : "bg_notify"}_${randomUUID()}`,
        task,
        executionKind: goalRow ? "system.goal_continuation" : "system.bg_notification",
        ready,
        overrides,
        persistUserMessage: {
          contentParts: [{ type: "text", text: task }],
          inputType: goalRow ? "goal_continuation" : "system_notification",
          sourceKind: "system",
          visibleToUser: false,
          metadata: {
            source,
            ...(goalRow ? {
              goal_id: goalRow.metadata.goal_id,
              goal_generation: goalRow.metadata.goal_generation,
            } : {}),
          },
        },
      });
      await started.durableStarted;
      // 消息内容已渲染进 run 初始输入并持久，ack 终结认领；失败静默——租约到期
      // 自然回队，最坏情况是下一次 idle 重复投递一次内容一致的消息。
      await this.ackNotifications(sessionId, claimedNotifications);
      claimedNotifications = [];
    } catch (error) {
      await this.releaseNotifications(sessionId, claimedNotifications, error);
      claimedNotifications = [];
      if (claimedGoal && goalStore?.setContinuationReason) {
        await goalStore.setContinuationReason(sessionId, claimedGoal.id, "continuation_start_failed");
      }
      throw error;
    } finally {
      if (releaseOwned) await releaseClaim();
    }
  }

  /**
   * 认领会话级系统消息（root 线程、无定向 run 的 system_notification /
   * goal_continuation）。claim 的 idle 谓词不按 input_type 过滤——并发到达的排队
   * 用户消息可能被一并认领，立即 release 回队，留给下一次 idle 检查走
   * session_followup 补跑。
   */
  private async claimIdleNotifications(sessionId: string): Promise<AgentMailboxMessage[]> {
    const mailbox = this.deps.mailbox;
    if (!mailbox) return [];
    const claimed = await mailbox.claim({
      sessionId,
      targetRunId: null,
      targetThreadKey: "root",
      claimId: `bg_notify_idle_${randomUUID()}`,
      consumerId: `bg_notify_idle:${process.pid}:${randomUUID()}`,
      limit: 100,
    });
    const notifications: AgentMailboxMessage[] = [];
    for (const message of claimed) {
      if (isIdleSystemMessage(message)) {
        notifications.push(message);
        continue;
      }
      try {
        await mailbox.release({
          sessionId,
          messageId: message.message_id,
          claimId: message.claim_id ?? "",
          lastError: "requeued: not a session notification",
        });
      } catch {
        // 认领租约到期自动回队，无需补救。
      }
    }
    return notifications;
  }

  private async ackNotifications(sessionId: string, messages: AgentMailboxMessage[]): Promise<void> {
    const mailbox = this.deps.mailbox;
    if (!mailbox || !messages.length) return;
    for (const message of messages) {
      try {
        await mailbox.ack({ sessionId, messageId: message.message_id, claimId: message.claim_id ?? "" });
      } catch {
        // 见调用点注释：租约到期回队，重复投递内容一致。
      }
    }
  }

  private async releaseNotifications(sessionId: string, messages: AgentMailboxMessage[], error: unknown): Promise<void> {
    const mailbox = this.deps.mailbox;
    if (!mailbox || !messages.length) return;
    const lastError = error instanceof Error ? error.message : String(error);
    for (const message of messages) {
      try {
        await mailbox.release({
          sessionId,
          messageId: message.message_id,
          claimId: message.claim_id ?? "",
          ...(lastError ? { lastError } : {}),
        });
      } catch {
        // 认领租约到期自动回队，无需补救。
      }
    }
  }
}

export interface SessionMailboxConsumerDeps {
  tenantId: TenantId;
  sessions: ExecutionSessionPort;
  runtimeCore: RuntimeExecutionConfigResolver;
  statusTracker: AgentExecutionStatusTracker;
  invocationService: AgentInvocationPort;
  backgroundTasks: BackgroundTaskService | null;
  goalStore: GoalStore | null;
  runtimeStorage: RuntimeStorage;
  mailbox: AgentMailboxStorePort | null;
  runReader: (Pick<ExecutionResultReader, "getRun"> & Partial<Pick<ExecutionResultReader, "getMessageById" | "listRuns">>) | null;
  participantRuns: ParticipantRunLifecyclePort;
  /** 会话级系统 run 拉起钩子：launchers 经唯一组装点 invokeRootRun 以 background 执行。 */
  launchSystemRun: (input: SessionSystemRunInput) => AgentInvocationHandle;
}

/** 消费组件发起的会话级系统 run 输入（经 launchSystemRun 钩子进入唯一组装点）。 */
export interface SessionSystemRunInput {
  sessionIdentity: SessionIdentity;
  userId: string | null;
  requestId: string;
  task: string;
  executionKind: string;
  ready: Extract<ReadinessResolution, { ok: true }>;
  overrides: SessionRequestOverrides;
  persistUserMessage?: AgentInvocationRootInput["persistUserMessage"];
  rootMailboxMessage?: AgentInvocationRootInput["rootMailboxMessage"];
  /** run 终态回调（如释放 goal continuation 认领），先于 autoTrigger。 */
  onFinally?: () => Promise<void> | void;
}

export interface AgentMailboxContinuationCompletionInput {
  sessionId: string;
  sourceRunId: string;
  sourceAgentCallId: string;
  sourceAgentName: string;
  sourceChildAgentId: string;
  parentRunId: string | null;
  correlationId?: string | null;
  replyToMessageId?: string | null;
  outcome: AgentInvocationOutcome;
}

interface MailboxLaunchState {
  target: AgentMailboxWakeupTarget;
  dirty: boolean;
}

type MailboxLaunchDisposition = "completed" | "deferred" | "skipped";

export const MAILBOX_CONTINUATION_REQUEST_PREFIX = "agent_result:";

export function mailboxContinuationSourceMessageId(requestId: string | null | undefined): string | null {
  const normalized = requestId?.trim() ?? "";
  if (!normalized.startsWith(MAILBOX_CONTINUATION_REQUEST_PREFIX)) return null;
  return normalized.slice(MAILBOX_CONTINUATION_REQUEST_PREFIX.length).trim() || null;
}

function mailboxContinuationIds(target: AgentMailboxWakeupTarget): {
  runId: string;
  taskId: string;
  rootCallId: string;
} | null {
  const sourceMessageId = target.sourceMessageId?.trim();
  if (!sourceMessageId) return null;
  const digest = createHash("sha256")
    .update(`${target.sessionId}\0${target.targetRunId}\0${target.targetAgentCallId ?? ""}\0${sourceMessageId}`)
    .digest("hex")
    .slice(0, 32);
  return {
    runId: `mailbox_${digest}`,
    taskId: `mailbox_task_${digest}`,
    rootCallId: `call_mailbox_${digest}`,
  };
}

function renderMailboxContentParts(parts: AgentMailboxMessage["content_parts"]): string {
  return parts.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "command_ref" && part.resolution.kind === "prompt") {
      return [part.resolution.agent_text];
    }
    return [];
  }).join("\n").trim();
}

function mailboxContinuationInitialMessage(
  message: AgentMailboxMessage,
  runId: string,
): NonNullable<AgentInvocationChildInput["initialMessage"]> {
  const displayContent = renderMailboxContentParts(message.content_parts);
  const content = message.input_type === "user_message"
    ? displayContent
    : `[agent-message kind=${message.kind} id=${message.message_id}]\n${displayContent}\n[/agent-message]`;
  return {
    id: message.message_id,
    content,
    contentParts: message.input_type === "user_message"
      ? message.content_parts
      : [{ type: "text", text: content }],
    metadata: {
      ...message.metadata,
      ...(message.input_type === "user_message" ? {} : { agent_message: true }),
      agent_message_display_content: displayContent,
      mailbox_message_id: message.message_id,
      mailbox_kind: message.kind,
      mailbox_correlation_id: message.correlation_id,
      mailbox_reply_to_message_id: message.reply_to_message_id,
      mailbox_source_run_id: message.source_run_id,
      mailbox_source_agent_call_id: message.source_agent_call_id,
      conversation_scope: message.target_child_agent_id ? "child" : "agent",
      consumed_by_run_id: runId,
      run_id: runId,
      visible_to_user: message.visible_to_user,
      sent_at: message.sent_at,
    },
  };
}

function mailboxTargetMatchesRun(target: AgentMailboxWakeupTarget, run: RunInfo): boolean {
  return run.session_id === target.sessionId
    && run.run_id === target.targetRunId
    && run.agent_call_id === target.targetAgentCallId
    && run.thread_key === target.targetThreadKey
    && run.child_agent_id === target.targetChildAgentId
    && run.agent_name === target.targetAgentName
    && run.lease_root_run_id === target.targetRootRunId
    && run.parent_run_id === target.targetParentRunId
    && run.parent_call_id === target.targetParentCallId
    && run.lineage_parent_call_id === target.targetLineageParentCallId;
}

function isActiveRootRunConflict(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith("session already has an active root run: ");
}

/** 会话级系统消息在统一队列中的形状：root 线程、无定向 run 的 system_notification / goal_continuation。 */
function isIdleSystemMessage(message: AgentMailboxMessage): boolean {
  return (message.input_type === "system_notification" || message.input_type === "goal_continuation")
    && message.target_thread_key === "root"
    && !message.target_run_id;
}

function toMailboxWakeupTarget(message: AgentMailboxMessage): AgentMailboxWakeupTarget {
  const metadata = message.metadata;
  const read = (key: string): string | null => asString(metadata[key]);
  return {
    sessionId: message.session_id,
    targetRunId: message.target_run_id ?? "",
    targetAgentCallId: message.target_agent_call_id,
    targetThreadKey: message.target_thread_key,
    targetChildAgentId: message.target_child_agent_id,
    targetAgentName: read("target_agent_name"),
    targetRootRunId: read("target_root_run_id"),
    targetParentRunId: read("target_parent_run_id"),
    targetParentCallId: read("target_parent_call_id"),
    targetLineageParentCallId: read("target_lineage_parent_call_id"),
    sourceMessageId: message.message_id,
    correlationId: message.correlation_id,
  };
}

function renderGoalContinuation(goal: Goal): string {
  const criteria = goal.success_criteria.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const steps = goal.steps.map((step) => (
    `- [${step.status}] ${step.id}: ${step.title}${step.description ? ` — ${step.description}` : ""}`
  )).join("\n");
  return `<goal-continuation goal-id="${goal.id}" generation="${goal.continuation_generation}">
当前 Session 的 Goal 尚未完成，请继续推进，不要只复述计划。

最终目标：${goal.objective}

验收标准：
${criteria || "- 尚未设置，请先用 goal_update 补充可验证标准"}

当前阶段：
${steps || "- 尚未设置，请根据上下文创建阶段"}

checkpoint: ${JSON.stringify(goal.checkpoint)}
progress: ${JSON.stringify(goal.progress)}

执行规则：
1. 先检查最新会话、产物、后台结果和阶段状态，然后立即执行下一个可推进的动作。
2. 使用 goal_update 动态更新 steps、checkpoint 和 progress，记录实际证据。
3. 只有所有验收标准都有证据时才设为 completed。确实无法继续时设为 blocked；需要用户时请求输入，不要空转。
4. 本轮结束前必须更新 Goal，否则系统会将重复无进展计入循环保护。
</goal-continuation>`;
}
