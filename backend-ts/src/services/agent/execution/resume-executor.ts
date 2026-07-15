import { randomUUID } from "node:crypto";

import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import type { ApprovalCacheResolution, PendingInteractionService } from "../../runtime/pending-interaction-service.js";
import { asString } from "./helpers.js";
import { resolveReadyAgent } from "./readiness.js";
import type { AgentRunEngine } from "./run-engine.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";

export interface ResumeRunInput {
  sessionId: string;
  approvalId: string;
  resolution: ApprovalCacheResolution;
  onCompleted?: ((result: { content: string; success: boolean }) => void) | undefined;
  onSuspended?: ((approvalId: string) => void) | undefined;
}

export interface ResumeRunResult {
  rootRunId: string;
  approvalId: string;
  toolCallId: string;
}

export interface ResumeExecutor {
  resumeRun(input: ResumeRunInput): ResumeRunResult;
}

export function createResumeExecutor(deps: {
  runEngine: AgentRunEngine;
  conversationStore: ConversationStore;
  pendingInteractions: PendingInteractionService;
  runtimeCore: RuntimeExecutionConfigResolver;
}): ResumeExecutor {
  return {
    resumeRun(input) {
      const meta = deps.pendingInteractions.takeApprovalMeta(input.approvalId);
      if (!meta || meta.sessionId !== input.sessionId) {
        throw new Error("未找到可恢复的挂起交互");
      }

      const run = deps.conversationStore.getRun(input.sessionId, meta.rootRunId);
      if (!run || run.status !== "suspended" || !run.agent_name) {
        throw new Error("挂起 run 不存在或状态不可恢复");
      }

      const sessionMetadata = deps.conversationStore.getSession(input.sessionId)?.metadata ?? {};
      const ready = resolveReadyAgent(
        deps.runtimeCore,
        {
          agentName: run.agent_name,
          teamName: asString(sessionMetadata.team),
        },
        sessionMetadata,
      );
      if (!ready.ok) {
        throw new Error(ready.reason);
      }

      const rootCallId = findRootCallId(deps.conversationStore, input.sessionId, meta.rootRunId);
      deps.pendingInteractions.setApprovalCache(input.sessionId, meta.toolCallId, input.resolution);
      if (!deps.conversationStore.updateRunStatus(meta.rootRunId, input.sessionId, "running", null)) {
        throw new Error("更新挂起 run 状态失败");
      }

      const started = deps.runEngine.startRun({
        sessionId: input.sessionId,
        runId: meta.rootRunId,
        rootCallId,
        resume: true,
        userId: run.user_id,
        requestId: meta.requestId ?? run.request_id ?? randomUUID(),
        task: meta.task,
        executionKind: meta.executionKind ?? run.entrypoint ?? "agent_stream",
        entrypoint: run.entrypoint ?? undefined,
        agent: ready.agent,
        provider: ready.provider,
        modelName: ready.modelName,
      });

      void started.promise
        .then((result) => {
          if (result.suspended) {
            const next = deps.pendingInteractions.findLatestApprovalMeta(meta.rootRunId);
            if (next) {
              input.onSuspended?.(next.approvalId);
            } else {
              input.onCompleted?.({ content: "续跑再次挂起，但未找到待处理交互", success: false });
            }
            return;
          }
          input.onCompleted?.({ content: result.content, success: result.success });
        })
        .catch((error: unknown) => {
          input.onCompleted?.({
            content: error instanceof Error ? error.message : String(error),
            success: false,
          });
        });

      return {
        rootRunId: meta.rootRunId,
        approvalId: meta.approvalId,
        toolCallId: meta.toolCallId,
      };
    },
  };
}

function findRootCallId(store: ConversationStore, sessionId: string, runId: string): string {
  const step = store.listRunSteps({ sessionId, runId, limit: 500 }).find((item) => {
    const payload = item.payload;
    if (payload.type !== "agent_started") {
      return false;
    }
    const eventPayload = payload.payload;
    if (!eventPayload || typeof eventPayload !== "object" || Array.isArray(eventPayload)) {
      return true;
    }
    const lineage = (eventPayload as Record<string, unknown>).lineage;
    return !lineage || typeof lineage !== "object" || !("parent_call_id" in lineage);
  });
  const callId = step?.payload.call_id;
  return typeof callId === "string" && callId ? callId : `call_${randomUUID()}`;
}
