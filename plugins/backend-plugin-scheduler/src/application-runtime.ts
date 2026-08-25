import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";

import type { SchedulerLeaderLease } from "./contracts/leader-lease.js";
import { schedulerDeliveryChannelToken } from "./contracts/delivery.js";
import type { SchedulerTaskStore } from "./contracts/task-store.js";
import type { SchedulerTask } from "./contracts/task.js";
import { SchedulerService, resolveSessionId, type SchedulerRunOutcome } from "./services/scheduler-service.js";

export interface SchedulerApplicationRuntime {
  readonly service: SchedulerService;
  start(): Promise<void>;
  dispose(): void;
}

export function createSchedulerApplicationRuntime(input: {
  taskStore: SchedulerTaskStore;
  registry: RuntimeContainerRegistry;
  logger: FastifyBaseLogger;
  leaderLease?: SchedulerLeaderLease;
  tickMs?: number;
}): SchedulerApplicationRuntime {
  const service = new SchedulerService({
    taskStore: input.taskStore,
    ...(input.leaderLease ? { leaderLease: input.leaderLease } : {}),
    ...(input.tickMs !== undefined ? { tickMs: input.tickMs } : {}),
    runTask: (taskInput) => runScheduledTask(input, taskInput.tenantId, taskInput.task),
    deliver: async (delivery) => {
      const lease = await input.registry.acquire(delivery.tenantId);
      try {
        const token = schedulerDeliveryChannelToken(delivery.channel);
        const capabilities = lease.runtime.pluginCapabilities;
        if (!capabilities.has(token)) return false;
        await capabilities.require(token).deliver(delivery);
        return true;
      } finally {
        lease.release();
      }
    },
  });
  return {
    service,
    start: () => service.start(),
    dispose: () => service.close(),
  };
}

/** 到点执行：acquire 租户运行时 → 幂等建 cron 会话 → 同步执行 agent。 */
async function runScheduledTask(
  dependencies: { registry: RuntimeContainerRegistry; logger: FastifyBaseLogger },
  tenantId: SchedulerTask["tenant_id"],
  task: SchedulerTask,
): Promise<SchedulerRunOutcome> {
  const lease = await dependencies.registry.acquire(tenantId);
  const sessionId = resolveSessionId(task);
  try {
    const existing = await lease.runtime.sessionApplication.getSession(sessionId);
    const teamSnapshot = existing?.team_snapshot ?? lease.runtime.agentConfig.createTeamSnapshot({
      teamName: task.team,
      entryAgentName: task.entry_agent,
    });
    await lease.runtime.sessionApplication.ensureSession({
      sessionId,
      ownerUserId: task.owner_user_id,
      visibility: "private",
      originType: "bot",
      originId: task.task_id,
      originChannel: "cron",
      workspaceId: null,
      teamSnapshot,
      permissionMode: task.permission_mode,
    });
    const result = await lease.runtime.agentExecution.executeSynchronously({
      task: task.task,
      session_id: sessionId,
      agent: teamSnapshot.entry_agent_name,
      userId: task.owner_user_id,
      executionKind: "scheduler.cron",
    }, randomUUID());
    if (!result.success && !result.suspended) throw new Error(result.error ?? "agent 执行失败");
    if (result.suspended) {
      // 挂起交互留在会话内等待处理；如配置了投递通道，由 service 层的 deliver 通知。
      return { suspended: true, content: "" };
    }
    return { suspended: false, content: result.answer ?? "" };
  } finally {
    lease.release();
  }
}
