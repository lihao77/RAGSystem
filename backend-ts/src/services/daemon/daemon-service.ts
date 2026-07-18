import { isRecord } from "../../utils/guards.js";
import { randomUUID } from "node:crypto";

import type { BotRepository } from "../../contracts/bot-repository.js";
import type { BotConfig, BotCronTask, BotCronTaskCreate, BotCronTaskUpdate, PlatformType } from "../../contracts/bot.js";
import type { DaemonOutgoingMessage, DaemonTestMessage } from "../../contracts/daemon.js";
import type { TenantId, UserId } from "../../identity/types.js";
import type { PermissionMode } from "../../contracts/permissions.js";
import type { TenantRuntimeRegistry } from "../runtime/tenant-runtime-registry.js";
import type { ApprovalMeta } from "../runtime/pending-interaction-service.js";
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
  cronHistory: Map<string, Array<Record<string, unknown>>>;
  processedMessageIds: Map<string, number>;
}

export interface DaemonServiceOptions {
  botRepository: BotRepository;
  registry: TenantRuntimeRegistry;
  runAgentTask: DaemonRunAgentTask;
}

export class DaemonService {
  private readonly states = new Map<UserId, BotRuntimeState>();
  private readonly cronLeaseOwner = randomUUID();
  private readonly stateInitializations = new Map<UserId, Promise<BotRuntimeState>>();
  private readonly reloads = new Map<UserId, Promise<void>>();
  private startPromise: Promise<void> | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerRunning = false;

  constructor(private readonly options: DaemonServiceOptions) {}

  async start(): Promise<void> {
    this.startPromise ??= this.initialize();
    await this.startPromise;
  }

  private async initialize(): Promise<void> {
    try {
      for (const config of await this.options.botRepository.listAllEnabledFeishu()) await this.rebuildBot(config);
      this.startScheduler();
    } catch (error) {
      this.close();
      throw error;
    }
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
    await this.rebuildBot(config, existing?.cronHistory);
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
    const target = this.options.registry.resolveRouteToken(routeToken);
    if (!target) throw new DaemonServiceError(404, "无效的飞书 webhook routeToken");
    const state = this.states.get(target.botId);
    if (!state || state.tenantId !== target.tenantId || state.registeredRouteToken !== routeToken) {
      throw new DaemonServiceError(404, "无效的飞书 webhook routeToken");
    }
    if (isRecord(body) && body.type === "url_verification" && typeof body.challenge === "string") return { challenge: body.challenge };
    if (!state.feishuRuntime) throw new DaemonServiceError(503, `飞书适配器未配置: ${target.botId}`);
    if (!isRecord(body)) throw new DaemonServiceError(400, "飞书 webhook 请求体必须为 JSON 对象");
    return (await invokeWebhook(state.feishuRuntime.dispatcher, body)) ?? { code: 0 };
  }

  async listBotCronTasks(botId: UserId): Promise<BotCronTask[]> {
    await this.requireBotConfig(botId);
    return this.options.botRepository.listCronTasks(botId);
  }

  async createBotCronTask(botId: UserId, task: BotCronTaskCreate): Promise<BotCronTask> {
    await this.requireBotConfig(botId);
    if (await this.options.botRepository.getCronTask(botId, task.task_id)) throw new DaemonServiceError(400, `任务已存在: ${task.task_id}`);
    const created = await this.options.botRepository.createCronTask(botId, { ...task, next_run: task.enabled ? computeNextRun(task.cron) : null });
    (await this.ensureState(botId)).cronHistory.set(task.task_id, []);
    return created;
  }

  async updateBotCronTask(botId: UserId, taskId: string, patch: BotCronTaskUpdate): Promise<BotCronTask | null> {
    const current = await this.options.botRepository.getCronTask(botId, taskId);
    if (!current) return null;
    const cron = patch.cron ?? current.cron;
    const enabled = patch.enabled ?? current.enabled;
    return this.options.botRepository.updateCronTask(botId, taskId, {
      ...compactCronPatch(patch),
      next_run: enabled ? computeNextRun(cron) : null,
    });
  }

