import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import type {
  CronTask,
  CronTaskUpdate,
  DaemonAgentConfig,
  DaemonOutgoingMessage,
  DaemonSystemConfig,
  DaemonTestMessage,
  PlatformConnection,
  PlatformType,
} from "../../contracts/daemon.js";
import { DaemonSystemConfigSchema } from "../../contracts/daemon.js";
import type { TenantId } from "../../identity/types.js";
import type { TenantRuntimeRegistry } from "../runtime/tenant-runtime-registry.js";
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

const DAEMON_CONFIG_RELATIVE_PATH = path.join("config", "daemon", "daemon.yaml");
const MASKED_SECRET = "***";

export class DaemonServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DaemonServiceError";
    this.statusCode = statusCode;
  }
}

export interface DaemonRunAgentInput {
  task: string;
  teamName: string;
  entryAgent: string | null;
  sessionId: string;
  source: string;
}

export type DaemonRunAgentTask = (input: DaemonRunAgentInput) => Promise<string> | string;

interface FeishuRuntime {
  client: FeishuClient;
  dispatcher: FeishuDispatcher;
  longConnection?: FeishuLongConnectionHandle;
}

export class DaemonService {
  private config: DaemonSystemConfig = {
    enabled: false,
    agents: [],
    default_session_ttl: 86400,
  };
  private readonly cronHistory = new Map<string, Array<Record<string, unknown>>>();
  private readonly feishuRoster = new Map<string, FeishuRuntime>();
  private readonly registeredRouteTokens = new Set<string>();
  /** 飞书 message_id 去重缓存(防 ack 超时/长连接重连补发导致重复处理)。 */
  private readonly processedMessageIds = new Map<string, number>();
  private static readonly DEDUP_TTL_MS = 5 * 60 * 1000;
  private readonly configPath: string | null;
  private runAgentTask: DaemonRunAgentTask;
  private registry: TenantRuntimeRegistry | null = null;
  private tenantId: TenantId | null = null;
  private agentRunnerReady: boolean;

  constructor(options: { dataRoot?: string | undefined; configPath?: string | undefined; runAgentTask?: DaemonRunAgentTask | undefined } = {}) {
    this.configPath = resolveConfigPath(options);
    this.runAgentTask = options.runAgentTask ?? missingRunAgentTask;
    this.agentRunnerReady = options.runAgentTask !== undefined;
    this.loadConfigFromDisk();
    this.syncCronHistoryKeys();
    if (this.agentRunnerReady) this.syncFeishuRoster();
  }

  setRunAgentTask(runAgentTask: DaemonRunAgentTask): void {
    this.runAgentTask = runAgentTask;
    this.agentRunnerReady = true;
    this.syncFeishuRoster();
  }

  setRuntimeRegistry(registry: TenantRuntimeRegistry, tenantId: TenantId): void {
    this.registry = registry;
    this.tenantId = tenantId;
    this.syncRouteTokens();
  }

