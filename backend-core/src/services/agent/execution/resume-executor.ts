import { randomUUID } from "node:crypto";

import type { InteractionResumeStarter } from "../../../contracts/runtime/pending-interactions.js";
import { resolveReadyAgent } from "./readiness.js";
import { applyWorkspaceOverride } from "../delegation/helpers.js";
import type { AgentInvocationPort } from "../../../contracts/execution/agent-invocation.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import type { ParticipantRunLifecyclePort } from "../delegation/port.js";
import { readSessionRequestOverrides, type SessionRequestOverrides } from "./session-request-overrides.js";
import {
  mailboxContinuationSourceMessageId,
  type AgentMailboxContinuationCompletionInput,
} from "./launchers.js";

export function createResumeExecutor(deps: {
  invocationService: AgentInvocationPort;
  runtimeCore: RuntimeExecutionConfigResolver;
  participantRuns: ParticipantRunLifecyclePort;
  completeAgentMailboxContinuation(input: AgentMailboxContinuationCompletionInput): Promise<void>;
  /**
   * 读会话级请求覆盖设定（模型/思考档位）。挂起的 run 多为用户带设定发起——恢复时
   * 从会话 metadata 读回（挂起期间发送通道被占用，设定不会漂移），保证同一 run
   * 恢复前后执行口径一致。缺省（未注入/读取失败）按未设定处理，回落 agent tier。
   */
  readSessionRequestOverrides?: (sessionId: string) =>
    Promise<SessionRequestOverrides> | SessionRequestOverrides;
}): InteractionResumeStarter {
  const resolveOverrides = async (sessionId: string): Promise<SessionRequestOverrides> => {
    if (!deps.readSessionRequestOverrides) return { selectedLlm: null, thinkingLevel: null };
    try {
      return await deps.readSessionRequestOverrides(sessionId);
    } catch {
      return { selectedLlm: null, thinkingLevel: null };
    }
  };
  return {
    async startClaim({ sessionId, claim }) {
      // 子 Agent 挂起恢复走自己的 tier 配置；主智能体（root）恢复走会话级设定。
      const overrides = claim.childAgentId
        ? { selectedLlm: null, thinkingLevel: null }
        : await resolveOverrides(sessionId);
      const ready = resolveReadyAgent(
        deps.runtimeCore,
        {
          agentName: claim.agentName,
          teamSnapshot: claim.sessionIdentity.teamSnapshot,
          selectedLlm: overrides.selectedLlm,
        },
      );
      if (!ready.ok) throw new Error(ready.reason);
      if (claim.childAgentId) {
        await deps.participantRuns.registerParticipantRun({
          sessionId,
          childAgentId: claim.childAgentId,
          runId: claim.rootRunId,
          agentCallId: claim.rootCallId,
          rootRunId: claim.rootRunId,
          parentRunId: claim.parentRunId,
          parentCallId: claim.parentCallId,
          lineageParentCallId: claim.lineageParentCallId,
        });
        try {
          const handle = deps.invocationService.invoke({
            scope: "child",
            mode: "resume",
            execution: "background",
            sessionId,
            sessionIdentity: claim.sessionIdentity,
            runId: claim.rootRunId,
            taskId: randomUUID(),
            rootCallId: claim.rootCallId,
            interactionRootCallId: claim.rootCallId,
            parentCallId: claim.parentCallId,
            lineageParentCallId: claim.lineageParentCallId,
            requestId: claim.requestId ?? randomUUID(),
            task: claim.task,
            startedAt: new Date(),
            userId: claim.userId ?? claim.sessionIdentity.ownerUserId,
            agent: applyWorkspaceOverride(ready.agent, claim.workspaceRoot),
            provider: ready.provider,
            modelName: ready.modelName,
            threadKey: claim.threadKey,
            rootRunId: claim.rootRunId,
            parentRunId: claim.parentRunId,
            childAgentId: claim.childAgentId,
            ownsRunLease: true,
            executionKind: claim.executionKind,
            rootTask: claim.task,
          });
          return {
            promise: handle.promise.then(async (outcome) => {
              if (claim.executionKind === "system.agent_message" && !outcome.suspended) {
                const sourceMessageId = mailboxContinuationSourceMessageId(claim.requestId);
                await deps.completeAgentMailboxContinuation({
                  sessionId,
                  sourceRunId: claim.rootRunId,
                  sourceAgentCallId: claim.rootCallId,
                  sourceAgentName: claim.agentName,
                  sourceChildAgentId: claim.childAgentId!,
                  parentRunId: claim.parentRunId,
                  replyToMessageId: sourceMessageId,
                  outcome,
                });
              }
              return outcome;
            }).finally(() => {
              deps.participantRuns.releaseParticipantRun({
                childAgentId: claim.childAgentId!,
                runId: claim.rootRunId,
              });
            }),
          };
        } catch (error) {
          deps.participantRuns.releaseParticipantRun({
            childAgentId: claim.childAgentId,
            runId: claim.rootRunId,
          });
          throw error;
        }
      }
      return deps.invocationService.invoke({
        scope: "root",
        mode: "resume",
        execution: "foreground",
        sessionId,
        sessionIdentity: claim.sessionIdentity,
        runId: claim.rootRunId,
        rootCallId: claim.rootCallId,
        userId: claim.userId ?? claim.sessionIdentity.ownerUserId,
        requestId: claim.requestId ?? randomUUID(),
        task: claim.task,
        executionKind: claim.executionKind,
        agent: ready.agent,
        provider: ready.provider,
        modelName: ready.modelName,
        ...(overrides.selectedLlm ? { selectedLlm: { provider: ready.provider, modelName: ready.modelName } } : {}),
        ...(overrides.thinkingLevel ? { thinkingLevel: overrides.thinkingLevel } : {}),
      });
    },
  };
}