  async deleteBotCronTask(botId: UserId, taskId: string): Promise<boolean> {
    const deleted = await this.options.botRepository.deleteCronTask(botId, taskId);
    if (deleted) this.states.get(botId)?.cronHistory.delete(taskId);
    return deleted;
  }

  async triggerBotCronTask(botId: UserId, taskId: string, claimToken?: string): Promise<{ status: "ok"; result: string | null }> {
    const state = await this.ensureState(botId);
    const task = await this.options.botRepository.getCronTask(botId, taskId);
    if (!task || !task.enabled) throw new DaemonServiceError(404, `任务不存在或未启用: ${taskId}`);
    const startedAt = Date.now();
    try {
      const sessionId = resolveSessionId(state.config, "feishu", `cron:${taskId}`);
      const sessionMetadata = { push_chat_id: task.push_chat_id };
      const result = await this.runAgent(state, task.task, sessionId, "daemon.cron", task.entry_agent ?? state.config.entry_agent, sessionMetadata);
      const now = Date.now() / 1000;
      if (result.suspended) {
        if (!result.interactionsDelivered) await this.sendSuspendedCards(state, suspendedInteractions(result), sessionMetadata, task);
      }
      await this.options.botRepository.updateCronTask(botId, taskId, {
        last_run: now,
        next_run: computeNextRun(task.cron),
        last_result: result.suspended ? "SUSPENDED" : result.content.slice(0, 200),
      }, claimToken ? { claimToken } : undefined);
      this.recordCronHistory(state, taskId, { timestamp: now, success: true, result: result.suspended ? "SUSPENDED" : result.content.slice(0, 200), error: null, elapsed: (Date.now() - startedAt) / 1000 });
      if (!result.suspended && task.push_platform && task.push_chat_id) {
        const sent = await this.sendMessage(botId, { platform: task.push_platform, chat_id: task.push_chat_id, content: result.content, message_type: "text" });
        if (sent.status === "failed") throw new Error(sent.error ?? "飞书消息发送失败");
      }
      return { status: "ok", result: result.content || null };
    } catch (error) {
      const now = Date.now() / 1000;
      const message = error instanceof Error ? error.message : String(error);
      await this.options.botRepository.updateCronTask(botId, taskId, {
        last_run: now,
        next_run: computeNextRun(task.cron),
        last_result: `ERROR: ${message}`,
      }, claimToken ? { claimToken } : undefined);
      this.recordCronHistory(state, taskId, { timestamp: now, success: false, result: "", error: message, elapsed: (Date.now() - startedAt) / 1000 });
      throw new DaemonServiceError(400, message);
    }
  }

  async getBotCronHistory(botId: UserId, taskId: string, limit: number): Promise<Array<Record<string, unknown>>> {
    return ((await this.ensureState(botId)).cronHistory.get(taskId) ?? []).slice(0, Math.max(0, Math.floor(limit)));
  }

  close(): void {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    this.schedulerRunning = false;
    for (const state of this.states.values()) this.disposeState(state);
    this.states.clear();
    this.stateInitializations.clear();
    this.reloads.clear();
    this.startPromise = null;
  }

  private async runDueTasks(now: number): Promise<void> {
    if (this.options.botRepository.claimDueCronTasks) {
      const claims = await this.options.botRepository.claimDueCronTasks({
        now,
        leaseOwner: this.cronLeaseOwner,
      });
      for (const claim of claims) {
        try {
          await this.triggerBotCronTask(claim.botId, claim.taskId, claim.claimToken);
          await this.options.botRepository.completeCronTaskClaim?.({ botId: claim.botId, taskId: claim.taskId, claimToken: claim.claimToken });
        } catch (error) {
          await this.options.botRepository.releaseCronTaskClaim?.({ botId: claim.botId, taskId: claim.taskId, claimToken: claim.claimToken });
          console.error(`[daemon][cron][${claim.botId}/${claim.taskId}] 自动调度失败`, error);
        }
      }
      return;
    }
    const tasks = await this.options.botRepository.listDueCronTasks(now);
    for (const { botId, taskId } of tasks) {
      try {
        await this.triggerBotCronTask(botId, taskId);
      } catch (error) {
        console.error(`[daemon][cron][${botId}/${taskId}] 自动调度失败`, error);
      }
    }
  }

