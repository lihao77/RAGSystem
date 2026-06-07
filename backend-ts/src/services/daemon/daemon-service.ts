import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import YAML from "yaml";

import type {
  CronTask,
  CronTaskUpdate,
  DaemonAgentConfig,
  DaemonOutgoingMessage,
  DaemonSystemConfig,
  DaemonTestMessage,
  PlatformType,
} from "../../contracts/daemon.js";

const DAEMON_CONFIG_RELATIVE_PATH = path.join("config", "daemon", "daemon.yaml");

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

export class DaemonService {
  private config: DaemonSystemConfig = {
    enabled: false,
    agents: [],
    default_session_ttl: 86400,
  };
  private running = false;
  private readonly cronHistory = new Map<string, Array<Record<string, unknown>>>();
  private readonly heartbeatHistory = new Map<PlatformType, Array<Record<string, unknown>>>();
  private readonly platformStatuses = new Map<PlatformType, PlatformRuntimeStatus>();
  private readonly outgoingMessages: Array<Record<string, unknown>> = [];
  private readonly daemonSessions = new Map<string, { sessionId: string; lastSeen: number }>();
  private readonly configPath: string | null;

  constructor(options: { dataRoot?: string | undefined; configPath?: string | undefined; runAgentTask?: DaemonRunAgentTask | undefined } = {}) {
    this.configPath = resolveConfigPath(options);
    this.runAgentTask = options.runAgentTask ?? defaultRunAgentTask;
    this.loadConfigFromDisk();
    this.syncCronHistoryKeys();
  }

  private readonly runAgentTask: DaemonRunAgentTask;

  getStatus(): Record<string, unknown> {
    const connected = Array.from(this.platformStatuses.values()).filter((status) => status.status === "connected").length;
    return {
      enabled: this.config.enabled,
      running: this.running,
      runtime: "local",
      adapter_count: connected,
      daemon_sessions: this.daemonSessions.size,
      agents_count: this.config.agents.length,
      cron_task_count: this.listCronTasks().length,
    };
  }

  getConfig(): DaemonSystemConfig {
    return cloneConfig(this.config);
  }

  updateConfig(config: DaemonSystemConfig): { status: "ok"; message: string } {
    const wasRunning = this.running;
    if (wasRunning) {
      this.stop();
    }
    this.config = cloneConfig(config);
    this.syncCronHistoryKeys();
    this.saveConfigToDisk();
    if (wasRunning && this.config.enabled) {
      this.start();
    }
    return {
      status: "ok",
      message: `配置已保存${wasRunning ? "，并已自动重载守护系统" : "，启动守护系统后生效"}`,
    };
  }

  start(): { status: "ok"; message: string } {
    this.platformStatuses.clear();
    this.running = false;
    if (!this.config.enabled) {
      return { status: "ok", message: "守护系统未启用" };
    }
    const now = Date.now();
    for (const agent of this.config.agents) {
      if (!agent.enabled) {
        continue;
      }
      for (const [platform, connection] of Object.entries(agent.platforms) as Array<[PlatformType, DaemonAgentConfig["platforms"][PlatformType]]>) {
        if (!connection?.enabled) {
          continue;
        }
        const status = buildConnectedStatus(platform, now);
        this.platformStatuses.set(platform, status);
        this.recordHeartbeat(status);
      }
    }
    this.running = this.platformStatuses.size > 0 || this.listCronTasks().some((task) => task.enabled);
    this.refreshNextRunTimes();
    return { status: "ok", message: "守护系统已启动" };
  }

  stop(): { status: "ok"; message: string } {
    const now = Date.now();
    for (const [platform] of this.platformStatuses) {
      this.platformStatuses.set(platform, {
        platform,
        status: "disconnected",
        last_heartbeat: now / 1000,
        latency_ms: null,
        error: null,
        reconnect_attempts: 0,
      });
    }
    this.running = false;
    return { status: "ok", message: "守护系统已停止" };
  }

  listAgents(): Array<Record<string, unknown>> {
    return this.config.agents.map((agent) => this.toAgentStatus(agent));
  }

  getAgentStatus(teamName: string): Record<string, unknown> | null {
    const agent = this.config.agents.find((item) => item.team_name === teamName);
    return agent ? this.toAgentStatus(agent) : null;
  }

