import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import { randomUUID } from "node:crypto";

import type { DaemonBotRepository } from "../contracts/bot-repository.js";
import type { BotConfig, PlatformType } from "../contracts/bot.js";
import type { DaemonOutgoingMessage, DaemonTestMessage } from "../contracts/daemon.js";
import type { TenantId, UserId } from "@ragsystem/backend-core/identity/types.js";
import type { PermissionMode } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import type { DaemonRuntimeProvider } from "../contracts/daemon-runtime-provider.js";
import type { DaemonLeaderLease } from "../contracts/daemon-leader-lease.js";
import type { ApprovalMeta } from "@ragsystem/backend-core/contracts/runtime/pending-interactions.js";
import {
  buildApprovalCard,
  buildUserInputCard,
  createDispatcher,
  createFeishuClient,
  invokeWebhook,
  sendInteractiveCard,
  sendTextMessage,
  startLongConnection,
  type FeishuClient,
  type FeishuCardActionEvent,
  type FeishuDispatcher,
  type FeishuLongConnectionHandle,
  type FeishuMessageEvent,
} from "./platforms/feishu-adapter.js";

const DEDUP_TTL_MS = 5 * 60 * 1000;

export class DaemonServiceError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "DaemonServiceError";
  }
}

export interface DaemonRunAgentInput {
  tenantId: TenantId;
  botId: UserId;
  task: string;
  /** bot 绑定的 team；null 表示由运行时快照当前激活 team。 */
  team: string | null;
  entryAgent: string | null;
  sessionId: string;
  source: string;
  sessionMetadata?: Record<string, unknown>;
  permissionMode: PermissionMode;
  onInteractionRequired?: (interactions: DaemonSuspendedInteraction[]) => void;
}

export interface DaemonSuspendedInteraction {
  approvalId: string;
  sessionId: string;
  botId: UserId;
  rootRunId: string;
  kind: "approval" | "user_input";
  toolName?: string | undefined;
  riskLevel?: string | undefined;
  reason?: string | undefined;
  prompt?: string | undefined;
  options?: string[] | undefined;
}

export type DaemonRunAgentResult =
  | { suspended: false; content: string }
  | { suspended: true; content: ""; interaction: DaemonSuspendedInteraction; interactions?: DaemonSuspendedInteraction[]; interactionsDelivered?: boolean };

export type DaemonRunAgentTask = (input: DaemonRunAgentInput) => Promise<DaemonRunAgentResult> | DaemonRunAgentResult;

interface FeishuRuntime {
  client: FeishuClient;
  dispatcher: FeishuDispatcher;
  longConnection?: FeishuLongConnectionHandle;
}

interface BotRuntimeState {
  botId: UserId;
  tenantId: TenantId;
  config: BotConfig;
  feishuRuntime: FeishuRuntime | null;
  registeredRouteToken: string | null;
  processedMessageIds: Map<string, number>;
}

export interface DaemonServiceOptions {
  botRepository: DaemonBotRepository;
  registry: DaemonRuntimeProvider;
  runAgentTask: DaemonRunAgentTask;
  leaderLease?: DaemonLeaderLease;
}

export class DaemonService {
  private readonly states = new Map<UserId, BotRuntimeState>();
  private readonly stateInitializations = new Map<UserId, Promise<BotRuntimeState>>();
  private readonly reloads = new Map<UserId, Promise<void>>();
  private startPromise: Promise<void> | null = null;
  private leaderRetryTimer: NodeJS.Timeout | null = null;
  private leader = false;

  constructor(private readonly options: DaemonServiceOptions) {}

  async start(): Promise<void> {
    this.startPromise ??= this.initialize();
    await this.startPromise;
  }

