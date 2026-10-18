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
  EnqueueAgentMailboxMessageInput,
} from "../../../contracts/storage/agent-mailbox-repository.js";
import { mailboxRetryBackoffMs } from "../../../contracts/storage/agent-mailbox-repository.js";
import type { ExecutionResultReader } from "../../../contracts/execution/execution-storage.js";
import type { ExecutionSessionPort } from "../../../contracts/session/session-application.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import type { Goal, GoalContinuationReason, GoalStore } from "../../../contracts/runtime/goals.js";
import { isCurrentGoalContinuation } from "../../../contracts/runtime/goals.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { ParticipantRunLifecyclePort } from "../delegation/port.js";
import { terminalReasonDisplay } from "../../../contracts/storage/runtime-finalization.js";
import { toSessionIdentity, type SessionIdentity } from "../../../contracts/session/session.js";
import { resolveExecutionAgentFor, type ReadinessResolution } from "./readiness.js";
import { readSessionRequestOverrides, type SessionRequestOverrides } from "./session-request-overrides.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { TenantId } from "../../../identity/types.js";
import { checkSessionBusy } from "./session-business.js";

/** 消费组件错误日志出口（与 AgentDelegationLogger 同形）；缺省落 console.error，不静默。 */
export interface SessionMailboxLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

