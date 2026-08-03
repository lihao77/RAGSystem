import {
  SessionRuntimePayloadSchema,
  SESSION_LOAD_STRATEGY_BY_STATE,
  type SessionRuntimeAction,
  type SessionRuntimePayload,
  type SessionRuntimeState,
} from "../../contracts/events.js";
import type { PendingInteractionRecord, RunInfo } from "../../contracts/conversation-store/index.js";
import type { RuntimeSessionFacts, RuntimeStorage } from "../../contracts/storage/runtime-storage.js";
import { EnvelopeProjector } from "./event-outbox/projector.js";

/** Projects all durable Session lifecycle facts into the single client-facing runtime snapshot. */
export class SessionRuntimeService {
  constructor(private readonly storage: RuntimeStorage) {}

  async getSnapshot(sessionId: string): Promise<SessionRuntimePayload> {
    const facts = await this.storage.operations.getSessionRuntimeFacts(sessionId);
    if (!facts.session) throw new Error(`session not found: ${sessionId}`);
    return projectSessionRuntime(facts);
  }

}

export function projectSessionRuntime(facts: RuntimeSessionFacts): SessionRuntimePayload {
  if (!facts.session) throw new Error("cannot project runtime for a missing session");
  const maintenance = activeMaintenance(facts.session.metadata);
  const state = projectState(facts, maintenance !== null);
  const activeRun = facts.activeRootRun
    ? {
        run_id: facts.activeRootRun.run_id,
        status: state as "running" | "waiting_interaction" | "suspended" | "resuming",
        execution_owner: state === "suspended"
          ? "detached" as const
          : facts.ownedByCurrentInstance ? "attached" as const : "remote" as const,
        task: facts.activeRootRun.task_summary ?? "",
        request_id: facts.activeRootRun.request_id,
        execution_kind: facts.activeRootRun.entrypoint ?? "agent_stream",
        started_at: facts.activeRootRun.created_at,
        updated_at: facts.activeRootRun.updated_at,
        activity: projectActiveRunActivity(facts),
      }
    : null;
  const lastRun = terminalLastRun(facts.latestTerminalRootRun);
  const presentableStatuses = new Set(["waiting", "suspended"]);
  const pendingInteractions = facts.pendingInteractions
    .filter((interaction) => presentableStatuses.has(interaction.status))
    .map(projectPendingInteraction);
  const resumeInteractionId = state === "suspended" && pendingInteractions.length === 0
    ? facts.pendingInteractions.find((interaction) => interaction.status === "resolved")?.interaction_id ?? null
    : null;
  const payload = {
    state,
    load_strategy: SESSION_LOAD_STRATEGY_BY_STATE[state],
    allowed_actions: allowedActions(
      state,
      facts.ownedByCurrentInstance,
      pendingInteractions.length > 0,
      resumeInteractionId !== null,
    ),
    active_run: activeRun,
    last_run: lastRun,
    pending_interactions: pendingInteractions,
    resume_interaction_id: resumeInteractionId,
    maintenance,
    observed_at: new Date().toISOString(),
  };
  return SessionRuntimePayloadSchema.parse(payload);
}

type ActiveRun = NonNullable<SessionRuntimePayload["active_run"]>;
type RuntimeActivity = ActiveRun["activity"];
type RuntimeModelActivity = RuntimeActivity["models"][number];
type RuntimeToolActivity = RuntimeActivity["tools"][number];