  getAgentHeartbeat(teamName: string, limit: number): { team_name: string; heartbeats: Record<string, unknown[]> } | null {
    const agent = this.config.agents.find((item) => item.team_name === teamName);
    if (!agent) {
      return null;
    }
    return {
      team_name: teamName,
      heartbeats: Object.fromEntries(
        Object.keys(agent.platforms).map((platform) => [
          platform,
          this.getHeartbeatHistory(platform as PlatformType, limit),
        ]),
      ),
    };
  }

  async testMessage(teamName: string, input: DaemonTestMessage): Promise<{ status: "ok"; message: string; session_id: string; result: string }> {
    const agent = this.config.agents.find((item) => item.team_name === teamName);
    if (!agent) {
      throw new DaemonServiceError(404, `守护机器人不存在: ${teamName}`);
    }
    const sessionId = this.resolveSessionId(agent, input.platform, input.chat_id);
    const result = await this.runAgentTask({
      task: input.content,
      teamName,
      entryAgent: agent.entry_agent,
      sessionId,
      source: `daemon.${input.platform}.test`,
    });
    return {
      status: "ok",
      message: "测试消息已发送",
      session_id: sessionId,
      result,
    };
  }

  sendMessage(input: DaemonOutgoingMessage): { status: "ok" | "failed"; message_id?: string; error?: string } {
    const status = this.platformStatuses.get(input.platform);
    if (!this.running || status?.status !== "connected") {
      return { status: "failed", error: `平台适配器未连接: ${input.platform}` };
    }
    const messageId = `daemon_${randomUUID()}`;
    this.outgoingMessages.unshift({
      message_id: messageId,
      platform: input.platform,
      chat_id: input.chat_id,
      content: input.content,
      message_type: input.message_type,
      timestamp: Date.now() / 1000,
    });
    return { status: "ok", message_id: messageId };
  }

  listCronTasks(): CronTask[] {
    return this.config.agents.flatMap((agent) => agent.cron_tasks.map((task) => cloneTask(task)));
  }

  createCronTask(task: CronTask): string {
    if (this.findCronTask(task.task_id)) {
      throw new DaemonServiceError(400, `任务已存在: ${task.task_id}`);
    }
    const agent = this.ensureAgent(task.team_name);
    const taskCopy = cloneTask(task);
    taskCopy.next_run = computeNextRun(taskCopy.cron);
    agent.cron_tasks.push(taskCopy);
    this.cronHistory.set(task.task_id, []);
    this.saveConfigToDisk();
    return task.task_id;
  }

  updateCronTask(taskId: string, updates: CronTaskUpdate): boolean {
    const found = this.findCronTask(taskId);
    if (!found) {
      return false;
    }
    const updated = cloneTask({
      ...found.task,
      ...compactCronTaskUpdate(updates),
      task_id: taskId,
    });
    updated.next_run = updated.enabled ? computeNextRun(updated.cron) : null;
    if (updated.team_name !== found.agent.team_name) {
      const targetAgent = this.ensureAgent(updated.team_name);
      found.agent.cron_tasks.splice(found.index, 1);
      targetAgent.cron_tasks.push(updated);
      this.saveConfigToDisk();
      return true;
    }
    found.agent.cron_tasks[found.index] = updated;
    this.saveConfigToDisk();
    return true;
  }

  deleteCronTask(taskId: string): boolean {
    const found = this.findCronTask(taskId);
    if (!found) {
      return false;
    }
    found.agent.cron_tasks.splice(found.index, 1);
    this.cronHistory.delete(taskId);
    this.saveConfigToDisk();
    return true;
  }

  async triggerCronTask(taskId: string): Promise<{ status: "ok"; result: string | null }> {
    const found = this.findCronTask(taskId);
    if (!found || !found.task.enabled) {
      throw new DaemonServiceError(404, `任务不存在或执行失败: ${taskId}`);
    }
    const startedAt = Date.now();
    try {
      const sessionId = this.resolveSessionId(found.agent, "feishu", `cron:${taskId}`);
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
      this.recordCronHistory(taskId, {
        timestamp: now,
        success: true,
        result: result.slice(0, 200),
        error: null,
        elapsed: (Date.now() - startedAt) / 1000,
      });
      if (found.task.push_platform && found.task.push_chat_id) {
        this.sendMessage({
          platform: found.task.push_platform,
          chat_id: found.task.push_chat_id,
          content: result,
          message_type: "text",
        });
      }
      this.saveConfigToDisk();
      return { status: "ok", result: result || null };
    } catch (error) {
      const now = Date.now() / 1000;
      const message = error instanceof Error ? error.message : String(error);
      found.task.last_run = now;
      found.task.last_result = `ERROR: ${message}`;
      this.recordCronHistory(taskId, {
        timestamp: now,
        success: false,
        result: "",
        error: message,
        elapsed: (Date.now() - startedAt) / 1000,
      });
      this.saveConfigToDisk();
      throw new DaemonServiceError(400, message);
    }
  }

