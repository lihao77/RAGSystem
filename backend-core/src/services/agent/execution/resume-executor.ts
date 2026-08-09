import { randomUUID } from "node:crypto";

import type { InteractionResumeStarter } from "../../../contracts/runtime/pending-interactions.js";
import { asString } from "./helpers.js";
import { resolveReadyAgent } from "./readiness.js";
import { applyWorkspaceOverride } from "../delegation/helpers.js";
import type { AgentInvocationPort } from "../../../contracts/execution/agent-invocation.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";

export function createResumeExecutor(deps: {
  invocationService: AgentInvocationPort;
  runtimeCore: RuntimeExecutionConfigResolver;
}): InteractionResumeStarter {
  return {
    startClaim({ sessionId, claim }) {
      const ready = resolveReadyAgent(
        deps.runtimeCore,
        {
          agentName: claim.agentName,
          teamName: asString(claim.sessionIdentity.metadata?.team),
        },
        claim.sessionIdentity.metadata ?? {},
      );
      if (!ready.ok) throw new Error(ready.reason);
      if (claim.childAgentId) {
        return deps.invocationService.invoke({
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
      }
      return deps.invocationService.invoke({
        scope: "root",
        mode: "resume",
        execution: "foreground",
        sessionId,
        sessionIdentity: claim.sessionIdentity,
        runId: claim.rootRunId,
        rootCallId: claim.rootCallId,
        userId: claim.userId,
        requestId: claim.requestId ?? randomUUID(),
        task: claim.task,
        executionKind: claim.executionKind,
        agent: ready.agent,
        provider: ready.provider,
        modelName: ready.modelName,
      });
    },
  };
}
