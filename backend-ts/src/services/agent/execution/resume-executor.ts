import { randomUUID } from "node:crypto";

import type { InteractionResumeStarter } from "../../../contracts/runtime/pending-interactions.js";
import { asString } from "./helpers.js";
import { resolveReadyAgent } from "./readiness.js";
import type { AgentRunEngine } from "./run-engine.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";

export function createResumeExecutor(deps: {
  runEngine: AgentRunEngine;
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
      return deps.runEngine.startRun({
        sessionId,
        sessionIdentity: claim.sessionIdentity,
        runId: claim.rootRunId,
        rootCallId: claim.rootCallId,
        resume: true,
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