  getCronHistory(taskId: string, limit: number): Array<Record<string, unknown>> {
    const items = this.cronHistory.get(taskId) ?? [];
    const boundedLimit = Math.max(0, Math.floor(limit));
    return items.slice(0, boundedLimit);
  }

  close(): void {
    this.stop();
  }

  private toAgentStatus(agent: DaemonAgentConfig): Record<string, unknown> {
    return {
      team_name: agent.team_name,
      entry_agent: agent.entry_agent,
      enabled: agent.enabled,
      running: this.running && agent.enabled,
      runtime: "local",
      platforms: Object.fromEntries(
        Object.entries(agent.platforms).map(([platform, connection]) => {
          const status = this.platformStatuses.get(platform as PlatformType);
          return [
            platform,
            {
              enabled: connection.enabled,
              status: status?.status ?? "disconnected",
              last_heartbeat: status?.last_heartbeat ?? null,
              latency_ms: status?.latency_ms ?? null,
              error: status?.error ?? null,
              reconnect_attempts: status?.reconnect_attempts ?? 0,
            },
          ];
        }),
      ),
      cron_task_count: agent.cron_tasks.length,
    };
  }

  private ensureAgent(teamName: string): DaemonAgentConfig {
    const existing = this.config.agents.find((agent) => agent.team_name === teamName);
    if (existing) {
      return existing;
    }
    const agent: DaemonAgentConfig = {
      team_name: teamName,
      entry_agent: null,
      session_id: null,
      permissions: {
        mode: "standard",
        auto_accept_patterns: [],
        audit_all_checks: false,
        approval_timeout: 300,
        skip_all_approvals: false,
      },
      platforms: {},
      cron_tasks: [],
      heartbeat_interval: 30,
      enabled: true,
    };
    this.config.agents.push(agent);
    return agent;
  }

  private findCronTask(taskId: string): { agent: DaemonAgentConfig; task: CronTask; index: number } | null {
    for (const agent of this.config.agents) {
      const index = agent.cron_tasks.findIndex((task) => task.task_id === taskId);
      if (index >= 0) {
        const task = agent.cron_tasks[index];
        if (task) {
          return { agent, task, index };
        }
      }
    }
    return null;
  }

  private resolveSessionId(agent: DaemonAgentConfig, platform: PlatformType, chatId: string): string {
    const connection = agent.platforms[platform];
    const explicit = connection?.session_id ?? agent.session_id;
    const key = `${agent.team_name}:${platform}:${chatId}`;
    const sessionId = explicit?.trim() || this.daemonSessions.get(key)?.sessionId || `daemon-${agent.team_name}-${platform}-${safeSessionPart(chatId)}`;
    this.daemonSessions.set(key, { sessionId, lastSeen: Date.now() / 1000 });
    return sessionId;
  }

  private getHeartbeatHistory(platform: PlatformType, limit: number): Array<Record<string, unknown>> {
    const items = this.heartbeatHistory.get(platform) ?? [];
    const boundedLimit = Math.max(0, Math.floor(limit));
    return items.slice(0, boundedLimit);
  }

  private recordHeartbeat(status: PlatformRuntimeStatus): void {
    const history = this.heartbeatHistory.get(status.platform) ?? [];
    history.unshift({
      timestamp: Date.now() / 1000,
      status: status.status,
      latency_ms: status.latency_ms,
      error: status.error,
      reconnect_attempts: status.reconnect_attempts,
    });
    this.heartbeatHistory.set(status.platform, history.slice(0, 50));
  }

  private recordCronHistory(taskId: string, item: Record<string, unknown>): void {
    const history = this.cronHistory.get(taskId) ?? [];
    history.unshift(item);
    this.cronHistory.set(taskId, history.slice(0, 50));
  }

  private syncCronHistoryKeys(): void {
    const taskIds = new Set(this.listCronTasks().map((task) => task.task_id));
    for (const taskId of taskIds) {
      if (!this.cronHistory.has(taskId)) {
        this.cronHistory.set(taskId, []);
      }
    }
    for (const taskId of this.cronHistory.keys()) {
      if (!taskIds.has(taskId)) {
        this.cronHistory.delete(taskId);
      }
    }
  }

