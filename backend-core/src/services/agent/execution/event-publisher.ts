import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { Envelope } from "../../../contracts/events.js";
import type { AgentMailboxMessage } from "../../../contracts/storage/agent-mailbox-repository.js";
import type { ExecutionTaskStatus } from "../../../contracts/execution/execution.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { OutboxRow } from "../../../contracts/conversation-store/index.js";
import type { RuntimeRecordEnvelopeInput } from "../../../contracts/storage/runtime-storage.js";

interface ExecutionEventContext {
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  /**
   * 父 agent 的 call_id：child run 非空（指向发起委派的父 agent），root run 为空。
   * 新协议 agent_started/stream_output/tool 靠它（lineage.parent_call_id）把子 agent 嵌套到父——
   * agent-protocol execution-tree 据此重建 ReAct 树，缺失则子 agent 沦为平级 root。
   */
  parentCallId?: string | null | undefined;
  agent: AgentConfig;
  // run 自己的 thread 归属：root run="root"，child run="child:<id>"。
  // observation/intent 消息按此落到对应 thread，续聊 prepare 才能重建完整上下文。
  threadKey: string;
  childAgentId?: string | null | undefined;
}

/**
 * 把 ExecutionEventContext 的公共字段投影到 envelope 顶层 + payload.lineage。
 * child run 带 lineage.parent_call_id（挂父）与顶层 participant_id（参与者线程直路由）；root run 均不带。
 * 注：生产中本函数只服务 root run 的生命周期帧（buildRootAgentStart）；子 run 的锚点帧
 * agent_started 来自 delegation/events.ts 的 buildAgentCallStart（自行盖章 participant_id）。
 * 此处的 participant_id 投影是统一口径的预留位——任何后续经此发布的 child 生命周期帧自动带章。
 */
function contextMarkers(input: ExecutionEventContext): {
  top: { run_id: string; agent_id: string; call_id: string; participant_id?: string };
  lineage: { parent_call_id?: string } | undefined;
} {
  const lineage = input.parentCallId ? { parent_call_id: input.parentCallId } : undefined;
  return {
    top: {
      run_id: input.runId,
      agent_id: input.agent.agent_name,
      call_id: input.rootCallId,
      ...(input.childAgentId ? { participant_id: input.childAgentId } : {}),
    },
    lineage,
  };
}

export class AgentExecutionEventPublisher {
  constructor(
    private readonly clientEvents: ClientEventPublisher,
  ) {}

  /** 底层 client-event 端口：插件工具上下文等组装场景需要原始端口（非翻译后 Envelope 发布面）。 */
  get clientEventPort(): ClientEventPublisher {
    return this.clientEvents;
  }

  buildRunStarted(sessionId: string, runId: string, payload: { request_id?: string; task?: string; source?: string }): Envelope {
    return {
      type: "run_started",
      session_id: sessionId,
      run_id: runId,
      payload: { request_id: payload.request_id, task: payload.task, ...(payload.source ? { source: payload.source } : {}) },
    };
  }

  buildRootAgentStart(input: ExecutionEventContext & { task: string }): Envelope {
    const { top, lineage } = contextMarkers(input);
    return {
      type: "agent_started",
      session_id: input.sessionId,
      ...top,
      // 顶层 timestamp（ISO）供前端执行树推 agent 工作时长（"已工作 X 分 X 秒"）。
      timestamp: new Date().toISOString(),
      payload: { phase: "start", task: input.task, display_name: input.agent.display_name || input.agent.agent_name, lineage },
    };
  }

  publishUserInterrupt(status: ExecutionTaskStatus, reason: string): void {
    const sessionId = status.session_id;
    if (!sessionId) {
      return;
    }
    this.publish(sessionId, {
      type: "abort",
      session_id: sessionId,
      ...(status.run_id ? { run_id: status.run_id } : {}),
      payload: { scope: "run", reason },
    }, false);
  }

  /**
   * 推单条已翻译的 Envelope。DurableClientEventPublisher 在同一事务内完成
   * protocol.envelope.v1 归档与 outbox 写入，再投递到 WS。
   */
  publishEnvelope(envelope: Envelope): void {
    void this.commitEnvelope(envelope).catch(() => undefined);
  }

  /** Durable journal path: resolves only after outbox/Run Step commit. */
  commitEnvelope(envelope: Envelope): Promise<void> {
    return this.commit(typeof envelope.session_id === "string" ? envelope.session_id : "", envelope);
  }

  /**
   * Ephemeral journal path: 直发实时总线，不落 outbox（流式增量/在飞轮快照等展示帧）。
   * 不与 durable 帧保序（见 DurableClientEventPublisher.publishEphemeral）——依赖
   * ephemeral→durable 先后语义的调用方必须自带收尾兜底（如压缩 started 丢失仅损失
   * 瞬态指示，durable summary/终端帧才是真相）；部署无实时通道时降级 durable 兜底。
   */
  publishEphemeralEnvelope(envelope: Envelope): Promise<void> {
    const sessionId = typeof envelope.session_id === "string" ? envelope.session_id : "";
    if (this.clientEvents.publishEphemeral) {
      return this.clientEvents.publishEphemeral(sessionId, envelope);
    }
    return this.commit(sessionId, envelope);
  }