  getStatus(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      agents_count: this.config.agents.length,
      cron_task_count: this.listCronTasks().length,
    };
  }

  getConfig(): DaemonSystemConfig {
    const config = cloneConfig(this.config);
    for (const agent of config.agents) {
      const connection = agent.platforms.feishu;
      if (!connection) continue;
      if (connection.app_secret) connection.app_secret = MASKED_SECRET;
      if (connection.token) connection.token = MASKED_SECRET;
      if (connection.encoding_aes_key) connection.encoding_aes_key = MASKED_SECRET;
    }
    return config;
  }

  updateConfig(config: DaemonSystemConfig): { status: "ok"; message: string } {
    const parsed = parseConfig(config);
    restoreMaskedSecrets(parsed, this.config);
    this.config = parsed;
    this.syncCronHistoryKeys();
    this.syncRouteTokens();
    this.syncFeishuRoster();
    this.saveConfigToDisk();
    return { status: "ok", message: "配置已保存并生效" };
  }

  async testMessage(teamName: string, input: DaemonTestMessage): Promise<{ status: "ok"; message: string; session_id: string; result: string }> {
    const agent = this.findAgent(teamName);
    if (!agent) throw new DaemonServiceError(404, `守护机器人不存在: ${teamName}`);
    const sessionId = resolveSessionId(agent, input.platform, input.chat_id);
    const result = await this.runAgentTask({
      task: input.content,
      teamName,
      entryAgent: agent.entry_agent,
      sessionId,
      source: `daemon.${input.platform}.test`,
    });
    return { status: "ok", message: "测试消息已执行", session_id: sessionId, result };
  }

  async sendMessage(input: DaemonOutgoingMessage): Promise<{ status: "ok" | "failed"; message_id?: string; error?: string }> {
    const agent = this.config.agents.find((item) => item.enabled && item.platforms.feishu?.enabled);
    if (!agent) return { status: "failed", error: "未配置已启用的飞书连接" };
    return this.sendTeamMessage(agent.team_name, input.chat_id, "chat_id", input.content);
  }

  async handleIncomingMessage(routeToken: string, body: unknown): Promise<unknown> {
    if (!this.registry) throw new DaemonServiceError(503, "租户运行时注册表未绑定");
    const target = this.registry.resolveRouteToken(routeToken);
    if (!target) throw new DaemonServiceError(404, "无效的飞书 webhook routeToken");
    const lease = await this.registry.acquire(target.tenantId);
    try {
      return await lease.runtime.daemon.handleIncomingForTeam(target.teamName, routeToken, body);
    } finally {
      lease.release();
    }
  }

  listCronTasks(): CronTask[] {
    return this.config.agents.flatMap((agent) => agent.cron_tasks.map((task) => cloneTask(task)));
  }

  createCronTask(task: CronTask): string {
    if (this.findCronTask(task.task_id)) throw new DaemonServiceError(400, `任务已存在: ${task.task_id}`);
    const agent = this.findAgent(task.team_name);
    if (!agent) throw new DaemonServiceError(400, `守护机器人不存在: ${task.team_name}`);
    const taskCopy = cloneTask(task);
    taskCopy.next_run = computeNextRun(taskCopy.cron);
    agent.cron_tasks.push(taskCopy);
    this.cronHistory.set(task.task_id, []);
    this.saveConfigToDisk();
    return task.task_id;
  }

  updateCronTask(taskId: string, updates: CronTaskUpdate): boolean {
    const found = this.findCronTask(taskId);
    if (!found) return false;
    const updated = cloneTask({ ...found.task, ...compactCronTaskUpdate(updates), task_id: taskId });
    updated.next_run = updated.enabled ? computeNextRun(updated.cron) : null;
    if (updated.team_name !== found.agent.team_name) {
      const targetAgent = this.findAgent(updated.team_name);
      if (!targetAgent) return false;
      found.agent.cron_tasks.splice(found.index, 1);
      targetAgent.cron_tasks.push(updated);
    } else {
      found.agent.cron_tasks[found.index] = updated;
    }
    this.saveConfigToDisk();
    return true;
  }

  deleteCronTask(taskId: string): boolean {
    const found = this.findCronTask(taskId);
    if (!found) return false;
    found.agent.cron_tasks.splice(found.index, 1);
    this.cronHistory.delete(taskId);
    this.saveConfigToDisk();
    return true;
  }

  async triggerCronTask(taskId: string): Promise<{ status: "ok"; result: string | null }> {
    const found = this.findCronTask(taskId);
    if (!found || !found.task.enabled) throw new DaemonServiceError(404, `任务不存在或执行失败: ${taskId}`);
    const startedAt = Date.now();
    try {
      const sessionId = resolveSessionId(found.agent, "feishu", `cron:${taskId}`);
      const result = await this.runAgentTask({
        task: found.task.task,
        teamName: found.task.team_name,
        entryAgent: found.task.entry_agent ?? found.agent.entry_agent,
        sessionId,
        source: "daemon.cron",
      });
      const now = Date.now() / 1000;
      found.task.last_run = now;
      found.task.next_run = computeNextRun(found.task.cron);
      found.task.last_result = result.slice(0, 200);
      this.recordCronHistory(taskId, { timestamp: now, success: true, result: result.slice(0, 200), error: null, elapsed: (Date.now() - startedAt) / 1000 });
      if (found.task.push_platform && found.task.push_chat_id) {
        const sent = await this.sendMessage({ platform: found.task.push_platform, chat_id: found.task.push_chat_id, content: result, message_type: "text" });
        if (sent.status === "failed") throw new Error(sent.error ?? "飞书消息发送失败");
      }
      this.saveConfigToDisk();
      return { status: "ok", result: result || null };
    } catch (error) {
      const now = Date.now() / 1000;
      const message = error instanceof Error ? error.message : String(error);
      found.task.last_run = now;
      found.task.last_result = `ERROR: ${message}`;
      this.recordCronHistory(taskId, { timestamp: now, success: false, result: "", error: message, elapsed: (Date.now() - startedAt) / 1000 });
      this.saveConfigToDisk();
      throw new DaemonServiceError(400, message);
    }
  }

  getCronHistory(taskId: string, limit: number): Array<Record<string, unknown>> {
    return (this.cronHistory.get(taskId) ?? []).slice(0, Math.max(0, Math.floor(limit)));
  }

  close(): void {
    this.stopLongConnections();
    this.feishuRoster.clear();
    this.processedMessageIds.clear();
  }

  private async handleIncomingForTeam(teamName: string, routeToken: string, body: unknown): Promise<unknown> {
    const target = this.registry?.resolveRouteToken(routeToken);
    if (!target || target.tenantId !== this.tenantId || target.teamName !== teamName) {
      throw new DaemonServiceError(404, "无效的飞书 webhook routeToken");
    }
    if (isRecord(body) && body.type === "url_verification" && typeof body.challenge === "string") {
      return { challenge: body.challenge };
    }
    const runtime = this.feishuRoster.get(teamName);
    if (!runtime) throw new DaemonServiceError(503, `飞书适配器未配置: ${teamName}`);
    if (!isRecord(body)) throw new DaemonServiceError(400, "飞书 webhook 请求体必须为 JSON 对象");
    const response = await invokeWebhook(runtime.dispatcher, body);
    return response ?? { code: 0 };
  }

  private onFeishuMessage(teamName: string, input: unknown): void {
    const data = input as FeishuMessageEvent;
    const messageId = data.message?.message_id;
    // 入口同步去重:飞书 ack 超时或长连接重连补发会重投同一 message_id,标记过就跳过。
    if (messageId) {
      const now = Date.now();
      this.purgeExpiredDedup(now);
      if (this.processedMessageIds.has(messageId)) return;
      this.processedMessageIds.set(messageId, now);
    }
    // agent 执行耗时,丢后台异步处理,handler 立即返回让飞书 SDK 尽快 ack,避免 ack 超时触发重发。
    void this.processFeishuMessage(teamName, input).catch((error: unknown) => {
      console.error(`[daemon][feishu] 消息处理失败 (${teamName})`, error);
    });
  }

  private async processFeishuMessage(teamName: string, input: unknown): Promise<void> {
    const data = input as FeishuMessageEvent;
    const agent = this.findAgent(teamName);
    const message = data.message;
    const chatId = message?.chat_id;
    if (!agent || !message || !chatId || message.message_type !== "text" || !message.content) return;
    const parsedContent = JSON.parse(message.content) as unknown;
    const text = isRecord(parsedContent) && typeof parsedContent.text === "string" ? parsedContent.text.trim() : "";
    if (!text) return;
    const result = await this.runAgentTask({
      task: text,
      teamName,
      entryAgent: agent.entry_agent,
      sessionId: resolveSessionId(agent, "feishu", chatId),
      source: "daemon.feishu.incoming",
    });
    // 单聊(p2p)用 sender.open_id 回复(机器人发消息给用户);群聊(group)用 chat_id 发回群。
    if (message.chat_type === "p2p") {
      const openId = data.sender?.sender_id?.open_id;
      if (!openId) throw new Error("单聊消息缺少 sender open_id,无法回复");
      const sent = await this.sendTeamMessage(teamName, openId, "open_id", result);
      if (sent.status === "failed") throw new Error(sent.error ?? "飞书消息发送失败");
    } else {
      const sent = await this.sendTeamMessage(teamName, chatId, "chat_id", result);
      if (sent.status === "failed") throw new Error(sent.error ?? "飞书消息发送失败");
    }
  }

  private purgeExpiredDedup(now: number): void {
    for (const [id, ts] of this.processedMessageIds) {
      if (now - ts > DaemonService.DEDUP_TTL_MS) this.processedMessageIds.delete(id);
    }
  }

  private async sendTeamMessage(teamName: string, receiveId: string, receiveIdType: "chat_id" | "open_id", content: string): Promise<{ status: "ok" | "failed"; message_id?: string; error?: string }> {
    const runtime = this.feishuRoster.get(teamName);
    if (!runtime) return { status: "failed", error: `飞书适配器未配置: ${teamName}` };
    try {
      const response = await sendTextMessage(runtime.client, receiveId, receiveIdType, content);
      const messageId = readMessageId(response);
      return messageId ? { status: "ok", message_id: messageId } : { status: "ok" };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private syncFeishuRoster(): void {
    this.stopLongConnections();
    this.feishuRoster.clear();
    if (!this.config.enabled || !this.agentRunnerReady) return;
    for (const agent of this.config.agents) {
      const connection = agent.platforms.feishu;
      if (!agent.enabled || !connection?.enabled || !connection.app_id || !connection.app_secret) continue;
      const client = createFeishuClient(connection);
      const dispatcher = createDispatcher(connection, {
        onMessage: (data) => this.onFeishuMessage(agent.team_name, data),
      });
      const longConnection = connection.receive_mode === "long_connection"
        ? startLongConnection(client, dispatcher)
        : undefined;
      if (longConnection) {
        void longConnection.started.catch((error: unknown) => {
          console.error(`[daemon][feishu] 长连接启动失败 (${agent.team_name})`, error);
        });
      }
      this.feishuRoster.set(agent.team_name, {
        client,
        dispatcher,
        ...(longConnection ? { longConnection } : {}),
      });
    }
  }

  private stopLongConnections(): void {
    for (const runtime of this.feishuRoster.values()) {
      runtime.longConnection?.close();
    }
  }

  private syncRouteTokens(): void {
    if (!this.registry || !this.tenantId) return;
    for (const routeToken of this.registeredRouteTokens) this.registry.unregisterRouteToken(routeToken, this.tenantId);
    this.registeredRouteTokens.clear();
    let changed = false;
    for (const agent of this.config.agents) {
      const connection = agent.platforms.feishu;
      if (!connection || connection.receive_mode !== "webhook") continue;
      if (!connection.route_token) {
        connection.route_token = randomUUID().replaceAll("-", "");
        changed = true;
      }
      this.registry.registerRouteToken(this.tenantId, agent.team_name, connection.route_token);
      this.registeredRouteTokens.add(connection.route_token);
    }
    if (changed) this.saveConfigToDisk();
  }

  private findAgent(teamName: string): DaemonAgentConfig | null {
    return this.config.agents.find((agent) => agent.team_name === teamName) ?? null;
  }

  private findCronTask(taskId: string): { agent: DaemonAgentConfig; task: CronTask; index: number } | null {
    for (const agent of this.config.agents) {
      const index = agent.cron_tasks.findIndex((task) => task.task_id === taskId);
      if (index >= 0) return { agent, task: agent.cron_tasks[index]!, index };
    }
    return null;
  }

  private recordCronHistory(taskId: string, item: Record<string, unknown>): void {
    const history = this.cronHistory.get(taskId) ?? [];
    history.unshift(item);
    this.cronHistory.set(taskId, history.slice(0, 50));
  }

  private syncCronHistoryKeys(): void {
    const taskIds = new Set(this.listCronTasks().map((task) => task.task_id));
    for (const taskId of taskIds) if (!this.cronHistory.has(taskId)) this.cronHistory.set(taskId, []);
    for (const taskId of this.cronHistory.keys()) if (!taskIds.has(taskId)) this.cronHistory.delete(taskId);
  }

  private loadConfigFromDisk(): void {
    if (!this.configPath || !fs.existsSync(this.configPath)) return;
    try {
      const parsed = YAML.parse(fs.readFileSync(this.configPath, "utf8")) as unknown;
      if (isRecord(parsed)) this.config = parseConfig(parsed);
    } catch {
      this.config = { enabled: false, agents: [], default_session_ttl: 86400 };
    }
  }

  private saveConfigToDisk(): void {
    if (!this.configPath) return;
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, YAML.stringify(this.config), "utf8");
  }
}

