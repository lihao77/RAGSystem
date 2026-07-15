import { randomUUID } from "node:crypto";

import type { BotConfig, BotCronTask, BotCronTaskCreate, BotCronTaskUpdate, PlatformType } from "../../contracts/bot.js";
import type { DaemonOutgoingMessage, DaemonTestMessage } from "../../contracts/daemon.js";
import type { TenantId, UserId } from "../../identity/types.js";
import type { TenantRuntimeRegistry } from "../runtime/tenant-runtime-registry.js";
import type { ControlStore } from "../stores/control-store/index.js";
import {
  createDispatcher,
  createFeishuClient,
  invokeWebhook,
  sendTextMessage,
  startLongConnection,
  type FeishuClient,
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
}

export type DaemonRunAgentTask = (input: DaemonRunAgentInput) => Promise<string> | string;

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
  controlStore: ControlStore;
  registry: TenantRuntimeRegistry;
  runAgentTask: DaemonRunAgentTask;
}

export class DaemonService {
  private readonly states = new Map<UserId, BotRuntimeState>();
  private started = false;

  constructor(private readonly options: DaemonServiceOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const config of this.options.controlStore.getAllEnabledFeishuBots()) this.rebuildBot(config);
  }

  reloadBot(botId: UserId): void {
    const existing = this.states.get(botId);
    if (existing) this.disposeState(existing);
    this.states.delete(botId);
    const bot = this.options.controlStore.getBot(botId);
    if (!bot || bot.status !== "active") return;
    const config = this.options.controlStore.getBotRuntimeConfig(botId);
    if (!config) return;
    this.rebuildBot(config, existing?.cronHistory);
  }

  async testMessage(botId: UserId, input: DaemonTestMessage): Promise<{ status: "ok"; message: string; session_id: string; result: string }> {
    const state = this.ensureState(botId);
    const sessionId = resolveSessionId(state.config, input.platform, input.chat_id);
    const result = await this.runAgent(state, input.content, sessionId, `daemon.${input.platform}.test`);
    return { status: "ok", message: "测试消息已执行", session_id: sessionId, result };
  }

  async sendMessage(botId: UserId, input: DaemonOutgoingMessage): Promise<{ status: "ok" | "failed"; message_id?: string; error?: string }> {
    const state = this.ensureState(botId);
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

  listBotCronTasks(botId: UserId): BotCronTask[] {
    this.requireBotConfig(botId);
    return this.options.controlStore.listBotCronTasks(botId);
  }

  createBotCronTask(botId: UserId, task: BotCronTaskCreate): BotCronTask {
    this.requireBotConfig(botId);
    if (this.options.controlStore.getBotCronTask(botId, task.task_id)) throw new DaemonServiceError(400, `任务已存在: ${task.task_id}`);
    const created = this.options.controlStore.createBotCronTask(botId, { ...task, next_run: task.enabled ? computeNextRun(task.cron) : null });
    this.ensureState(botId).cronHistory.set(task.task_id, []);
    return created;
  }

  updateBotCronTask(botId: UserId, taskId: string, patch: BotCronTaskUpdate): BotCronTask | null {
    const current = this.options.controlStore.getBotCronTask(botId, taskId);
    if (!current) return null;
    const cron = patch.cron ?? current.cron;
    const enabled = patch.enabled ?? current.enabled;
    return this.options.controlStore.updateBotCronTask(botId, taskId, {
      ...compactCronPatch(patch),
      next_run: enabled ? computeNextRun(cron) : null,
    });
  }

  deleteBotCronTask(botId: UserId, taskId: string): boolean {
    const deleted = this.options.controlStore.deleteBotCronTask(botId, taskId);
    if (deleted) this.states.get(botId)?.cronHistory.delete(taskId);
    return deleted;
  }

  async triggerBotCronTask(botId: UserId, taskId: string): Promise<{ status: "ok"; result: string | null }> {
    const state = this.ensureState(botId);
    const task = this.options.controlStore.getBotCronTask(botId, taskId);
    if (!task || !task.enabled) throw new DaemonServiceError(404, `任务不存在或未启用: ${taskId}`);
    const startedAt = Date.now();
    try {
      const sessionId = resolveSessionId(state.config, "feishu", `cron:${taskId}`);
      const result = await this.runAgent(state, task.task, sessionId, "daemon.cron", task.entry_agent ?? state.config.entry_agent);
      const now = Date.now() / 1000;
      this.options.controlStore.updateBotCronTask(botId, taskId, {
        last_run: now,
        next_run: computeNextRun(task.cron),
        last_result: result.slice(0, 200),
      });
      this.recordCronHistory(state, taskId, { timestamp: now, success: true, result: result.slice(0, 200), error: null, elapsed: (Date.now() - startedAt) / 1000 });
      if (task.push_platform && task.push_chat_id) {
        const sent = await this.sendMessage(botId, { platform: task.push_platform, chat_id: task.push_chat_id, content: result, message_type: "text" });
        if (sent.status === "failed") throw new Error(sent.error ?? "飞书消息发送失败");
      }
      return { status: "ok", result: result || null };
    } catch (error) {
      const now = Date.now() / 1000;
      const message = error instanceof Error ? error.message : String(error);
      this.options.controlStore.updateBotCronTask(botId, taskId, { last_run: now, last_result: `ERROR: ${message}` });
      this.recordCronHistory(state, taskId, { timestamp: now, success: false, result: "", error: message, elapsed: (Date.now() - startedAt) / 1000 });
      throw new DaemonServiceError(400, message);
    }
  }

  getBotCronHistory(botId: UserId, taskId: string, limit: number): Array<Record<string, unknown>> {
    return (this.ensureState(botId).cronHistory.get(taskId) ?? []).slice(0, Math.max(0, Math.floor(limit)));
  }

  close(): void {
    for (const state of this.states.values()) this.disposeState(state);
    this.states.clear();
    this.started = false;
  }

  private ensureState(botId: UserId): BotRuntimeState {
    const existing = this.states.get(botId);
    if (existing) return existing;
    const config = this.requireBotConfig(botId);
    return this.rebuildBot(config);
  }

  private requireBotConfig(botId: UserId): BotConfig {
    const bot = this.options.controlStore.getBot(botId);
    if (!bot) throw new DaemonServiceError(404, "bot 不存在");
    if (bot.status !== "active") throw new DaemonServiceError(409, "bot 已禁用");
    const config = this.options.controlStore.getBotRuntimeConfig(botId);
    if (!config) throw new DaemonServiceError(404, "bot 配置不存在");
    return config;
  }

  private rebuildBot(config: BotConfig, priorHistory?: Map<string, Array<Record<string, unknown>>>): BotRuntimeState {
    const bot = this.options.controlStore.getBot(config.bot_id);
    let resolvedConfig = config;
    if (config.enabled && config.feishu.enabled && config.feishu.receive_mode === "webhook" && !config.feishu.route_token) {
      this.options.controlStore.updateBotConfig(config.bot_id, { feishu: { route_token: randomUUID().replaceAll("-", "") } });
      resolvedConfig = this.requireBotConfig(config.bot_id);
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
    const dispatcher = createDispatcher(connection, { onMessage: (data) => this.onFeishuMessage(state, data) });
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

  private async processFeishuMessage(state: BotRuntimeState, data: FeishuMessageEvent): Promise<void> {
    const message = data.message;
    const chatId = message?.chat_id;
    if (!message || !chatId || message.message_type !== "text" || !message.content) return;
    const parsedContent = JSON.parse(message.content) as unknown;
    const text = isRecord(parsedContent) && typeof parsedContent.text === "string" ? parsedContent.text.trim() : "";
    if (!text) return;
    const senderOpenId = data.sender?.sender_id?.open_id;
    const result = await this.runAgent(
      state,
      text,
      resolveSessionId(state.config, "feishu", chatId),
      "daemon.feishu.incoming",
      state.config.entry_agent,
      senderOpenId ? { feishu: { sender_open_id: senderOpenId } } : undefined,
    );
    if (message.chat_type === "p2p") {
      if (!senderOpenId) throw new Error("单聊消息缺少 sender open_id,无法回复");
      const sent = await this.sendFeishuMessage(state, senderOpenId, "open_id", result);
      if (sent.status === "failed") throw new Error(sent.error ?? "飞书消息发送失败");
    } else {
      const sent = await this.sendFeishuMessage(state, chatId, "chat_id", result);
      if (sent.status === "failed") throw new Error(sent.error ?? "飞书消息发送失败");
    }
  }

  private runAgent(
    state: BotRuntimeState,
    task: string,
    sessionId: string,
    source: string,
    entryAgent = state.config.entry_agent,
    sessionMetadata?: Record<string, unknown>,
  ): Promise<string> | string {
    return this.options.runAgentTask({
      tenantId: state.tenantId,
      botId: state.botId,
      task,
      entryAgent,
      sessionId,
      source,
      ...(sessionMetadata ? { sessionMetadata } : {}),
    });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