function projectActiveRunActivity(facts: RuntimeSessionFacts): RuntimeActivity {
  const fallbackUpdatedAt = facts.activeRootRun?.updated_at ?? new Date().toISOString();
  const models = new Map<string, RuntimeModelActivity>();
  const tools = new Map<string, RuntimeToolActivity>();
  const projector = new EnvelopeProjector();
  let updatedAt = fallbackUpdatedAt;

  for (const row of facts.activeRunEvents) {
    let event;
    try {
      event = projector.toEnvelope(row);
    } catch {
      continue;
    }
    const eventUpdatedAt = row.created_at || fallbackUpdatedAt;
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    const agentId = typeof event.agent_id === "string" ? event.agent_id : "";
    const payload = asRecord(event.payload);
    const modelKey = callId ? `${agentId}\u0000${callId}` : "";

    if (event.type === "model_request" && modelKey) {
      models.set(modelKey, {
        call_id: callId,
        agent_id: agentId,
        round: nonnegativeInteger(payload.round),
        status: "requested",
        attempt_id: null,
        attempt: null,
        max_attempts: null,
        provider: null,
        model: null,
        started_at: null,
        retry_at: null,
        error: null,
        updated_at: eventUpdatedAt,
      });
      updatedAt = eventUpdatedAt;
      continue;
    }

    if (event.type === "model_attempt_started" && modelKey) {
      models.set(modelKey, modelActivity(eventUpdatedAt, callId, agentId, payload, "waiting"));
      updatedAt = eventUpdatedAt;
      continue;
    }

    if (event.type === "model_attempt_failed" && modelKey) {
      const current = models.get(modelKey);
      const activity = modelActivity(
        eventUpdatedAt,
        callId,
        agentId,
        payload,
        payload.will_retry === true ? "retry_wait" : "failed",
      );
      if (current?.attempt_id === activity.attempt_id) activity.started_at = current.started_at;
      activity.error = typeof payload.error === "string" ? payload.error : "";
      activity.retry_at = payload.will_retry === true
        ? addMilliseconds(eventUpdatedAt, nonnegativeNumber(payload.retry_delay_ms))
        : null;
      models.set(modelKey, activity);
      updatedAt = eventUpdatedAt;
      continue;
    }

    if (event.type === "model_attempt_completed" && modelKey) {
      models.delete(modelKey);
      updatedAt = eventUpdatedAt;
      continue;
    }

    if (event.type === "stream_output" && modelKey) {
      const phase = payload.phase;
      if (phase === "first_token" || phase === "delta" || phase === "intent_delta" || phase === "intent_complete") {
        const current = models.get(modelKey);
        models.set(modelKey, current
          ? { ...current, status: "streaming", updated_at: eventUpdatedAt }
          : {
              call_id: callId,
              agent_id: agentId,
              round: nonnegativeInteger(payload.round),
              status: "streaming",
              attempt_id: null,
              attempt: null,
              max_attempts: null,
              provider: null,
              model: null,
              started_at: null,
              retry_at: null,
              error: null,
              updated_at: eventUpdatedAt,
            });
      } else if (phase === "final") {
        models.delete(modelKey);
      }
      updatedAt = eventUpdatedAt;
      continue;
    }

    if (event.type === "tool_call" && callId) {
      removeAgentModels(models, agentId);
      tools.set(callId, {
        call_id: callId,
        agent_id: agentId,
        tool: typeof payload.tool === "string" ? payload.tool : "",
        started_at: eventUpdatedAt,
      });
      updatedAt = eventUpdatedAt;
      continue;
    }

    if (event.type === "tool_result" && callId) {
      tools.delete(callId);
      updatedAt = eventUpdatedAt;
      continue;
    }

    if (event.type === "agent_ended" && agentId) {
      removeAgentModels(models, agentId);
      for (const [toolCallId, tool] of tools) {
        if (tool.agent_id === agentId) tools.delete(toolCallId);
      }
      updatedAt = eventUpdatedAt;
    }
  }

  return {
    models: [...models.values()].sort((left, right) => left.updated_at.localeCompare(right.updated_at)),
    tools: [...tools.values()].sort((left, right) => left.started_at.localeCompare(right.started_at)),
    updated_at: updatedAt,
  };
}