  private startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      if (this.schedulerRunning) return;
      this.schedulerRunning = true;
      void this.runDueTasks(Date.now() / 1000).finally(() => {
        this.schedulerRunning = false;
      });
    }, 60_000);
    this.schedulerTimer.unref();
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

  private async rebuildBot(config: BotConfig, priorHistory?: Map<string, Array<Record<string, unknown>>>): Promise<BotRuntimeState> {
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
      cronHistory: priorHistory ?? new Map(),
      processedMessageIds: new Map(),
    };
    this.syncCronHistoryKeys(state);
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
      this.options.registry.registerRouteToken(state.tenantId, state.botId, connection.route_token);
      state.registeredRouteToken = connection.route_token;
    }
  }

  private disposeState(state: BotRuntimeState): void {
    state.feishuRuntime?.longConnection?.close();
    if (state.registeredRouteToken) this.options.registry.unregisterRouteToken(state.registeredRouteToken, state.tenantId);
    state.feishuRuntime = null;
    state.registeredRouteToken = null;
    state.processedMessageIds.clear();
  }

  private onFeishuMessage(state: BotRuntimeState, input: unknown): void {
    const data = input as FeishuMessageEvent;
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
      const responded = kind === "approval"
        ? lease.runtime.pendingInteractions.respondApproval(sessionId, approvalId, resolution as { approved: boolean; message: string })
        : lease.runtime.pendingInteractions.respondUserInput(sessionId, approvalId, resolution as { value: string });
      if (!responded.resolved) {
        throw new DaemonServiceError(404, "待处理交互不存在或已完成");
      }
      if (!responded.needsResume) {
        return { toast: { type: "success", content: "响应已提交" } };
      }

      const rootRunId = responded.rootRunId ?? "";
      lease.runtime.resumeExecutor.resumeRun({
        sessionId,
        approvalId,
        resolution,
        onCompleted: (result) => {
          const metadata = lease.runtime.conversationStore.getSession(sessionId)?.metadata ?? {};
          const chatId = resolveBotChatId(state.config, metadata);
          releaseLease();
          if (!chatId) return;
          const content = result.success ? result.content : `Agent 恢复执行失败：${result.content}`;
          void this.sendFeishuMessage(state, chatId, "chat_id", content).catch((error: unknown) => {
            console.error(`[daemon][feishu][${state.botId}] 恢复结果发送失败`, error);
          });
        },
        onSuspended: () => {
          const next = lease.runtime.pendingInteractions.listPendingApprovalMeta(rootRunId, sessionId);
          const metadata = lease.runtime.conversationStore.getSession(sessionId)?.metadata ?? {};
          releaseLease();
          if (next.length === 0) return;
          void this.sendSuspendedCards(state, next.map((item) => toSuspendedInteraction(state.botId, item)), metadata).catch((error: unknown) => {
            console.error(`[daemon][feishu][${state.botId}] 后续挂起卡片发送失败`, error);
          });
        },
      });
      releaseByCallback = true;
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
    cronTask?: BotCronTask | undefined,
  ): Promise<void> {
    if (!state.feishuRuntime) {
      throw new Error("飞书适配器未配置");
    }
    const chatId = resolveBotChatId(state.config, sessionMetadata, cronTask);
    if (!chatId) {
      throw new Error("挂起交互缺少飞书 chat_id，请配置 default_chat_id 或 cron push_chat_id");
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
    cronTask?: BotCronTask | undefined,
  ): Promise<void> {
    for (const interaction of interactions) {
      await this.sendSuspendedCard(state, interaction, sessionMetadata, cronTask);
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

  private recordCronHistory(state: BotRuntimeState, taskId: string, item: Record<string, unknown>): void {
    const history = state.cronHistory.get(taskId) ?? [];
    history.unshift(item);
    state.cronHistory.set(taskId, history.slice(0, 50));
  }

  private syncCronHistoryKeys(state: BotRuntimeState): void {
    const taskIds = new Set(state.config.cron_tasks.map((task) => task.task_id));
    for (const taskId of taskIds) if (!state.cronHistory.has(taskId)) state.cronHistory.set(taskId, []);
    for (const taskId of state.cronHistory.keys()) if (!taskIds.has(taskId)) state.cronHistory.delete(taskId);
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
  cronTask?: Pick<BotCronTask, "push_chat_id"> | undefined,
): string | null {
  const directChatId = readNonEmptyString(sessionMetadata.chatId);
  if (directChatId) return directChatId;
  const senderOpenId = readNonEmptyString(sessionMetadata.sender_open_id)
    ?? (isRecord(sessionMetadata.feishu) ? readNonEmptyString(sessionMetadata.feishu.sender_open_id) : null);
  if (senderOpenId) return senderOpenId;
  const defaultChatId = config.feishu.default_chat_id?.trim();
  if (defaultChatId) return defaultChatId;
  const cronChatId = cronTask?.push_chat_id?.trim() ?? readNonEmptyString(sessionMetadata.push_chat_id);
  return cronChatId || null;
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

function compactCronPatch(patch: BotCronTaskUpdate): Partial<Omit<BotCronTask, "bot_id" | "task_id">> {
  const compact: Partial<Omit<BotCronTask, "bot_id" | "task_id">> = {};
  if (patch.cron !== undefined) compact.cron = patch.cron;
  if (patch.task !== undefined) compact.task = patch.task;
  if (patch.entry_agent !== undefined) compact.entry_agent = patch.entry_agent;
  if (patch.enabled !== undefined) compact.enabled = patch.enabled;
  if (patch.push_platform !== undefined) compact.push_platform = patch.push_platform;
  if (patch.push_chat_id !== undefined) compact.push_chat_id = patch.push_chat_id;
  return compact;
}

function readMessageId(response: unknown): string | null {
  if (!isRecord(response)) return null;
  return isRecord(response.data) && typeof response.data.message_id === "string" ? response.data.message_id : null;
}

function computeNextRun(cron: string): number | null {
  const next = nextCronTime(cron);
  return next ? next.getTime() / 1000 : null;
}

function nextCronTime(cron: string, after = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  let date = new Date(after.getTime());
  date.setSeconds(0, 0);
  date = new Date(date.getTime() + 60_000);
  const limit = new Date(date.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (date < limit) {
    if (matchesCron(cron, date)) return date;
    date = new Date(date.getTime() + 60_000);
  }
  return null;
}

function matchesCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return false;
  if (!parseCronField(minute, 0, 59).has(date.getMinutes())) return false;
  if (!parseCronField(hour, 0, 23).has(date.getHours())) return false;
  if (!parseCronField(month, 1, 12).has(date.getMonth() + 1)) return false;
  const dayOfMonthRestricted = dayOfMonth !== "*";
  const dayOfWeekRestricted = dayOfWeek !== "*";
  if (dayOfMonthRestricted && dayOfWeekRestricted) return parseCronField(dayOfMonth, 1, 31).has(date.getDate()) || parseCronField(dayOfWeek, 0, 6).has(date.getDay());
  return parseCronField(dayOfMonth, 1, 31).has(date.getDate()) && parseCronField(dayOfWeek, 0, 6).has(date.getDay());
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") addRange(values, min, max, 1);
    else if (part.includes("/")) {
      const [base, rawStep] = part.split("/");
      const step = Math.max(1, Number(rawStep) || 1);
      const start = base === "*" ? min : Number(base);
      addRange(values, Number.isFinite(start) ? start : min, max, step);
    } else if (part.includes("-")) {
      const [start, end] = part.split("-");
      addRange(values, Number(start), Number(end), 1);
    } else {
      const value = Number(part);
      if (Number.isInteger(value) && value >= min && value <= max) values.add(value);
    }
  }
  return values;
}

function addRange(values: Set<number>, start: number, end: number, step: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return;
  for (let value = Math.max(start, 0); value <= end; value += step) values.add(value);
}

function safeSessionPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "default";
}