const consoleMailboxLogger: SessionMailboxLogger = {
  error: (bindings, message) => {
    const detail = Object.entries(bindings)
      .map(([key, value]) => `${key}=${value instanceof Error ? value.message : String(value)}`)
      .join(" ");
    console.error(`[session-mailbox-consumer] ${message}${detail ? ` ${detail}` : ""}`);
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 统一队列的消费组件（§10.4 第五/六/七轮定稿）：交付只有按收件分支一个谓词。
 *
 * - 主分支（root）：会话空闲检查（onSessionIdle / triggerBgNotificationRun）为闸门——
 *   认领 root 分支在途行，空闲则一个 run 全量消化（头行引用、伴随行物化）；
 *   运行中由活动 run 的 refresh 认领（runtime-adapter，不在此组件内）。
 * - 子分支（child:<id>）：收件人唤醒（triggerAgentMailboxRun）为闸门——查该线程
 *   现任执行（getLatestThreadRun），无活动执行则认领头行起接续 run。唤醒是
 *   无状态敲门：触发可多源并发重复，认领互斥天然分出胜负，本地 Map 仅作性能
 *   合并，不承担正确性。
 * - run 级簿记（replacesRunId / participantExpectedLastRunId / mailboxTargetRunId
 *   透传 / findPendingMailboxTarget 过期重解析）已全部退役：对话上下文=线程历史，
 *   每次执行自行读取。
 * - 触发闭环兜底：core-runtime-container 周期扫描有排队行的会话补触发
 *   （listPendingSessions），事件链崩溃后行不滞留。
 */
export class SessionMailboxConsumer {
  private readonly idleLaunches = new Map<string, IdleLaunchState>();
  private readonly mailboxLaunches = new Map<string, MailboxLaunchState>();

  constructor(private readonly deps: SessionMailboxConsumerDeps) {}

  private logError(bindings: Record<string, unknown>, message: string): void {
    (this.deps.logger ?? consoleMailboxLogger).error(bindings, message);
  }

  /**
   * BackgroundTaskService 的单一 session-level trigger 消费者。本地 Map 合并同一进程的
   * 重复 idle 事件（处理中到达的触发合并为一次补跑），GoalStore.claimContinuation 再用
   * 持久化 generation/pending 防止多实例重复续跑。主智能体空闲（无活动 root run、
   * 无它自己发起的后台任务）时，active Goal 才会续跑（§10.4 第五轮）。
   */
  triggerBgNotificationRun(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    const existing = this.idleLaunches.get(normalizedSessionId);
    if (existing) {
      existing.dirty = true;
      return;
    }
    const state: IdleLaunchState = { dirty: false };
    this.idleLaunches.set(normalizedSessionId, state);
    void this.startSessionIdleRun(normalizedSessionId)
      .catch((error) => {
        this.logError({ sessionId: normalizedSessionId, error: errorMessage(error) }, "session idle run failed");
      })
      .finally(() => {
        if (this.idleLaunches.get(normalizedSessionId) !== state) return;
        this.idleLaunches.delete(normalizedSessionId);
        if (state.dirty) this.triggerBgNotificationRun(normalizedSessionId);
      });
  }

  /**
   * 收件人唤醒（纯线程寻址）：无状态调用该线程的闸门。并发重复触发由认领互斥分出
   * 胜负；本地 Map 只合并同进程在飞的触发（性能优化，非正确性依赖）。
   */
  triggerAgentMailboxRun(target: AgentMailboxWakeupTarget): void {
    // ?? 兜底：目标形状由多方构造，缺字段时按空串短路而非抛 TypeError（曾致
    // 测试桩噪音），正确调用方不受影响。
    const sessionId = (target.sessionId ?? "").trim();
    const threadKey = (target.targetThreadKey ?? "").trim();
    if (!sessionId || !threadKey) return;
    // root 分支的唯一闸门是空闲检查（批量消化/单舞台），不走线程闸门。
    if (threadKey === "root") {
      this.triggerBgNotificationRun(sessionId);
      return;
    }
    const key = `${sessionId}:${threadKey}`;
    const existing = this.mailboxLaunches.get(key);
    if (existing) {
      existing.dirty = true;
      return;
    }
    const state: MailboxLaunchState = { target: { ...target, sessionId, targetThreadKey: threadKey }, dirty: false };
    this.mailboxLaunches.set(key, state);
    void this.drainThreadMailbox(state)
      .catch((error) => {
        this.logError({ sessionId, threadKey, error: errorMessage(error) }, "agent mailbox drain failed");
      })
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
    // 完成路径与恢复扫描可能竞写同一确定性 id：先查复用，消灭同 id 异形状的
    // 第二写方（已存在的排队行只需唤醒，认领中的行正在被消费）。
    const resultMessageId = `${input.sourceRunId}:terminal_result`;
    const existing = await mailbox.get(input.sessionId, resultMessageId);
    if (existing) {
      if (existing.status === "queued") this.wakeRowRecipient(existing);
      return;
    }
    const repliedMessage = input.replyToMessageId && !input.correlationId
      ? await mailbox.get(input.sessionId, input.replyToMessageId)
      : null;
    const content = input.outcome.content.trim()
      || (input.outcome.success ? "子 Agent 已完成消息处理" : "子 Agent 消息处理失败");
    let queued: AgentMailboxMessage;
    try {
      queued = await mailbox.enqueue({
        messageId: resultMessageId,
        tenantId: this.deps.tenantId,
        sessionId: input.sessionId,
        sourceRunId: input.sourceRunId,
        sourceAgentCallId: input.sourceAgentCallId,
        // 地址=纯分支（§10.4 第七轮）：run 引用仅作溯源审计留在 metadata。
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
          target_run_id: parent.run_id,
          target_agent_call_id: parent.agent_call_id,
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
    } catch (error) {
      // 先查复用消灭了大部分同 id 竞写，但两次 outcome 内容不同时存储层仍按
      // identity 冲突拒绝插入——回读既有行复用（先到者胜），不上抛。
      const raced = await mailbox.get(input.sessionId, resultMessageId).catch(() => null);
      if (!raced) throw error;
      queued = raced;
    }
    this.wakeRowRecipient(queued);
  }

  /** 行→收件线程唤醒：root 分支走空闲检查闸门，子分支走线程闸门。 */
  private wakeRowRecipient(row: AgentMailboxMessage): void {
    if (row.target_thread_key === "root") {
      this.triggerBgNotificationRun(row.session_id);
      return;
    }
    this.triggerAgentMailboxRun({
      sessionId: row.session_id,
      targetThreadKey: row.target_thread_key,
      targetChildAgentId: row.target_child_agent_id,
    });
  }

  private async drainThreadMailbox(state: MailboxLaunchState): Promise<void> {
    for (;;) {
      state.dirty = false;
      const disposition = await this.startThreadRun(state.target);
      if (disposition === "deferred") {
        if (state.dirty) continue;
        return;
      }
      if (disposition !== "completed") return;
      const pending = await this.deps.mailbox?.listPending?.({
        sessionId: state.target.sessionId,
        targetThreadKey: state.target.targetThreadKey,
        targetChildAgentId: state.target.targetChildAgentId,
        limit: 1,
      }) ?? [];
      const next = pending[0];
      if (!next) return;
      state.target = {
        sessionId: state.target.sessionId,
        targetThreadKey: state.target.targetThreadKey,
        targetChildAgentId: next.target_child_agent_id ?? state.target.targetChildAgentId,
      };
    }
  }

  /**
   * 子线程闸门（§10.4 第七轮）：一次决策只做三件事——查线程现任执行、认领在途
   * 头行、无活动执行则以该行为初始输入起接续 run。不携带也不比较任何 run 级
   * 预期值；并发触发由认领互斥分出胜负，现任执行运行中则交给其 refresh。
   */
  private async startThreadRun(target: AgentMailboxWakeupTarget): Promise<MailboxLaunchDisposition> {
    const { backgroundTasks, mailbox, runReader, sessions, invocationService, participantRuns } = this.deps;
    if (!mailbox || !runReader) return "skipped";
    const getLatestThreadRun = this.deps.runtimeStorage.operations.getLatestThreadRun;
    if (!getLatestThreadRun) return "skipped";
    const latest = await getLatestThreadRun.call(this.deps.runtimeStorage.operations, target.sessionId, target.targetThreadKey);
    if (!latest) {
      // 线程无执行历史：正常数据流不可达（委派先建 run、bgnotify 发起者取自运行
      // 线程），多为手工写库/损坏数据。认领计一次 attempt 后释放，让队列死信
      // 机制封顶空转，而不是 60s 扫描无限重敲。
      const orphans = await mailbox.claim({
        sessionId: target.sessionId,
        targetThreadKey: target.targetThreadKey,
        ...(target.targetChildAgentId ? { targetChildAgentId: target.targetChildAgentId } : {}),
        claimId: `thread_gate_${randomUUID()}`,
        consumerId: `thread_gate:${process.pid}:${randomUUID()}`,
        limit: 1,
      });
      if (orphans[0]) {
        await this.releaseNotifications(target.sessionId, [orphans[0]], new Error("thread has no run history"));
      }
      return "skipped";
    }
    if (latest.status === "running" || latest.status === "suspended") return "deferred";
    const claimed = await mailbox.claim({
      sessionId: target.sessionId,
      targetThreadKey: target.targetThreadKey,
      ...(target.targetChildAgentId ? { targetChildAgentId: target.targetChildAgentId } : {}),
      claimId: `thread_gate_${randomUUID()}`,
      consumerId: `thread_gate:${process.pid}:${randomUUID()}`,
      limit: 1,
    });
    const source = claimed[0];
    if (!source) return "skipped";
    let claimedRows: AgentMailboxMessage[] = [source];
    const session = await sessions.getSession(target.sessionId);
    if (!session) {
      await this.releaseNotifications(target.sessionId, claimedRows, new Error("session not found"));
      return "skipped";
    }
    const sessionIdentity = toSessionIdentity(session);
    // 子 Agent 续走自己的 tier 配置（会话级设定只作用于主智能体）；Agent 解析与
    // 其他渠道共用 resolveExecutionAgentFor（agentName 来自线程现任 run 记录）。
    const ready = resolveExecutionAgentFor(this.deps.runtimeCore, {
      agentName: latest.agent_name,
      teamSnapshot: sessionIdentity.teamSnapshot,
      selectedLlm: null,
    });
    if (!ready.ok) {
      await this.releaseNotifications(target.sessionId, claimedRows, new Error("readiness failed"));
      return "skipped";
    }
    const childAgentId = target.targetChildAgentId ?? latest.child_agent_id ?? undefined;
    const { runId, taskId, rootCallId } = mailboxContinuationIds({
      sessionId: target.sessionId,
      threadKey: target.targetThreadKey,
      childAgentId: childAgentId ?? null,
      sourceMessageId: source.message_id,
    });
    const task = "处理来自 Agent 的消息，并继续当前任务。";
    let participantRegistered = false;
    try {
      if (childAgentId) {
        await participantRuns.registerParticipantRun({
          sessionId: target.sessionId,
          childAgentId,
          runId,
          agentCallId: rootCallId,
          rootRunId: runId,
          parentRunId: latest.parent_run_id,
          parentCallId: latest.parent_call_id,
          lineageParentCallId: latest.lineage_parent_call_id,
        });
        participantRegistered = true;
      }
      const started = invocationService.invoke({
        mode: "create",
        execution: "background",
        sessionId: target.sessionId,
        sessionIdentity,
        runId,
        taskId,
        rootCallId,
        requestId: `${MAILBOX_CONTINUATION_REQUEST_PREFIX}${source.message_id}`,
        task,
        // 线程续接无父工具上下文可继承，回退会话 owner 作为 run 用户身份。
        userId: sessionIdentity.ownerUserId,
        executionKind: "system.agent_message",
        agent: ready.agent,
        provider: ready.provider,
        modelName: ready.modelName,
        scope: "child",
        startedAt: new Date(),
        threadKey: target.targetThreadKey,
        rootRunId: runId,
        interactionRootCallId: rootCallId,
        parentRunId: latest.parent_run_id,
        parentCallId: latest.parent_call_id,
        lineageParentCallId: latest.lineage_parent_call_id,
        childAgentId: childAgentId ?? null,
        initialMessage: mailboxContinuationInitialMessage(source, runId),
        initialMailboxMessageId: source.message_id,
        ownsRunLease: true,
      });
      await started.durableStarted;
      claimedRows = [];
      const outcome = await started.promise;
      if (childAgentId && !outcome.suspended) {
        await this.completeAgentMailboxContinuation({
          sessionId: target.sessionId,
          sourceRunId: runId,
          sourceAgentCallId: rootCallId,
          sourceAgentName: latest.agent_name ?? ready.agent.agent_name,
          sourceChildAgentId: childAgentId,
          parentRunId: latest.parent_run_id,
          correlationId: source.correlation_id,
          replyToMessageId: source.reply_to_message_id ?? source.message_id,
          outcome,
        });
      }
      return outcome.suspended ? "skipped" : "completed";
    } catch (error) {
      await this.releaseNotifications(target.sessionId, claimedRows, error);
      claimedRows = [];
      throw error;
    } finally {
      if (participantRegistered && childAgentId) {
        participantRuns.releaseParticipantRun({ childAgentId, runId });
      }
      backgroundTasks?.scheduleAutoTrigger(target.sessionId);
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
          || !run.run_id.startsWith("mailbox_")
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
          if (existingResult.status === "queued") this.wakeRowRecipient(existingResult);
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
          replyToMessageId: sourceMessage.reply_to_message_id ?? sourceMessageId,
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
    let claimedMessages: AgentMailboxMessage[] = [];
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
      // 交付只看收件分支（§10.4 第六/七轮）：子分支行转发线程闸门——运行中由其
      // refresh 认领，已终止由闸门起接续。转发先于 busy 早退：主分支 run 运行期间
      // 子分支行仍须有消费者（bgnotify 路由发起者后，root 繁忙不能阻塞子分支的
      // 通知交付，否则滞留无上界）；root 分支行留给下方主智能体闸门消化。
      const pendingMailbox = await mailbox?.listPending?.({ sessionId, limit: 100 }) ?? [];
      for (const message of pendingMailbox) {
        if (message.target_thread_key !== "root") this.wakeRowRecipient(message);
      }
      const busyEarly = await checkSessionBusy(
        { statusTracker, runtimeStorage: this.deps.runtimeStorage, backgroundTasks },
        sessionId,
      );
      if (busyEarly) {
        await markReason(busyEarly.reason === "run" ? "run_still_running" : "background_tasks_running");
        return;
      }
      const hasIdleMessages = pendingMailbox.some((message) => message.target_thread_key === "root");
      // goal 行存在性走全量查询：listPending 只有 FIFO 头 100 条，root 积压超窗时
      // 最新投递的 goal 行不可见，按窗口判断会重复生产新一代行、双计预算。
      const hasQueuedGoal = await mailbox?.existsPending?.({ sessionId, inputType: "goal_continuation", targetThreadKey: "root" })
        ?? pendingMailbox.some((message) => message.input_type === "goal_continuation");
      if (!hasIdleMessages && currentGoal?.status !== "active") {
        if (currentGoal) await markReason(currentGoal.status === "paused" ? "manual_paused" : "goal_not_active");
        return;
      }

      const existingSession = await sessions.getSession(sessionId);
      if (!existingSession) return;
      const sessionIdentity = toSessionIdentity(existingSession);
      // 主智能体的一切拉起渠道（用户补跑/通知/goal）同走会话级设定（用户此前选定的模型与档位）。
      const overrides = readSessionRequestOverrides(sessionIdentity.metadata);
      const ready = resolveExecutionAgentFor(this.deps.runtimeCore, {
        teamSnapshot: sessionIdentity.teamSnapshot,
        selectedLlm: overrides.selectedLlm,
      });
      if (!ready.ok) {
        await markReason("readiness_failed");
        return;
      }

      // Session/agent readiness may require storage I/O. Claim only after those checks pass so a
      // configuration failure or an intervening user run does not consume a continuation attempt.
      const busyAfterReady = await checkSessionBusy(
        { statusTracker, runtimeStorage: this.deps.runtimeStorage, backgroundTasks },
        sessionId,
      );
      if (busyAfterReady) {
        await markReason(busyAfterReady.reason === "run" ? "run_still_running" : "background_tasks_running");
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
      // 队列投递一条 goal_continuation 等待行（地址=主分支，§10.4 第六轮），
      // 消费与其他系统消息同通道（claim → 合并渲染 → durableStarted 后 ack）。
      // 循环由队列本身串行化：行被消费才起 run，run 终态（scheduleAutoTrigger）
      // 才触发下一轮生产。预算已在 claim 时计数，工作由持久行承载，投递成功即释放认领。
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
      const busyAfterClaim = await checkSessionBusy(
        { statusTracker, runtimeStorage: this.deps.runtimeStorage, backgroundTasks },
        sessionId,
      );
      if (busyAfterClaim) {
        await markReason(busyAfterClaim.reason === "run" ? "run_still_running" : "background_tasks_running");
        return;
      }
      claimedMessages = await this.claimIdleMessages(sessionId);
      // goal 行消费前复核：生产后用户可能暂停/完成 goal，失效行 settle 跳过，
      // 不对着过期快照多跑一轮。
      if (claimedMessages.some((message) => message.input_type === "goal_continuation")) {
        const latestGoal = await goalStore?.getCurrent(sessionId) ?? null;
        const stale = claimedMessages.filter((row) => row.input_type === "goal_continuation"
          && !isCurrentGoalContinuation(latestGoal, row.metadata));
        if (stale.length) {
          for (const message of stale) {
            try {
              await mailbox?.settle({ sessionId, messageId: message.message_id });
            } catch {
              // settle 失败由租约到期兜底回队。
            }
          }
          const staleIds = new Set(stale.map((row) => row.message_id));
          claimedMessages = claimedMessages.filter((row) => !staleIds.has(row.message_id));
          if (latestGoal && latestGoal.status !== "active" && goalStore?.setContinuationReason) {
            await goalStore.setContinuationReason(
              sessionId,
              latestGoal.id,
              latestGoal.status === "paused" ? "manual_paused" : "goal_not_active",
            );
          }
          // A resume may have invalidated the only queued continuation. Produce a fresh one
          // on the next idle pass instead of waiting for an unrelated notification.
          if (latestGoal?.status === "active") backgroundTasks?.scheduleAutoTrigger(sessionId);
        }
      }
      if (!claimedMessages.length) {
        const latestGoal = await goalStore?.getCurrent(sessionId) ?? null;
        if (latestGoal?.status === "active" && latestGoal.continuation_pending && goalStore?.setContinuationReason) {
          await goalStore.setContinuationReason(sessionId, latestGoal.id, "continuation_pending");
        }
        return;
      }
      // 交付给主智能体：一个 run 消化整批信件——头行直接作为初始消息（闸门事务内
      // settle，不合成第二条随机 id 行），同批其余行内容并入 task 并经
      // appendMailboxMessage 物化各自的会话消息行——所有行同载体，历史不缺内容。
      const head = claimedMessages[0];
      if (!head) return;
      const hasUserRows = claimedMessages.some((message) => message.input_type === "user_message");
      const goalRow = claimedMessages.find((message) => message.input_type === "goal_continuation") ?? null;
      const task = claimedMessages
        .map((message) => renderMailboxContentParts(message.content_parts))
        .filter(Boolean)
        .join("\n\n") || "处理待接收的用户消息，并继续当前任务。";
      const requestIdPrefix = head.input_type === "user_message"
        ? "session_followup_"
        : head.input_type === "goal_continuation"
          ? "goal_continue_"
          : "bg_notify_";
      const started = this.deps.launchSystemRun({
        sessionIdentity,
        // 系统触发的 root run 无请求 identity，回退会话 owner 作为 run 用户身份
        //（memory 等按 user 归属的工具依赖 ToolExecContext.userId）。
        userId: sessionIdentity.ownerUserId,
        requestId: `${requestIdPrefix}${head.message_id}`,
        task,
        executionKind: hasUserRows
          ? "session_followup"
          : goalRow
            ? "system.goal_continuation"
            : "system.bg_notification",
        ready,
        overrides,
        rootMailboxMessage: mailboxReferenceMessage(head),
      });
      const disposition = await started.durableStarted;
      if (disposition && typeof disposition === "object" && disposition.kind === "followup") {
        // 用户 run 抢先登台：整批行立即放回（无退避），由活动 run 的 refresh 按分支
        // 认领，不等认领租约过期（曾致该消息最多延迟 ~30s 注入）。
        await this.releaseNotifications(sessionId, claimedMessages, null, { immediate: true });
        claimedMessages = [];
        return;
      }
      // 头行已由闸门 settle；伴随行逐个物化（失败则回退认领态由 catch 释放退避回队）。
      const companions = claimedMessages.slice(1);
      claimedMessages = companions;
      for (const message of companions) {
        await this.deps.runtimeStorage.operations.appendMailboxMessage({
          session: sessionIdentity,
          mailboxMessage: claimedMailboxEnvelope(message),
        });
      }
      claimedMessages = [];
    } catch (error) {
      await this.releaseNotifications(sessionId, claimedMessages, error);
      claimedMessages = [];
      if (claimedGoal && goalStore?.setContinuationReason) {
        await goalStore.setContinuationReason(sessionId, claimedGoal.id, "continuation_start_failed");
      }
      throw error;
    } finally {
      if (releaseOwned) await releaseClaim();
    }
  }

  /**
   * 认领主智能体的全部信件（root 分支的用户消息/系统通知/goal 行）。认领口径=
   * 纯分支，不做类型筛选——交付只看收件人，不看消息种类。
   */
  private async claimIdleMessages(sessionId: string): Promise<AgentMailboxMessage[]> {
    const mailbox = this.deps.mailbox;
    if (!mailbox) return [];
    return mailbox.claim({
      sessionId,
      targetThreadKey: "root",
      claimId: `idle_deliver_${randomUUID()}`,
      consumerId: `idle_deliver:${process.pid}:${randomUUID()}`,
      limit: 100,
    });
  }

  /**
   * 消费失败释放：按已尝试次数指数退避（mailboxRetryBackoffMs）重排 available_at，
   * 与 claim 死信上限共同保证重投有界；租约到期兜底，释放失败无需补救。
   */
  private async releaseNotifications(
    sessionId: string,
    messages: AgentMailboxMessage[],
    error: unknown,
    options: { immediate?: boolean } = {},
  ): Promise<void> {
    const mailbox = this.deps.mailbox;
    if (!mailbox || !messages.length) return;
    // immediate 放回（followup 竞态）不带错误语义；String(null) 会产生字面量 "null"。
    const lastError = error == null ? "" : error instanceof Error ? error.message : String(error);
    for (const message of messages) {
      try {
        await mailbox.release({
          sessionId,
          messageId: message.message_id,
          claimId: message.claim_id ?? "",
          availableAt: options.immediate
            ? new Date().toISOString()
            : new Date(Date.now() + mailboxRetryBackoffMs(message.attempt_count)).toISOString(),
          ...(lastError ? { lastError } : {}),
        });
      } catch (releaseError) {
        this.logError(
          { sessionId, messageId: message.message_id, error: errorMessage(releaseError) },
          "mailbox release failed",
        );
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
  /** 错误日志出口；缺省 console.error，触发口异常不静默。 */
  logger?: SessionMailboxLogger | null;
}

/**
 * 消费组件发起的会话级系统 run 输入（经 launchSystemRun 钩子进入唯一组装点）。
 * 确定性 runId/taskId/rootCallId 由输入形状携带——幂等键在输入里，不在组装点外平行拼装。
 */
export interface SessionSystemRunInput {
  sessionIdentity: SessionIdentity;
  userId: string | null;
  requestId: string;
  task: string;
  executionKind: string;
  ready: Extract<ReadinessResolution, { ok: true }>;
  overrides: SessionRequestOverrides;
  /** 确定性幂等身份；缺省由 run-engine 生成。 */
  runId?: string;
  taskId?: string;
  rootCallId?: string;
  persistUserMessage?: AgentInvocationRootInput["persistUserMessage"];
  rootMailboxMessage?: AgentInvocationRootInput["rootMailboxMessage"];
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

interface IdleLaunchState {
  dirty: boolean;
}

type MailboxLaunchDisposition = "completed" | "deferred" | "skipped";

export const MAILBOX_CONTINUATION_REQUEST_PREFIX = "agent_result:";

export function mailboxContinuationSourceMessageId(requestId: string | null | undefined): string | null {
  const normalized = requestId?.trim() ?? "";
  if (!normalized.startsWith(MAILBOX_CONTINUATION_REQUEST_PREFIX)) return null;
  return normalized.slice(MAILBOX_CONTINUATION_REQUEST_PREFIX.length).trim() || null;
}

/** 排队/认领行 → root run 初始消息引用（followup/idle 消费共用）。携带行完整身份：
 * 闸门重建 enqueue 逐字段回传，定向行（kind/correlation 非空）也能过
 * sameMessageIdentity，不会撞 "id already belongs to another message"。 */
function mailboxReferenceMessage(message: AgentMailboxMessage): NonNullable<AgentInvocationRootInput["rootMailboxMessage"]> {
  return {
    id: message.message_id,
    inputType: message.input_type,
    sourceKind: message.source_kind,
    visibleToUser: message.visible_to_user,
    sentAt: message.sent_at,
    contentParts: message.content_parts,
    metadata: message.metadata,
    kind: message.kind,
    targetThreadKey: message.target_thread_key,
    targetRunId: message.target_run_id,
    targetAgentCallId: message.target_agent_call_id,
    targetChildAgentId: message.target_child_agent_id,
    sourceRunId: message.source_run_id,
    sourceAgentCallId: message.source_agent_call_id,
    correlationId: message.correlation_id,
    replyToMessageId: message.reply_to_message_id,
  };
}

/** 认领行 → 追加闸门信封（appendMailboxMessage 物化伴随行；字段逐项回传保证幂等命中）。 */
function claimedMailboxEnvelope(message: AgentMailboxMessage): EnqueueAgentMailboxMessageInput {
  return {
    messageId: message.message_id,
    tenantId: message.tenant_id,
    sessionId: message.session_id,
    sourceRunId: message.source_run_id,
    sourceAgentCallId: message.source_agent_call_id,
    targetRunId: message.target_run_id,
    targetAgentCallId: message.target_agent_call_id,
    targetThreadKey: message.target_thread_key,
    targetChildAgentId: message.target_child_agent_id,
    kind: message.kind,
    inputType: message.input_type,
    sourceKind: message.source_kind,
    visibleToUser: message.visible_to_user,
    sentAt: message.sent_at,
    correlationId: message.correlation_id,
    replyToMessageId: message.reply_to_message_id,
    contentParts: message.content_parts,
    metadata: message.metadata,
  };
}

/** 线程续跑的确定性幂等身份：同一线程同一头行崩溃重试得到同一 runId（§10.4 第七轮）。 */
function mailboxContinuationIds(target: {
  sessionId: string;
  threadKey: string;
  childAgentId: string | null;
  sourceMessageId: string;
}): {
  runId: string;
  taskId: string;
  rootCallId: string;
} {
  const digest = createHash("sha256")
    .update(`${target.sessionId}\0${target.threadKey}\0${target.childAgentId ?? ""}\0${target.sourceMessageId}`)
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