function restoreMaskedSecrets(next: DaemonSystemConfig, current: DaemonSystemConfig): void {
  for (const agent of next.agents) {
    const nextConnection = agent.platforms.feishu;
    const currentConnection = current.agents.find((item) => item.team_name === agent.team_name)?.platforms.feishu;
    if (!nextConnection || !currentConnection) continue;
    restoreSecret(nextConnection, currentConnection, "app_secret");
    restoreSecret(nextConnection, currentConnection, "token");
    restoreSecret(nextConnection, currentConnection, "encoding_aes_key");
    if (!nextConnection.route_token) nextConnection.route_token = currentConnection.route_token;
  }
}

function restoreSecret(next: PlatformConnection, current: PlatformConnection, key: "app_secret" | "token" | "encoding_aes_key"): void {
  if (next[key] === MASKED_SECRET) next[key] = current[key];
}

function readMessageId(response: unknown): string | null {
  if (!isRecord(response)) return null;
  const data = response.data;
  return isRecord(data) && typeof data.message_id === "string" ? data.message_id : null;
}

function cloneConfig(config: DaemonSystemConfig): DaemonSystemConfig {
  return structuredClone(config) as DaemonSystemConfig;
}

function parseConfig(config: unknown): DaemonSystemConfig {
  return DaemonSystemConfigSchema.parse(config);
}

