import {
  SessionRuntimePayloadSchema,
  type SessionRuntimeAction,
  type SessionRuntimePayload,
  type SessionRuntimeState,
} from "../../contracts/events.js";
import type { PendingInteractionRecord, RunInfo } from "../../contracts/conversation-store/index.js";
import type { RuntimeSessionFacts, RuntimeStorage } from "../../contracts/storage/runtime-storage.js";

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
    load_strategy: loadStrategy(state),
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

function projectState(facts: RuntimeSessionFacts, hasMaintenance: boolean): SessionRuntimeState {
  const active = facts.activeRootRun;
  if (!active) return hasMaintenance ? "maintenance" : "idle";
  if (facts.pendingInteractions.some((item) => item.status === "resuming")) return "resuming";
  if (active.status === "suspended") return "suspended";
  if (facts.pendingInteractions.some((item) => item.status === "waiting" || item.status === "suspended")) {
    return "waiting_interaction";
  }
  return "running";
}

function loadStrategy(state: SessionRuntimeState): SessionRuntimePayload["load_strategy"] {
  switch (state) {
    case "idle": return "history";
    case "running": return "attach_run";
    case "waiting_interaction": return "attach_run_and_present_interactions";
    case "suspended": return "present_interactions";
    case "resuming": return "attach_resume";
    case "maintenance": return "watch_maintenance";
  }
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
