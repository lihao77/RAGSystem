import type {
  CronTask,
  CronTaskUpdate,
  DaemonAgentConfig,
  DaemonSystemConfig,
} from "../contracts/daemon.js";

export class DaemonServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DaemonServiceError";
    this.statusCode = statusCode;
  }
}

export class DaemonService {
  private config: DaemonSystemConfig = {
    enabled: false,
    agents: [],
    default_session_ttl: 86400,
  };
  private readonly cronHistory = new Map<string, unknown[]>();

  getStatus(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      running: false,
      runtime: "not_migrated",
      adapter_count: 0,
      daemon_sessions: 0,
      agents_count: this.config.agents.length,
      cron_task_count: this.listCronTasks().length,
    };
  }

  getConfig(): DaemonSystemConfig {
    return cloneConfig(this.config);
  }

  updateConfig(config: DaemonSystemConfig): { status: "ok"; message: string } {
    this.config = cloneConfig(config);
    this.syncCronHistoryKeys();
    return {
      status: "ok",
      message: "配置已保存，启动守护系统后生效",
    };
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
    void limit;
    return {
      team_name: teamName,
      heartbeats: Object.fromEntries(Object.keys(agent.platforms).map((platform) => [platform, []])),
    };
  }

  listCronTasks(): CronTask[] {
    return this.config.agents.flatMap((agent) => agent.cron_tasks.map((task) => cloneTask(task)));
  }

  createCronTask(task: CronTask): string {
    if (this.findCronTask(task.task_id)) {
      throw new DaemonServiceError(400, `任务已存在: ${task.task_id}`);
    }
    const agent = this.ensureAgent(task.team_name);
    agent.cron_tasks.push(cloneTask(task));
    this.cronHistory.set(task.task_id, []);
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
    if (updated.team_name !== found.agent.team_name) {
      const targetAgent = this.ensureAgent(updated.team_name);
      found.agent.cron_tasks.splice(found.index, 1);
      targetAgent.cron_tasks.push(updated);
      return true;
    }
    found.agent.cron_tasks[found.index] = updated;
    return true;
  }

  deleteCronTask(taskId: string): boolean {
    const found = this.findCronTask(taskId);
    if (!found) {
      return false;
    }
    found.agent.cron_tasks.splice(found.index, 1);
    this.cronHistory.delete(taskId);
    return true;
  }

  getCronHistory(taskId: string, limit: number): unknown[] {
    const items = this.cronHistory.get(taskId) ?? [];
    const boundedLimit = Math.max(0, Math.floor(limit));
    return items.slice(0, boundedLimit);
  }

  private toAgentStatus(agent: DaemonAgentConfig): Record<string, unknown> {
    return {
      team_name: agent.team_name,
      entry_agent: agent.entry_agent,
      enabled: agent.enabled,
      running: false,
      runtime: "not_migrated",
      platforms: Object.fromEntries(
        Object.entries(agent.platforms).map(([platform, connection]) => [
          platform,
          {
            enabled: connection.enabled,
            status: "disconnected",
            last_heartbeat: null,
            latency_ms: null,
            error: null,
            reconnect_attempts: 0,
          },
        ]),
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