  /**
   * 推 delegate_call（委托执行指令）：落 outbox + realtime fanout（经统一投递路径，符合 outbox 架构契约）。
   * ws.ts 回放过滤 delegate_call（委托实时双向，重连时 in-flight 已失效，不回放）。
   * 由委托壳 Tool.call 在 gate 通过后调用，驱动宿主执行；与 tool_call（纯投影通知）分离。
   */
  publishDelegateCall(input: {
    sessionId: string;
    runId: string;
    callId: string;
    agentId: string;
    tool: string;
    arguments: Record<string, unknown>;
    parentCallId?: string | null;
  }): void {
    void this.commitDelegateCall(input).catch(() => undefined);
  }

  commitDelegateCall(input: {
    sessionId: string;
    runId: string;
    callId: string;
    agentId: string;
    tool: string;
    arguments: Record<string, unknown>;
    parentCallId?: string | null;
  }): Promise<void> {
    return this.commitEnvelope({
      type: "delegate_call",
      session_id: input.sessionId,
      run_id: input.runId,
      call_id: input.callId,
      agent_id: input.agentId,
      payload: {
        tool: input.tool,
        input: input.arguments,
        phase: "request",
        ...(input.parentCallId ? { lineage: { parent_call_id: input.parentCallId } } : {}),
      },
    });
  }

  publishAgentMessage(input: {
    sessionId: string;
    runId: string;
    callId?: string | null;
    message: AgentMailboxMessage;
  }): void {
    void this.commitAgentMessage(input).catch(() => undefined);
  }

  /** Durable journal path for mailbox inputs and their message boundary. */
  commitAgentMessage(input: {
    sessionId: string;
    runId: string;
    callId?: string | null;
    message: AgentMailboxMessage;
  }): Promise<void> {
    return this.commitEnvelope(this.buildAgentMessage(input));
  }

  buildAgentMessage(input: {
    sessionId: string;
    runId: string;
    callId?: string | null;
    message: AgentMailboxMessage;
  }): Envelope {
    const message = input.message;
    const metadata = message.metadata ?? {};
    const targetParentCallId = typeof metadata.target_parent_call_id === "string"
      ? metadata.target_parent_call_id
      : null;
    const targetParentAgentCallId = typeof metadata.target_parent_agent_call_id === "string"
      ? metadata.target_parent_agent_call_id
      : null;
    const targetRootRunId = typeof metadata.target_root_run_id === "string"
      ? metadata.target_root_run_id
      : null;
    const targetAgentName = typeof metadata.target_agent_name === "string"
      ? metadata.target_agent_name
      : null;
    const sourceAgentName = typeof metadata.source_agent_name === "string"
      ? metadata.source_agent_name
      : null;
    const sourceChildAgentId = typeof metadata.source_child_agent_id === "string"
      ? metadata.source_child_agent_id
      : null;
    const direction = metadata.direction === "parent_to_child" || metadata.direction === "child_to_parent"
      ? metadata.direction
      : null;
    return {
      type: "agent_message",
      session_id: input.sessionId,
      run_id: input.runId,
      ...(input.callId ? { call_id: input.callId } : {}),
      message_id: message.message_id,
      payload: {
        kind: message.kind,
        message_id: message.message_id,
        source_run_id: message.source_run_id,
        source_agent_call_id: message.source_agent_call_id,
        ...(sourceAgentName ? { source_agent_name: sourceAgentName } : {}),
        source_child_agent_id: sourceChildAgentId,
        target_run_id: message.target_run_id,
        target_agent_call_id: message.target_agent_call_id,
        target_child_agent_id: message.target_child_agent_id,
        target_thread_key: message.target_thread_key,
        target_parent_call_id: targetParentCallId,
        target_parent_agent_call_id: targetParentAgentCallId,
        target_root_run_id: targetRootRunId,
        ...(targetAgentName ? { target_agent_name: targetAgentName } : {}),
        ...(direction ? { direction } : {}),
        correlation_id: message.correlation_id,
        reply_to_message_id: message.reply_to_message_id,
        content: message.content_parts
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join(""),
        content_parts: message.content_parts,
        metadata: message.metadata,
      },
    };
  }

  prepareEnvelope(envelope: Envelope, eventId: string): RuntimeRecordEnvelopeInput {
    return this.clientEvents.prepare(envelope.session_id, envelope, {
      eventId,
      runId: envelope.run_id ?? null,
      aggregateType: envelope.run_id ? "run" : "session",
      aggregateId: envelope.run_id ?? envelope.session_id,
      requireRunLease: Boolean(envelope.run_id),
    });
  }

  deliver(rows: OutboxRow[]): Promise<void> {
    return this.clientEvents.deliver(rows);
  }


  private publish(sessionId: string, event: Envelope, requireRunLease = true): void {
    void this.commit(sessionId, event, requireRunLease).catch(() => undefined);
  }

  private async commit(sessionId: string, event: Envelope, requireRunLease = true): Promise<void> {
    await this.clientEvents.publish(sessionId, event, {
        runId: typeof event.run_id === "string" ? event.run_id : null,
        aggregateType: typeof event.run_id === "string" ? "run" : "session",
        aggregateId: typeof event.run_id === "string" ? event.run_id : sessionId,
        ...(requireRunLease && typeof event.run_id === "string" ? { requireRunLease: true } : {}),
      });
  }

}