function modelActivity(
  updatedAt: string,
  callId: string,
  agentId: string,
  payload: Record<string, unknown>,
  status: RuntimeModelActivity["status"],
): RuntimeModelActivity {
  return {
    call_id: callId,
    agent_id: agentId,
    round: nonnegativeInteger(payload.round),
    status,
    attempt_id: typeof payload.attempt_id === "string" && payload.attempt_id ? payload.attempt_id : null,
    attempt: positiveIntegerOrNull(payload.attempt),
    max_attempts: positiveIntegerOrNull(payload.max_attempts),
    provider: typeof payload.provider === "string" ? payload.provider : null,
    model: typeof payload.model === "string" ? payload.model : null,
    started_at: updatedAt,
    retry_at: null,
    error: null,
    updated_at: updatedAt,
  };
}

function removeAgentModels(models: Map<string, RuntimeModelActivity>, agentId: string): void {
  for (const [key, model] of models) {
    if (model.agent_id === agentId) models.delete(key);
  }
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addMilliseconds(value: string, milliseconds: number): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp + milliseconds).toISOString() : null;
}

function projectState(facts: RuntimeSessionFacts, hasMaintenance: boolean): SessionRuntimeState {
  const active = facts.activeRootRun;
  if (!active) {
    if (facts.pendingInteractions.some((item) => item.status === "resuming")) return "resuming";
    if (facts.pendingInteractions.some((item) => item.status === "waiting" || item.status === "suspended" || item.status === "resolved")) {
      return "suspended";
    }
    return hasMaintenance ? "maintenance" : "idle";
  }
  if (facts.pendingInteractions.some((item) => item.status === "resuming")) return "resuming";
  if (active.status === "suspended") return "suspended";
  if (facts.pendingInteractions.some((item) => item.status === "waiting" || item.status === "suspended")) {
    return "waiting_interaction";
  }
  return "running";
}

function allowedActions(
  state: SessionRuntimeState,
  ownedByCurrentInstance: boolean,
  hasPendingInteractions: boolean,
  canResume: boolean,
): SessionRuntimeAction[] {
  switch (state) {
    case "idle": return ["send_message", "start_maintenance"];
    case "running": return ownedByCurrentInstance ? ["send_followup", "stop_run"] : [];
    case "waiting_interaction": return ownedByCurrentInstance ? ["respond_interaction", "stop_run"] : [];
    case "suspended": return [
      ...(hasPendingInteractions ? ["respond_interaction" as const] : []),
      ...(canResume ? ["resume_run" as const] : []),
      "stop_run",
    ];
    case "resuming": return ownedByCurrentInstance ? ["stop_run"] : [];
    case "maintenance": return [];
  }
}

function terminalLastRun(run: RunInfo | null): SessionRuntimePayload["last_run"] {
  if (!run || !new Set(["completed", "failed", "interrupted"]).has(run.status)) return null;
  return {
    run_id: run.run_id,
    status: run.status as "completed" | "failed" | "interrupted",
    task: run.task_summary ?? "",
    started_at: run.created_at,
    finished_at: run.updated_at,
  };
}

function projectPendingInteraction(interaction: PendingInteractionRecord): SessionRuntimePayload["pending_interactions"][number] {
  const payload = interaction.request_payload.interaction_payload;
  return {
    interaction_id: interaction.interaction_id,
    run_id: interaction.run_id,
    root_run_id: interaction.root_run_id,
    batch_id: interaction.batch_id,
    kind: interaction.kind,
    status: interaction.status as "waiting" | "suspended",
    requested_at: interaction.created_at,
    payload,
  } as SessionRuntimePayload["pending_interactions"][number];
}

function activeMaintenance(metadata: Record<string, unknown>): SessionRuntimePayload["maintenance"] {
  const raw = asRecord(metadata.runtime_maintenance);
  const kind = raw.kind;
  const expiresAt = typeof raw.expires_at === "string" ? raw.expires_at : "";
  if ((kind !== "rollback" && kind !== "compact") || !expiresAt || Date.parse(expiresAt) <= Date.now()) return null;
  return { kind, expires_at: expiresAt };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
