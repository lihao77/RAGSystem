import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type { DaemonBotRepository } from "./contracts/bot-repository.js";
import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";

import type { DaemonLeaderLease } from "./contracts/daemon-leader-lease.js";
import {
  DaemonService,
  type DaemonRunAgentInput,
  type DaemonRunAgentResult,
  type DaemonSuspendedInteraction,
} from "./services/daemon-service.js";

export interface DaemonApplicationRuntime {
  readonly service: DaemonService;
  start(): Promise<void>;
  dispose(): void;
}

export function createDaemonApplicationRuntime(input: {
  botRepository: DaemonBotRepository;
  registry: RuntimeContainerRegistry;
  logger: FastifyBaseLogger;
  leaderLease?: DaemonLeaderLease;
}): DaemonApplicationRuntime {
  const service = new DaemonService({
    botRepository: input.botRepository,
    registry: input.registry,
    ...(input.leaderLease ? { leaderLease: input.leaderLease } : {}),
    runAgentTask: (task) => runAgentTask(input, task),
  });
  return {
    service,
    start: () => service.start(),
    dispose: () => service.close(),
  };
}

async function runAgentTask(
  dependencies: {
    botRepository: DaemonBotRepository;
    registry: RuntimeContainerRegistry;
    logger: FastifyBaseLogger;
  },
  input: DaemonRunAgentInput,
): Promise<DaemonRunAgentResult> {
  const lease = await dependencies.registry.acquire(input.tenantId);
  try {
    try {
      const existing = await lease.runtime.sessionApplication.getSession(input.sessionId);
      let createMetadata = input.sessionMetadata ? { ...input.sessionMetadata } : {};
      if (!existing) {
        const teams = await lease.runtime.agentConfig.listTeams();
        const configuredTeam = typeof input.team === "string" ? input.team.trim() : "";
        const team = configuredTeam || teams.active_team || "";
        if (team) createMetadata = { ...createMetadata, team };
        let entryAgent = typeof input.entryAgent === "string" ? input.entryAgent.trim() : "";
        if (!entryAgent) {
          const configs = lease.runtime.agentConfig.listConfigs({ teamName: team || null });
          const defaultEntry = Object.values(configs).find((config) => config.default_entry);
          entryAgent = defaultEntry?.agent_name?.trim() || "";
        }
        if (entryAgent) createMetadata = { ...createMetadata, entry_agent: entryAgent };
      } else {
        const { team: _team, entry_agent: _entry, ...channelMeta } = createMetadata as Record<string, unknown>;
        createMetadata = channelMeta;
      }
      const sessionBot = await dependencies.botRepository.get(input.botId);
      if (!sessionBot) throw new Error(`bot 不存在: ${input.botId}`);
      await lease.runtime.sessionApplication.ensureSession({
        sessionId: input.sessionId,
        ownerUserId: sessionBot.owner_id,
        visibility: "private",
        originType: "bot",
        originId: input.botId,
        originChannel: input.source.includes("cron") ? "cron" : input.source.includes("feishu") ? "feishu" : "api",
        workspaceId: null,
        ...(Object.keys(createMetadata).length > 0 ? { metadata: createMetadata } : {}),
        permissionMode: input.permissionMode,
      });
      const scheduledBatches = new Set<string>();
      const onInteractionRequired = (notice: { rootRunId: string; batchId: string }): void => {
        if (scheduledBatches.has(notice.batchId)) return;
        scheduledBatches.add(notice.batchId);
        queueMicrotask(() => void (async () => {
          scheduledBatches.delete(notice.batchId);
          const metas = (await lease.runtime.interactionCoordinator.listPendingAsync(
            notice.rootRunId,
            input.sessionId,
          )).map((item): DaemonSuspendedInteraction => ({
            approvalId: item.approvalId,
            sessionId: item.sessionId,
            botId: input.botId,
            rootRunId: item.rootRunId,
            kind: item.kind,
            ...(item.toolName ? { toolName: item.toolName } : {}),
            ...(item.riskLevel ? { riskLevel: item.riskLevel } : {}),
            ...(item.reason ? { reason: item.reason } : {}),
            ...(item.prompt ? { prompt: item.prompt } : {}),
            ...(item.options ? { options: item.options } : {}),
          }));
          if (metas.length > 0) input.onInteractionRequired?.(metas);
        })().catch((error: unknown) => {
          dependencies.logger.error({ error, sessionId: input.sessionId }, "failed to load daemon pending interactions");
        }));
      };
      const result = await lease.runtime.agentExecution.executeSynchronously({
        task: input.task,
        session_id: input.sessionId,
        agent: input.entryAgent,
        userId: input.botId,
        executionKind: input.source,
        onInteractionRequired,
      }, randomUUID());
      if (!result.success && !result.suspended) throw new Error(result.error ?? "agent 执行失败");
      if (result.suspended) {
        const rootRunId = result.rootRunId ?? result.run_id ?? "";
        const metas = await lease.runtime.interactionCoordinator.listPendingAsync(rootRunId, input.sessionId);
        const interactions = metas.map((item): DaemonSuspendedInteraction => ({
          approvalId: item.approvalId,
          sessionId: item.sessionId,
          botId: input.botId,
          rootRunId: item.rootRunId,
          kind: item.kind,
          ...(item.toolName ? { toolName: item.toolName } : {}),
          ...(item.riskLevel ? { riskLevel: item.riskLevel } : {}),
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.prompt ? { prompt: item.prompt } : {}),
          ...(item.options ? { options: item.options } : {}),
        }));
        if (interactions.length === 0) throw new Error("Agent 已挂起，但未找到待处理交互");
        return {
          suspended: true,
          content: "",
          interaction: interactions[0]!,
          interactions,
        };
      }
      return { suspended: false, content: result.answer ?? "" };
    } finally {
      if (input.sessionMetadata) {
        const { team: _team, entry_agent: _entry, ...channelMeta } = input.sessionMetadata;
        if (Object.keys(channelMeta).length > 0) {
          await lease.runtime.sessionApplication.updateSessionMetadata(input.sessionId, channelMeta);
        }
      }
    }
  } finally {
    lease.release();
  }
}