  private async initialize(): Promise<void> {
    try {
      if (this.options.leaderLease && !(this.leader = await this.options.leaderLease.acquire())) {
        this.startLeaderRetry();
        return;
      }
      await this.initializeLeader();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private async initializeLeader(): Promise<void> {
    for (const config of await this.options.botRepository.listAllEnabledFeishu()) await this.rebuildBot(config);
  }

  private startLeaderRetry(): void {
    if (this.leaderRetryTimer || !this.options.leaderLease) return;
    this.leaderRetryTimer = setInterval(() => {
      void (async () => {
        if (this.leader || !this.options.leaderLease || !(await this.options.leaderLease.acquire())) return;
        this.leader = true;
        if (this.leaderRetryTimer) clearInterval(this.leaderRetryTimer);
        this.leaderRetryTimer = null;
        await this.initializeLeader();
      })().catch((error: unknown) => console.error("[daemon] leader lease retry failed", error));
    }, 5_000);
    this.leaderRetryTimer.unref();
  }

  async reloadBot(botId: UserId): Promise<void> {
    const previous = this.reloads.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.reloadBotNow(botId));
    this.reloads.set(botId, current);
    try {
      await current;
    } finally {
      if (this.reloads.get(botId) === current) this.reloads.delete(botId);
    }
  }

  private async reloadBotNow(botId: UserId): Promise<void> {
    await this.stateInitializations.get(botId)?.catch(() => undefined);
    const existing = this.states.get(botId);
    if (existing) this.disposeState(existing);
    this.states.delete(botId);
    const bot = await this.options.botRepository.get(botId);
    if (!bot || bot.status !== "active") return;
    const config = await this.options.botRepository.getRuntimeConfig(botId);
    if (!config) return;
    await this.rebuildBot(config);
  }

  async testMessage(botId: UserId, input: DaemonTestMessage): Promise<{ status: "ok"; message: string; session_id: string; result: string }> {
    const state = await this.ensureState(botId);
    const sessionId = resolveSessionId(state.config, input.platform, input.chat_id);
    const sessionMetadata = { chatId: input.chat_id };
    const result = await this.runAgent(state, input.content, sessionId, `daemon.${input.platform}.test`, state.config.entry_agent, sessionMetadata);
    if (result.suspended) {
      if (!result.interactionsDelivered) await this.sendSuspendedCards(state, suspendedInteractions(result), sessionMetadata);
    }
    return { status: "ok", message: "测试消息已执行", session_id: sessionId, result: result.content };
  }

  async sendMessage(botId: UserId, input: DaemonOutgoingMessage): Promise<{ status: "ok" | "failed"; message_id?: string; error?: string }> {
    const state = await this.ensureState(botId);
    return this.sendFeishuMessage(state, input.chat_id, "chat_id", input.content);
  }

  async handleIncomingMessage(routeToken: string, body: unknown): Promise<unknown> {
    const target = await this.options.botRepository.resolveWebhookTarget(routeToken);
    if (!target) throw new DaemonServiceError(404, "无效的飞书 webhook routeToken");
    const state = this.states.get(target.botId) ?? await this.ensureState(target.botId);
    if (!state || state.tenantId !== target.tenantId || state.registeredRouteToken !== routeToken) {
      throw new DaemonServiceError(404, "无效的飞书 webhook routeToken");
    }
    if (isRecord(body) && body.type === "url_verification" && typeof body.challenge === "string") return { challenge: body.challenge };
    if (!state.feishuRuntime) throw new DaemonServiceError(503, `飞书适配器未配置: ${target.botId}`);
    if (!isRecord(body)) throw new DaemonServiceError(400, "飞书 webhook 请求体必须为 JSON 对象");
    return (await invokeWebhook(state.feishuRuntime.dispatcher, body)) ?? { code: 0 };
  }

  close(): void {
    if (this.leaderRetryTimer) clearInterval(this.leaderRetryTimer);
    this.leaderRetryTimer = null;
    if (this.leader) {
      this.leader = false;
      void this.options.leaderLease?.release();
    }
    for (const state of this.states.values()) this.disposeState(state);
    this.states.clear();
    this.stateInitializations.clear();
    this.reloads.clear();
    this.startPromise = null;
  }

  private async ensureState(botId: UserId): Promise<BotRuntimeState> {
    const existing = this.states.get(botId);
    if (existing) return existing;
    const pending = this.stateInitializations.get(botId);
    if (pending) return pending;
    const initialization = this.requireBotConfig(botId).then((config) => this.rebuildBot(config));
    this.stateInitializations.set(botId, initialization);
    try {
      return await initialization;
    } finally {
      if (this.stateInitializations.get(botId) === initialization) this.stateInitializations.delete(botId);
    }
  }

  private async requireBotConfig(botId: UserId): Promise<BotConfig> {
    const bot = await this.options.botRepository.get(botId);
    if (!bot) throw new DaemonServiceError(404, "bot 不存在");
    if (bot.status !== "active") throw new DaemonServiceError(409, "bot 已禁用");
    const config = await this.options.botRepository.getRuntimeConfig(botId);
    if (!config) throw new DaemonServiceError(404, "bot 配置不存在");
    return config;
  }

  private async rebuildBot(config: BotConfig): Promise<BotRuntimeState> {
    const bot = await this.options.botRepository.get(config.bot_id);
    let resolvedConfig = config;
    if (config.enabled && config.feishu.enabled && config.feishu.receive_mode === "webhook" && !config.feishu.route_token) {
      await this.options.botRepository.updateConfig(config.bot_id, { feishu: { route_token: randomUUID().replaceAll("-", "") } });
      resolvedConfig = await this.requireBotConfig(config.bot_id);
    }
    const state: BotRuntimeState = {
      botId: resolvedConfig.bot_id,
      tenantId: resolvedConfig.tenant_id,
      config: resolvedConfig,
      feishuRuntime: null,
      registeredRouteToken: null,
      processedMessageIds: new Map(),
    };
    if (bot?.status === "active" && resolvedConfig.enabled && resolvedConfig.feishu.enabled) this.startFeishu(state);
    this.states.set(state.botId, state);
    return state;
  }

  private startFeishu(state: BotRuntimeState): void {
    const connection = state.config.feishu;
    if (!connection.app_id || !connection.app_secret) return;
    const client = createFeishuClient(connection);
    const dispatcher = createDispatcher(connection, {
      onMessage: (data) => this.onFeishuMessage(state, data),
      onCardAction: (data) => this.onFeishuCardAction(state, data),
    });
    const longConnection = connection.receive_mode === "long_connection" ? startLongConnection(client, dispatcher) : undefined;
    if (longConnection) void longConnection.started.catch((error: unknown) => console.error(`[daemon][feishu][${state.botId}] 长连接启动失败`, error));
    state.feishuRuntime = { client, dispatcher, ...(longConnection ? { longConnection } : {}) };
    if (connection.receive_mode === "webhook" && connection.route_token) {
      state.registeredRouteToken = connection.route_token;
    }
  }

  private disposeState(state: BotRuntimeState): void {
    state.feishuRuntime?.longConnection?.close();
    state.feishuRuntime = null;
    state.registeredRouteToken = null;
    state.processedMessageIds.clear();
  }

  private onFeishuMessage(state: BotRuntimeState, input: unknown): void {
    const data = input as FeishuMessageEvent;
    // 忽略机器人自身发出的消息事件，避免回复被再次当成用户输入，
    // 导致同一条飞书消息在前端出现多条 Agent 回复甚至形成回环。
    const senderType = data.sender?.sender_type?.trim().toUpperCase();
    if (senderType === "ASSISTANT" || senderType === "BOT") return;
    const messageId = data.message?.message_id;
    if (messageId) {
      const now = Date.now();
      this.purgeExpiredDedup(state, now);
      if (state.processedMessageIds.has(messageId)) return;
      state.processedMessageIds.set(messageId, now);
    }
    void this.processFeishuMessage(state, data).catch((error: unknown) => {
      console.error(`[daemon][feishu][${state.botId}] 消息处理失败`, error);
    });
  }

  private async onFeishuCardAction(state: BotRuntimeState, input: FeishuCardActionEvent): Promise<Record<string, unknown>> {
    const value = isRecord(input.action?.value) ? input.action.value : null;
    if (!value) {
      throw new DaemonServiceError(400, "飞书卡片回调缺少 action.value");
    }
    const botId = typeof value.botId === "string" ? value.botId : "";
    const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
    const kind = value.kind === "approval" || value.kind === "user_input" ? value.kind : null;
    const approvalId = typeof value.approvalId === "string"
      ? value.approvalId
      : typeof value.inputId === "string"
        ? value.inputId
        : "";
    if (botId !== state.botId || !sessionId || !kind || !approvalId) {
      throw new DaemonServiceError(400, "飞书卡片回调参数无效");
    }
    if (kind === "approval" && value.decision !== "approve" && value.decision !== "deny") {
      throw new DaemonServiceError(400, "飞书审批卡片 decision 无效");
    }
    if (kind === "user_input" && typeof value.value !== "string") {
      throw new DaemonServiceError(400, "飞书输入卡片 value 无效");
    }

    const lease = await this.options.registry.acquire(state.tenantId);
    let leaseReleased = false;
    let releaseByCallback = false;
    const releaseLease = (): void => {
      if (leaseReleased) return;
      leaseReleased = true;
      lease.release();
    };
    try {
      const resolution = kind === "approval"
        ? { approved: value.decision === "approve", message: value.decision === "approve" ? "飞书卡片已批准" : "飞书卡片已拒绝" }
        : { value: typeof value.value === "string" ? value.value : "" };
      let rootRunId = "";
      const callbacks = {
        onCompleted: (result: { content: string; success: boolean }) => {
          void (async () => {
            const metadata = (await lease.runtime.sessionApplication.getSession(sessionId))?.metadata ?? {};
            const chatId = resolveBotChatId(state.config, metadata);
            releaseLease();
            if (!chatId) return;
            const content = result.success ? result.content : `Agent 恢复执行失败：${result.content}`;
            await this.sendFeishuMessage(state, chatId, "chat_id", content);
          })().catch((error: unknown) => {
            releaseLease();
            console.error(`[daemon][feishu][${state.botId}] 恢复结果发送失败`, error);
          });
        },
        onSuspended: (nextApprovalId: string) => {
          void (async () => {
            const nextRootRunId = lease.runtime.interactionCoordinator.peekApprovalMeta(nextApprovalId, sessionId)?.rootRunId ?? rootRunId;
            const next = await lease.runtime.interactionCoordinator.listPendingAsync(nextRootRunId, sessionId);
            const metadata = (await lease.runtime.sessionApplication.getSession(sessionId))?.metadata ?? {};
            releaseLease();
            if (next.length === 0) return;
            await this.sendSuspendedCards(
              state,
              next.map((item) => toSuspendedInteraction(state.botId, item)),
              metadata,
            );
          })().catch((error: unknown) => {
            releaseLease();
            console.error(`[daemon][feishu][${state.botId}] 后续挂起卡片发送失败`, error);
          });
        },
      };
      const responded = kind === "approval"
        ? await lease.runtime.interactionCoordinator.respondApprovalAsync(
            sessionId,
            approvalId,
            resolution as { approved: boolean; message: string },
            callbacks,
          )
        : await lease.runtime.interactionCoordinator.respondUserInputAsync(
            sessionId,
            approvalId,
            resolution as { value: string },
            callbacks,
          );
      if (!responded.resolved) {
        throw new DaemonServiceError(404, "待处理交互不存在或已完成");
      }
      if (!responded.needsResume) {
        return { toast: { type: "success", content: "响应已提交" } };
      }

      rootRunId = responded.rootRunId ?? "";
      releaseByCallback = responded.resumeDisposition === "started" || responded.resumeDisposition === "deferred";
      return { toast: { type: "success", content: "已恢复 Agent 执行" } };
    } finally {
      if (!releaseByCallback) {
        releaseLease();
      }
    }
  }

  private async processFeishuMessage(state: BotRuntimeState, data: FeishuMessageEvent): Promise<void> {
    const message = data.message;
    const chatId = message?.chat_id;
    if (!message || !chatId || message.message_type !== "text" || !message.content) return;
    const parsedContent = JSON.parse(message.content) as unknown;
    const text = isRecord(parsedContent) && typeof parsedContent.text === "string" ? parsedContent.text.trim() : "";
    if (!text) return;
    const senderOpenId = data.sender?.sender_id?.open_id;
    const sessionMetadata = {
      chatId,
      ...(senderOpenId ? { sender_open_id: senderOpenId, feishu: { sender_open_id: senderOpenId } } : {}),
    };
    const result = await this.runAgent(
      state,
      text,
      resolveSessionId(state.config, "feishu", chatId),
      "daemon.feishu.incoming",
      state.config.entry_agent,
      sessionMetadata,
    );
    if (result.suspended) {
      if (!result.interactionsDelivered) await this.sendSuspendedCards(state, suspendedInteractions(result), sessionMetadata);
      return;
    }
    if (message.chat_type === "p2p") {
      if (!senderOpenId) throw new Error("单聊消息缺少 sender open_id,无法回复");
      const sent = await this.sendFeishuMessage(state, senderOpenId, "open_id", result.content);
      if (sent.status === "failed") throw new Error(sent.error ?? "飞书消息发送失败");
    } else {
      const sent = await this.sendFeishuMessage(state, chatId, "chat_id", result.content);
      if (sent.status === "failed") throw new Error(sent.error ?? "飞书消息发送失败");
    }
  }

  private async runAgent(
    state: BotRuntimeState,
    task: string,
    sessionId: string,
    source: string,
    entryAgent = state.config.entry_agent,
    sessionMetadata?: Record<string, unknown>,
  ): Promise<DaemonRunAgentResult> {
    const interactionDeliveries: Promise<void>[] = [];
    const result = await this.options.runAgentTask({
      tenantId: state.tenantId,
      botId: state.botId,
      task,
      team: state.config.team ?? null,
      entryAgent,
      sessionId,
      source,
      permissionMode: state.config.permission_mode,
      ...(sessionMetadata ? { sessionMetadata } : {}),
      onInteractionRequired: (interactions) => {
        interactionDeliveries.push(this.sendSuspendedCards(state, interactions, sessionMetadata ?? {}));
      },
    });
    const deliveryResults = await Promise.allSettled(interactionDeliveries);
    for (const delivery of deliveryResults) {
      if (delivery.status === "rejected") {
        console.error(`[daemon][feishu][${state.botId}] 审批卡片发送失败`, delivery.reason);
      }
    }
    const interactionsDelivered = deliveryResults.length > 0
      && deliveryResults.every((delivery) => delivery.status === "fulfilled");
    return result.suspended ? { ...result, interactionsDelivered } : result;
  }

  private async sendSuspendedCard(
    state: BotRuntimeState,
    interaction: DaemonSuspendedInteraction,
    sessionMetadata: Record<string, unknown>,
  ): Promise<void> {
    if (!state.feishuRuntime) {
      throw new Error("飞书适配器未配置");
    }
    const chatId = resolveBotChatId(state.config, sessionMetadata);
    if (!chatId) {
      throw new Error("挂起交互缺少飞书 chat_id，请配置 default_chat_id");
    }
    const cardSchema = interaction.kind === "approval"
      ? buildApprovalCard({
          approvalId: interaction.approvalId,
          sessionId: interaction.sessionId,
          botId: interaction.botId,
          toolName: interaction.toolName ?? "未知工具",
          riskLevel: interaction.riskLevel,
          reason: interaction.reason,
        })
      : buildUserInputCard({
          inputId: interaction.approvalId,
          sessionId: interaction.sessionId,
          botId: interaction.botId,
          prompt: interaction.prompt ?? "Agent 正在等待你的输入。",
          options: interaction.options,
        });
    await sendInteractiveCard(state.feishuRuntime.client, { chatId, cardSchema });
  }

  private async sendSuspendedCards(
    state: BotRuntimeState,
    interactions: DaemonSuspendedInteraction[],
    sessionMetadata: Record<string, unknown>,
  ): Promise<void> {
    for (const interaction of interactions) {
      await this.sendSuspendedCard(state, interaction, sessionMetadata);
    }
  }

  private async sendFeishuMessage(state: BotRuntimeState, receiveId: string, receiveIdType: "chat_id" | "open_id", content: string): Promise<{ status: "ok" | "failed"; message_id?: string; error?: string }> {
    if (!state.feishuRuntime) return { status: "failed", error: `飞书适配器未配置: ${state.botId}` };
    try {
      const response = await sendTextMessage(state.feishuRuntime.client, receiveId, receiveIdType, content);
      const messageId = readMessageId(response);
      return messageId ? { status: "ok", message_id: messageId } : { status: "ok" };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private purgeExpiredDedup(state: BotRuntimeState, now: number): void {
    for (const [id, timestamp] of state.processedMessageIds) if (now - timestamp > DEDUP_TTL_MS) state.processedMessageIds.delete(id);
  }
}

function resolveSessionId(config: BotConfig, platform: PlatformType, chatId: string): string {
  return config.session_id?.trim() || `bot-${safeSessionPart(config.bot_id)}-${platform}-${safeSessionPart(chatId)}`;
}

export function resolveBotChatId(
  config: BotConfig,
  sessionMetadata: Record<string, unknown>,
): string | null {
  const directChatId = readNonEmptyString(sessionMetadata.chatId);
  if (directChatId) return directChatId;
  const senderOpenId = readNonEmptyString(sessionMetadata.sender_open_id)
    ?? (isRecord(sessionMetadata.feishu) ? readNonEmptyString(sessionMetadata.feishu.sender_open_id) : null);
  if (senderOpenId) return senderOpenId;
  const defaultChatId = config.feishu.default_chat_id?.trim();
  return defaultChatId || null;
}

function toSuspendedInteraction(botId: UserId, meta: ApprovalMeta): DaemonSuspendedInteraction {
  return {
    approvalId: meta.approvalId,
    sessionId: meta.sessionId,
    botId,
    rootRunId: meta.rootRunId,
    kind: meta.kind,
    ...(meta.toolName ? { toolName: meta.toolName } : {}),
    ...(meta.riskLevel ? { riskLevel: meta.riskLevel } : {}),
    ...(meta.reason ? { reason: meta.reason } : {}),
    ...(meta.prompt ? { prompt: meta.prompt } : {}),
    ...(meta.options ? { options: meta.options } : {}),
  };
}

function suspendedInteractions(result: Extract<DaemonRunAgentResult, { suspended: true }>): DaemonSuspendedInteraction[] {
  return Array.isArray(result.interactions) && result.interactions.length > 0
    ? result.interactions
    : [result.interaction];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readMessageId(response: unknown): string | null {
  if (!isRecord(response)) return null;
  return isRecord(response.data) && typeof response.data.message_id === "string" ? response.data.message_id : null;
}

function safeSessionPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "default";
}
