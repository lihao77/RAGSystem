import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";

/** A user message accepted while a root run is active, but not yet durable. */
export interface DeferredSessionFollowup {
  activeRunId: string;
  sessionId: string;
  requestId: string;
  displayTask: string;
  modelTask: string;
  metadata: Record<string, unknown>;
  userId: string | null;
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName: string;
  selectedLlm: { provider: ModelProviderConfig; modelName: string } | null;
}

/**
 * Keeps follow-ups out of conversation history until the active root run starts
 * its next round. Entries are FIFO per root run, which preserves their order.
 */
export class SessionFollowupQueue {
  private readonly pendingByRun = new Map<string, DeferredSessionFollowup[]>();

  enqueue(entry: DeferredSessionFollowup): void {
    const pending = this.pendingByRun.get(entry.activeRunId) ?? [];
    pending.push(entry);
    this.pendingByRun.set(entry.activeRunId, pending);
  }

  drain(runId: string): DeferredSessionFollowup[] {
    const pending = this.pendingByRun.get(runId) ?? [];
    this.pendingByRun.delete(runId);
    return pending;
  }
}