  private refreshNextRunTimes(): void {
    for (const found of this.config.agents.flatMap((agent) => agent.cron_tasks.map((task) => ({ agent, task })))) {
      if (found.task.enabled) {
        found.task.next_run = computeNextRun(found.task.cron);
      }
    }
  }

  private loadConfigFromDisk(): void {
    if (!this.configPath || !fs.existsSync(this.configPath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.configPath, "utf8");
      const parsed = YAML.parse(raw) as unknown;
      if (isRecord(parsed)) {
        this.config = cloneConfig(parsed as DaemonSystemConfig);
      }
    } catch {
      this.config = { enabled: false, agents: [], default_session_ttl: 86400 };
    }
  }

  private saveConfigToDisk(): void {
    if (!this.configPath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, YAML.stringify(this.config), "utf8");
  }
}

interface PlatformRuntimeStatus {
  platform: PlatformType;
  status: "connected" | "disconnected" | "error";
  last_heartbeat: number | null;
  latency_ms: number | null;
  error: string | null;
  reconnect_attempts: number;
}

function buildConnectedStatus(platform: PlatformType, nowMs: number): PlatformRuntimeStatus {
  return {
    platform,
    status: "connected",
    last_heartbeat: nowMs / 1000,
    latency_ms: 0,
    error: null,
    reconnect_attempts: 0,
  };
}

function cloneConfig(config: DaemonSystemConfig): DaemonSystemConfig {
  return structuredClone(config) as DaemonSystemConfig;
}

function cloneTask(task: CronTask): CronTask {
  return structuredClone(task) as CronTask;
}

function compactCronTaskUpdate(updates: CronTaskUpdate): Partial<CronTask> {
  const compact: Partial<CronTask> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      (compact as Record<string, unknown>)[key] = value;
    }
  }
  return compact;
}

function computeNextRun(cron: string): number | null {
  const next = nextCronTime(cron);
  return next ? next.getTime() / 1000 : null;
}

function nextCronTime(cron: string, after = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }
  let dt = new Date(after.getTime());
  dt.setSeconds(0, 0);
  dt = new Date(dt.getTime() + 60_000);
  const limit = new Date(dt.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (dt < limit) {
    if (matchesCron(cron, dt)) {
      return dt;
    }
    dt = new Date(dt.getTime() + 60_000);
  }
  return null;
}

function matchesCron(cron: string, dt: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  const [minute, hour, dom, month, dow] = parts;
  if (!minute || !hour || !dom || !month || !dow) {
    return false;
  }
  const cronDow = dt.getDay();
  if (!parseCronField(minute, 0, 59).has(dt.getMinutes())) {
    return false;
  }
  if (!parseCronField(hour, 0, 23).has(dt.getHours())) {
    return false;
  }
  if (!parseCronField(month, 1, 12).has(dt.getMonth() + 1)) {
    return false;
  }
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  if (domRestricted && dowRestricted) {
    return parseCronField(dom, 1, 31).has(dt.getDate()) || parseCronField(dow, 0, 6).has(cronDow);
  }
  return parseCronField(dom, 1, 31).has(dt.getDate()) && parseCronField(dow, 0, 6).has(cronDow);
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      addRange(values, min, max, 1);
      continue;
    }
    if (part.includes("/")) {
      const [base, stepRaw] = part.split("/");
      const step = Math.max(1, Number(stepRaw) || 1);
      const start = base === "*" ? min : Number(base);
      addRange(values, Number.isFinite(start) ? start : min, max, step);
      continue;
    }
    if (part.includes("-")) {
      const [startRaw, endRaw] = part.split("-");
      addRange(values, Number(startRaw), Number(endRaw), 1);
      continue;
    }
    const value = Number(part);
    if (Number.isInteger(value) && value >= min && value <= max) {
      values.add(value);
    }
  }
  return values;
}

function addRange(values: Set<number>, start: number, end: number, step: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return;
  }
  for (let value = Math.max(start, 0); value <= end; value += step) {
    values.add(value);
  }
}

function safeSessionPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "default";
}

function defaultRunAgentTask(input: DaemonRunAgentInput): string {
  return `submitted:${input.source}:${input.teamName}:${input.task}`;
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