function cloneTask(task: CronTask): CronTask {
  return structuredClone(task) as CronTask;
}

function compactCronTaskUpdate(updates: CronTaskUpdate): Partial<CronTask> {
  const compact: Partial<CronTask> = {};
  for (const [key, value] of Object.entries(updates)) if (value !== undefined) (compact as Record<string, unknown>)[key] = value;
  return compact;
}

function resolveSessionId(agent: DaemonAgentConfig, platform: PlatformType, chatId: string): string {
  const explicit = agent.platforms[platform]?.session_id ?? agent.session_id;
  return explicit?.trim() || `daemon-${safeSessionPart(agent.team_name)}-${platform}-${safeSessionPart(chatId)}`;
}

function computeNextRun(cron: string): number | null {
  const next = nextCronTime(cron);
  return next ? next.getTime() / 1000 : null;
}

function nextCronTime(cron: string, after = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  let dt = new Date(after.getTime());
  dt.setSeconds(0, 0);
  dt = new Date(dt.getTime() + 60_000);
  const limit = new Date(dt.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (dt < limit) {
    if (matchesCron(cron, dt)) return dt;
    dt = new Date(dt.getTime() + 60_000);
  }
  return null;
}

function matchesCron(cron: string, dt: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  if (!minute || !hour || !dom || !month || !dow) return false;
  const cronDow = dt.getDay();
  if (!parseCronField(minute, 0, 59).has(dt.getMinutes())) return false;
  if (!parseCronField(hour, 0, 23).has(dt.getHours())) return false;
  if (!parseCronField(month, 1, 12).has(dt.getMonth() + 1)) return false;
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  if (domRestricted && dowRestricted) return parseCronField(dom, 1, 31).has(dt.getDate()) || parseCronField(dow, 0, 6).has(cronDow);
  return parseCronField(dom, 1, 31).has(dt.getDate()) && parseCronField(dow, 0, 6).has(cronDow);
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      addRange(values, min, max, 1);
    } else if (part.includes("/")) {
      const [base, stepRaw] = part.split("/");
      const step = Math.max(1, Number(stepRaw) || 1);
      const start = base === "*" ? min : Number(base);
      addRange(values, Number.isFinite(start) ? start : min, max, step);
    } else if (part.includes("-")) {
      const [startRaw, endRaw] = part.split("-");
      addRange(values, Number(startRaw), Number(endRaw), 1);
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

function missingRunAgentTask(): never {
  throw new Error("daemon runAgentTask 尚未注入");
}

function resolveConfigPath(options: { dataRoot?: string | undefined; configPath?: string | undefined }): string | null {
  if (options.configPath !== undefined) {
    const trimmed = options.configPath.trim();
    return trimmed ? path.resolve(trimmed) : null;
  }
  return path.join(path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem")), DAEMON_CONFIG_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
