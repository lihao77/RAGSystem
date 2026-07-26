import { describe, expect, it } from "vitest";

import { PostgresRuntimeStorage } from "../../../../src/adapters/saas/postgres/postgres-runtime-storage.js";
import { POSTGRES_PENDING_INTERACTION_MIGRATIONS } from "../../../../src/adapters/saas/postgres/pending-interaction-schema.js";
import type {
  PostgresMemoryExecutor,
  PostgresQueryResult,
} from "../../../../src/adapters/saas/postgres/memory-repository.js";
import { createTenantId } from "../../../../src/identity/types.js";

const NOW = "2026-01-01T00:00:00.000Z";

function persistMessageInput(messageId: string) {
  return {
    message: {
      messageId, sessionId: "session-1", role: "assistant" as const, content: "working",
      threadKey: "root",
      toolCalls: [{ id: "tool-1", type: "function" as const, function: { name: "search", arguments: "{}" } }],
    },
    providerContinuation: {
      messageId, sessionId: "session-1", threadKey: "root", providerType: "anthropic",
      toolCallIds: ["tool-1"],
      state: {
        protocol: "anthropic_messages" as const,
        toolCallIds: ["tool-1"],
        blocks: [{ type: "thinking" as const, thinking: "private", signature: "sig" }],
      },
    },
  };
}

function interactionInput(interactionId: string, toolCallId: string, batchId = "batch-1") {
  return {
    interactionId,
    sessionId: "session-1",
    runId: "run-1",
    rootRunId: "run-1",
    toolCallId,
    batchId,
    kind: "approval" as const,
    requestPayload: {
      task: "approve tools",
      requestId: "request-1",
      executionKind: "agent_stream",
    },
  };
}

function expiredRunRecord(sessionId: string, runId: string) {
  const eventId = `${runId}:lease-expired:run_ended`;
  const event = {
    type: "run_ended",
    session_id: sessionId,
    run_id: runId,
    payload: { status: "interrupted", reason: "run_lease_expired" },
  };
  return {
    step: { sessionId, runId, stepType: "protocol.envelope.v1", payload: event },
    outbox: {
      eventId,
      sessionId,
      runId,
      eventType: "client.run_ended",
      aggregateType: "run",
      aggregateId: runId,
      payload: { client_event: event },
    },
  };
}

function interactionRecord(
  interaction: ReturnType<typeof interactionInput>,
  phase: "required" | "responded",
) {
  const eventId = `${interaction.interactionId}:${phase}`;
  const event = {
    type: "interaction",
    session_id: interaction.sessionId,
    run_id: interaction.runId,
    call_id: interaction.interactionId,
    payload: { kind: interaction.kind, phase },
  };
  return {
    step: {
      sessionId: interaction.sessionId,
      runId: interaction.runId,
      stepType: "protocol.envelope.v1",
      payload: event,
    },
    outbox: {
      eventId,
      sessionId: interaction.sessionId,
      runId: interaction.runId,
      eventType: "client.interaction",
      aggregateType: "run",
      aggregateId: interaction.runId,
      payload: { client_event: event },
    },
  };
}

function pendingRecord(interactionId: string, status: string, batchId: string) {
  return {
    interaction_id: interactionId,
    session_id: "session-1",
    run_id: "run-1",
    root_run_id: "run-1",
    tool_call_id: `tool-${interactionId}`,
    batch_id: batchId,
    kind: "approval",
    status,
    request_payload: { task: "approve tools" },
    resolution_payload: status === "waiting" ? null : { approved: true, message: "ok" },
    created_at: NOW,
    updated_at: NOW,
    responded_at: status === "waiting" ? null : NOW,
    consumed_at: null,
    resume_claim_id: status === "resuming" ? "claim-1" : null,
  };
}

function createExecutorHarness(options: {
  sessionExists?: boolean;
  sessionTenantId?: string;
  sessionPatch?: Record<string, unknown>;
  runExists?: boolean;
  runStatus?: string;
  runPatch?: Record<string, unknown>;
  additionalRuns?: Record<string, Record<string, unknown>>;
  failProviderContinuation?: boolean;
  failOutboxEventId?: string;
} = {}) {
  const tenantId = createTenantId("tnt_runtime_storage");
  const transactionQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const messages = new Map<string, Record<string, unknown>>();
  const eventSteps = new Map<string, Record<string, unknown>>();
  const eventOutboxes = new Map<string, Record<string, unknown>>();
  const interactions = new Map<string, Record<string, unknown>>();
  const providerContinuations = new Map<string, Record<string, unknown>>();
  let rootQueryCount = 0;
  let transactionCount = 0;
  let sessionExists = options.sessionExists ?? true;
  let sessionIdentity: Record<string, unknown> | null = null;
  let runState: Record<string, unknown> | null = options.runExists === false ? null : {
    run_id: "run-1",
    session_id: "session-1",
    tenant_id: tenantId,
    entrypoint: "execute",
    status: options.runStatus ?? "running",
    task_summary: "",
    request_id: null,
    user_id: null,
    agent_name: null,
    thread_key: "root",
    parent_run_id: null,
    parent_call_id: null,
    child_agent_id: null,
    final_message_id: null,
    owner_instance_id: options.runPatch?.owner_instance_id ?? null,
    lease_expires_at: options.runPatch?.lease_expires_at ?? null,
    created_at: NOW,
    updated_at: NOW,
    ...(options.runPatch ?? {}),
  };

  const transactionExecutor: PostgresMemoryExecutor = {
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<PostgresQueryResult<Row>> => {
      transactionQueries.push({ sql, params });
      let rows: Record<string, unknown>[] = [];
      let rowCount = 1;
      if (sql.startsWith("INSERT INTO conversation_sessions")) {
        const attemptedIdentity = {
          session_id: params[0],
          tenant_id: params[1],
          owner_user_id: params[2],
          visibility: params[3],
          origin_type: params[4],
          origin_id: params[5],
          origin_channel: params[6],
          workspace_id: params[7],
        };
        if (sessionExists) {
          sessionIdentity ??= {
            ...attemptedIdentity,
            tenant_id: options.sessionTenantId ?? attemptedIdentity.tenant_id,
            ...(options.sessionPatch ?? {}),
          };
          rows = [];
          rowCount = 0;
        } else {
          sessionExists = true;
          sessionIdentity = attemptedIdentity;
          rows = [{ session_id: params[0] }];
        }
      } else if (sql.includes("SELECT tenant_id,owner_user_id,visibility,origin_type,origin_id,origin_channel,workspace_id")) {
        rows = sessionExists && sessionIdentity ? [sessionIdentity] : [];
      } else if (sql.includes("SELECT tenant_id FROM conversation_sessions")) {
        rows = sessionExists ? [{ tenant_id: options.sessionTenantId ?? tenantId }] : [];
      } else if (sql.startsWith("SELECT * FROM conversation_sessions")) {
        rows = sessionExists ? [{
          session_id: "session-1",
          tenant_id: options.sessionTenantId ?? tenantId,
          user_id: "user-1",
          permission_mode: null,
          metadata: { source: "contract-test" },
          created_at: NOW,
          updated_at: NOW,
        }] : [];
      } else if (sql.includes("FROM saas_runs WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE")) {
        const requestedRunId = String(params[1]);
        const additional = options.additionalRuns?.[requestedRunId];
        rows = additional ? [additional] : runState?.run_id === requestedRunId ? [runState] : [];
      } else if (sql.includes("SELECT run_id, parent_run_id FROM saas_runs")) {
        rows = runState ? [{ run_id: runState.run_id, parent_run_id: runState.parent_run_id ?? null }] : [];
      } else if (sql.includes("SELECT run_id, owner_instance_id, status FROM saas_runs")) {
        rows = runState && (runState.status === "running" || runState.status === "suspended") ? [{
          run_id: runState.run_id,
          owner_instance_id: runState.owner_instance_id ?? null,
          status: runState.status,
        }] : [];
      } else if (sql.includes("SET owner_instance_id=$1")) {
        const owner = String(params[0]);
        const requestedRunId = String(params[4]);
        const currentOwner = runState?.owner_instance_id;
        const expiresAt = runState?.lease_expires_at;
        const claimable = runState?.run_id === requestedRunId
          && runState.status === "running"
          && runState.parent_run_id == null
          && (currentOwner === owner || expiresAt == null || new Date(String(expiresAt)).getTime() <= Date.now());
        if (claimable && runState) {
          runState = { ...runState, owner_instance_id: owner, lease_expires_at: "2099-01-01T00:00:00.000Z" };
          rows = [{ run_id: requestedRunId }];
        } else {
          rowCount = 0;
        }
      } else if (sql.includes("SET lease_expires_at=CURRENT_TIMESTAMP")) {
        const requestedRunId = String(params[3]);
        const owner = String(params[4]);
        if (runState?.run_id === requestedRunId && runState.status === "running" && runState.owner_instance_id === owner) {
          runState = { ...runState, lease_expires_at: "2099-01-01T00:00:00.000Z" };
          rows = [{ lease_expires_at: runState.lease_expires_at }];
        } else {
          rowCount = 0;
        }
      } else if (sql.includes("WITH RECURSIVE run_tree") && sql.includes("UPDATE saas_runs")) {
        if (runState?.run_id === String(params[2]) && runState.status === "running") {
          rows = [{ run_id: runState.run_id, parent_run_id: runState.parent_run_id ?? null }];
          runState = {
            ...runState,
            status: "interrupted",
            final_message_id: null,
            owner_instance_id: null,
            lease_expires_at: null,
          };
          const interruptedIds = new Set([String(params[2])]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const [runId, additional] of Object.entries(options.additionalRuns ?? {})) {
              const status = String(additional.status);
              if ((status !== "running" && status !== "suspended")
                || !interruptedIds.has(String(additional.parent_run_id))) continue;
              interruptedIds.add(runId);
              rows.push({ run_id: runId, parent_run_id: additional.parent_run_id as string });
              Object.assign(additional, {
                status: "interrupted",
                final_message_id: null,
                owner_instance_id: null,
                lease_expires_at: null,
              });
              changed = true;
            }
          }
        } else {
          rowCount = 0;
        }
      } else if (sql.includes("SELECT run_id FROM saas_runs") && sql.includes("owner_instance_id=$4")) {
        const requestedRunId = String(params[2]);
        const owner = String(params[3]);
        rows = runState?.run_id === requestedRunId
          && runState.status === "running"
          && runState.owner_instance_id === owner
          && runState.lease_expires_at != null
          ? [{ run_id: requestedRunId }]
          : [];
      } else if (sql.includes("SELECT run_id FROM saas_runs") && sql.includes("lease_expires_at")) {
        const deadline = params[2] == null ? Date.now() : new Date(String(params[2])).getTime();
        const expiresAt = runState?.lease_expires_at;
        const expired = runState?.status === "running"
          && runState.parent_run_id == null
          && (expiresAt == null || new Date(String(expiresAt)).getTime() <= deadline);
        rows = expired && runState ? [{ run_id: runState.run_id }] : [];
      } else if (sql.includes("SELECT run_id FROM saas_runs")) {
        if (sql.includes("run_id=$3")) {
          const requestedRunId = String(params[2]);
          const additional = options.additionalRuns?.[requestedRunId];
          rows = additional ? [{ run_id: requestedRunId }] : runState?.run_id === requestedRunId ? [{ run_id: requestedRunId }] : [];
        } else {
          rows = runState?.status === "running" ? [{ run_id: runState.run_id }] : [];
        }
      } else if (sql.includes("INSERT INTO saas_runs")) {
        runState = {
          run_id: String(params[1]),
          session_id: String(params[2]),
          tenant_id: String(params[0]),
          entrypoint: String(params[3]),
          status: String(params[4]),
          task_summary: String(params[5]),
          request_id: params[6] ?? null,
          user_id: params[7] ?? null,
          agent_name: params[8] ?? null,
          thread_key: String(params[9]),
          parent_run_id: params[10] ?? null,
          parent_call_id: params[11] ?? null,
          child_agent_id: params[12] ?? null,
          final_message_id: null,
          owner_instance_id: null,
          lease_expires_at: null,
          created_at: NOW,
          updated_at: NOW,
        };
      } else if (sql.startsWith("UPDATE saas_runs")) {
        if (runState) {
          runState = {
            ...runState,
            status: String(params[0]),
            final_message_id: params[1] ?? null,
            owner_instance_id: null,
            lease_expires_at: null,
          };
        }
      } else if (sql.startsWith("SELECT session_id FROM conversation_messages")) {
        const found = messages.get(String(params[0]));
        rows = found ? [{ session_id: found.session_id }] : [];
      } else if (sql.startsWith("SELECT * FROM conversation_messages")) {
        const found = messages.get(String(params[1]));
        rows = found ? [found] : [];
      } else if (sql.startsWith("INSERT INTO conversation_messages")) {
        const inserted = {
          seq: 17,
          id: String(params[0]),
          session_id: String(params[1]),
          role: String(params[2]),
          content: String(params[3]),
          metadata: JSON.parse(String(params[4])) as Record<string, unknown>,
          thread_key: String(params[5]),
          child_agent_id: params[6] ?? null,
          created_at: NOW,
        };
        messages.set(inserted.id, inserted);
        rows = [inserted];
      } else if (sql.includes("MAX(step_order)")) {
        rows = [{ next_order: 1 }];
      } else if (sql.includes("FROM saas_run_steps WHERE tenant_id=$1 AND event_id=$2")) {
        const found = eventSteps.get(String(params[1]));
        rows = found ? [found] : [];
      } else if (sql.includes("INSERT INTO saas_run_steps")) {
        const inserted = {
          id: 31,
          run_id: String(params[1]),
          session_id: String(params[2]),
          event_id: params[4] ?? null,
          step_order: Number(params[5]),
          step_type: String(params[6]),
          payload: JSON.parse(String(params[7])) as Record<string, unknown>,
        };
        eventSteps.set(String(inserted.event_id), inserted);
        rows = [inserted];
      } else if (sql.includes("FROM event_outbox WHERE tenant_id=$1 AND event_id=$2")) {
        const found = eventOutboxes.get(String(params[1]));
        rows = found ? [found] : [];
      } else if (sql.includes("FROM event_outbox WHERE event_id=$1")) {
        const found = eventOutboxes.get(String(params[0]));
        rows = found ? [found] : [];
      } else if (sql.includes("INSERT INTO session_event_seq")) {
        rows = [{ seq: 9 }];
      } else if (sql.includes("INSERT INTO event_outbox")) {
        if (String(params[0]) === options.failOutboxEventId) throw new Error("outbox failure");
        const inserted = {
          id: 41,
          event_id: String(params[0]),
          session_id: String(params[1]),
          tenant_id: tenantId,
          run_id: params[3] ?? null,
          session_seq: Number(params[4]),
          event_type: String(params[5]),
          aggregate_type: String(params[6]),
          aggregate_id: String(params[7]),
          payload: JSON.parse(String(params[8])) as Record<string, unknown>,
          status: "pending",
          attempts: 0,
          available_at: NOW,
          locked_at: null,
          delivered_at: null,
          last_error: null,
          created_at: NOW,
        };
        eventOutboxes.set(inserted.event_id, inserted);
        rows = [inserted];
      } else if (sql.includes("INSERT INTO pending_interactions")) {
        const interactionId = String(params[0]);
        if (!interactions.has(interactionId)) {
          interactions.set(interactionId, {
            interaction_id: interactionId,
            session_id: String(params[1]),
            run_id: String(params[2]),
            root_run_id: String(params[3]),
            tool_call_id: String(params[4]),
            batch_id: String(params[5]),
            kind: String(params[6]),
            status: "waiting",
            request_payload: JSON.parse(String(params[7])) as Record<string, unknown>,
            resolution_payload: null,
            created_at: NOW,
            updated_at: NOW,
            responded_at: null,
            consumed_at: null,
            resume_claim_id: null,
          });
        }
      } else if (sql.includes("FROM pending_interactions WHERE session_id=$1 AND interaction_id=$2")) {
        const found = interactions.get(String(params[1]));
        rows = found && found.session_id === params[0] ? [found] : [];
        rowCount = rows.length;
      } else if (sql.includes("FROM pending_interactions") && sql.includes("ORDER BY created_at")) {
        rows = [...interactions.values()].filter((interaction) => {
          if (interaction.session_id !== params[0]) return false;
          let nextParam = 1;
          if (sql.includes("root_run_id=$2")) {
            if (interaction.root_run_id !== params[nextParam++]) return false;
          }
          if (sql.includes(`batch_id=$${nextParam + 1}`)) {
            if (interaction.batch_id !== params[nextParam++]) return false;
          }
          const statuses = params.find((value) => Array.isArray(value)) as string[] | undefined;
          return !statuses || statuses.includes(String(interaction.status));
        });
        rowCount = rows.length;
      } else if (sql.includes("resolution_payload=CASE")) {
        const found = interactions.get(String(params[4]));
        const allowed = !Array.isArray(params[5]) || (params[5] as string[]).includes(String(found?.status));
        if (found && found.session_id === params[3] && allowed) {
          interactions.set(String(params[4]), {
            ...found,
            status: String(params[0]),
            resolution_payload: params[2] ? JSON.parse(String(params[1])) as Record<string, unknown> : found.resolution_payload,
            responded_at: params[0] === "resolved" ? NOW : found.responded_at,
            resume_claim_id: params[0] === "resuming" ? found.resume_claim_id : null,
            updated_at: NOW,
          });
          rowCount = 1;
        } else {
          rowCount = 0;
        }
      } else if (sql.includes("UPDATE pending_interactions AS candidate") && sql.includes("resume_claim_id=$3")) {
        const batch = [...interactions.values()].filter((interaction) => (
          interaction.session_id === params[0] && interaction.batch_id === params[1]
        ));
        if (batch.every((interaction) => interaction.status === "resolved" && !interaction.resume_claim_id)) {
          for (const interaction of batch) {
            interactions.set(String(interaction.interaction_id), {
              ...interaction,
              status: "resuming",
              resume_claim_id: String(params[2]),
              updated_at: NOW,
            });
          }
          rowCount = batch.length;
        } else {
          rowCount = 0;
        }
      } else if (sql.includes("UPDATE pending_interactions") && sql.includes("resume_claim_id=$3")
        && sql.includes("root_run_id=$2")) {
        const claimed = [...interactions.values()].filter((interaction) => (
          interaction.session_id === params[0]
          && interaction.root_run_id === params[1]
          && interaction.resume_claim_id === params[2]
          && interaction.status === "resuming"
        ));
        for (const interaction of claimed) {
          interactions.set(String(interaction.interaction_id), {
            ...interaction,
            status: "resolved",
            resume_claim_id: null,
            updated_at: NOW,
          });
        }
        rowCount = claimed.length;
      } else if (sql.includes("UPDATE pending_interactions") && sql.includes("SET status='suspended'")) {
        const waiting = [...interactions.values()].filter((interaction) => (
          interaction.session_id === params[0]
          && interaction.root_run_id === params[1]
          && interaction.status === "waiting"
        ));
        for (const interaction of waiting) {
          interactions.set(String(interaction.interaction_id), {
            ...interaction,
            status: "suspended",
            updated_at: NOW,
          });
        }
        rowCount = waiting.length;
      } else if (sql.startsWith("DELETE FROM provider_continuations")) {
        const matching = [...providerContinuations.entries()].filter(([, record]) => (
          record.session_id === params[1] && record.thread_key === params[2]
        ));
        for (const [key] of matching) providerContinuations.delete(key);
        rowCount = matching.length;
      } else if (sql.includes("INSERT INTO provider_continuations")) {
        if (options.failProviderContinuation) throw new Error("provider continuation failure");
        const inserted = {
          message_id: String(params[1]), session_id: String(params[2]), thread_key: String(params[3]),
          provider_type: String(params[4]), tool_call_ids: JSON.parse(String(params[5])),
          state: JSON.parse(String(params[6])), created_at: NOW,
        };
        providerContinuations.set(inserted.message_id, inserted);
        rows = [inserted];
      }
      return { rows: rows as Row[], rowCount };
    },
    transaction: async (operation) => operation(transactionExecutor),
  };
  const rootExecutor: PostgresMemoryExecutor = {
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<PostgresQueryResult<Row>> => {
      rootQueryCount += 1;
      if (sql.includes("SELECT DISTINCT session_id FROM saas_runs")) {
        const expired = runState?.status === "running"
          && runState.parent_run_id == null
          && (runState.lease_expires_at == null || new Date(String(runState.lease_expires_at)).getTime() <= Date.now());
        return { rows: (expired ? [{ session_id: String(runState?.session_id) }] : []) as unknown as Row[], rowCount: expired ? 1 : 0 };
      }
      throw new Error("pool executor query must not be used inside an atomic operation");
    },
    transaction: async (operation) => {
      transactionCount += 1;
      const messageSnapshot = new Map(messages);
      const continuationSnapshot = new Map(providerContinuations);
      const stepSnapshot = new Map(eventSteps);
      const outboxSnapshot = new Map(eventOutboxes);
      const interactionSnapshot = new Map(interactions);
      const runSnapshot = runState ? { ...runState } : null;
      try {
        return await operation(transactionExecutor);
      } catch (error) {
        messages.clear();
        for (const [key, value] of messageSnapshot) messages.set(key, value);
        providerContinuations.clear();
        for (const [key, value] of continuationSnapshot) providerContinuations.set(key, value);
        eventSteps.clear();
        for (const [key, value] of stepSnapshot) eventSteps.set(key, value);
        eventOutboxes.clear();
        for (const [key, value] of outboxSnapshot) eventOutboxes.set(key, value);
        interactions.clear();
        for (const [key, value] of interactionSnapshot) interactions.set(key, value);
        runState = runSnapshot;
        throw error;
      }
    },
  };
  return {
    tenantId,
    rootExecutor,
    transactionExecutor,
    transactionQueries,
    messages,
    eventSteps,
    eventOutboxes,
    interactions,
    providerContinuations,
    patchRunState(patch: Record<string, unknown>) { if (runState) runState = { ...runState, ...patch }; },
    get runState() { return runState; },
    get rootQueryCount() { return rootQueryCount; },
    get transactionCount() { return transactionCount; },
  };
}

describe("PostgresRuntimeStorage", () => {
  it("keeps pending-interaction migrations continuous and adds leased resume claims", () => {
    expect(POSTGRES_PENDING_INTERACTION_MIGRATIONS.map((migration) => migration.version))
      .toEqual([1, 2, 3]);
    expect(POSTGRES_PENDING_INTERACTION_MIGRATIONS[1]).toMatchObject({
      version: 2,
      name: "pending_interaction_resume_claims",
    });
    expect(POSTGRES_PENDING_INTERACTION_MIGRATIONS[1]?.sql).toContain("resume_claim_id");
    expect(POSTGRES_PENDING_INTERACTION_MIGRATIONS[2]).toMatchObject({
      version: 3,
      name: "pending_interaction_resume_claim_expiry",
    });
    expect(POSTGRES_PENDING_INTERACTION_MIGRATIONS[2]?.sql).toContain("resume_claim_expires_at");
  });

  it("recovers an expired root lease exactly once and emits a durable run_ended", async () => {
    const harness = createExecutorHarness({
      runPatch: { owner_instance_id: "dead-instance", lease_expires_at: "2025-12-31T23:59:00.000Z" },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "live-instance");

    const first = await storage.operations.recoverExpiredRunLeases!({
      now: NOW,
      buildRunEndedRecord: (run) => expiredRunRecord(run.sessionId, run.runId),
    });
    const second = await storage.operations.recoverExpiredRunLeases!({
      now: NOW,
      buildRunEndedRecord: (run) => expiredRunRecord(run.sessionId, run.runId),
    });

    expect(first.interruptedRuns).toEqual([{ sessionId: "session-1", runId: "run-1", parentRunId: null }]);
    expect(first.records.map((record) => record.outbox.event_id)).toEqual(["run-1:lease-expired:run_ended"]);
    expect(harness.runState).toMatchObject({ status: "interrupted", owner_instance_id: null, lease_expires_at: null });
    expect(second).toEqual({ interruptedRuns: [], cancelledInteractions: 0, records: [] });
    expect(harness.eventOutboxes.size).toBe(1);
  });

  it("interrupts running descendants when their root lease expires", async () => {
    const child = {
      run_id: "child-run", session_id: "session-1", tenant_id: "tnt_runtime_storage",
      status: "running", thread_key: "child", parent_run_id: "run-1", parent_call_id: "call-1",
      child_agent_id: "child-agent", final_message_id: null, created_at: NOW, updated_at: NOW,
    };
    const grandchild = {
      ...child,
      run_id: "grandchild-run",
      parent_run_id: "child-run",
      status: "suspended",
    };
    const harness = createExecutorHarness({
      runPatch: { owner_instance_id: null, lease_expires_at: null },
      additionalRuns: { "child-run": child, "grandchild-run": grandchild },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "live-instance");

    const recovered = await storage.operations.recoverExpiredRunLeases!({
      now: NOW,
      buildRunEndedRecord: (run) => expiredRunRecord(run.sessionId, run.runId),
    });

    expect(recovered.interruptedRuns.map((run) => run.runId).sort())
      .toEqual(["child-run", "grandchild-run", "run-1"]);
    expect(child.status).toBe("interrupted");
    expect(grandchild.status).toBe("interrupted");
    expect(recovered.records).toHaveLength(1);
  });

  it("does not recover a fresh lease owned by another instance", async () => {
    const harness = createExecutorHarness({
      runPatch: { owner_instance_id: "instance-a", lease_expires_at: "2099-01-01T00:00:00.000Z" },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "instance-b");

    await expect(storage.operations.recoverExpiredRunLeases!({
      now: NOW,
      buildRunEndedRecord: (run) => expiredRunRecord(run.sessionId, run.runId),
    })).resolves.toEqual({ interruptedRuns: [], cancelledInteractions: 0, records: [] });
    expect(harness.runState).toMatchObject({ status: "running", owner_instance_id: "instance-a" });
  });

  it("renews only the current owner's running root lease", async () => {
    const owned = createExecutorHarness({
      runPatch: { owner_instance_id: "instance-a", lease_expires_at: "2099-01-01T00:00:00.000Z" },
    });
    const ownerStorage = new PostgresRuntimeStorage(owned.tenantId, owned.rootExecutor, "instance-a");
    await expect(ownerStorage.operations.renewRunLease!({ sessionId: "session-1", rootRunId: "run-1" }))
      .resolves.toMatchObject({ renewed: true });

    const otherStorage = new PostgresRuntimeStorage(owned.tenantId, owned.rootExecutor, "instance-b");
    await expect(otherStorage.operations.renewRunLease!({ sessionId: "session-1", rootRunId: "run-1" }))
      .resolves.toEqual({ renewed: false, expiresAt: null });
  });

  it("rejects stale execution writes inside their PostgreSQL transactions", async () => {
    const harness = createExecutorHarness({
      runPatch: { owner_instance_id: "instance-a", lease_expires_at: "2099-01-01T00:00:00.000Z" },
    });
    const stale = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "instance-b");

    await expect(stale.operations.persistMessage({
      leaseRootRunId: "run-1",
      message: { messageId: "stale-message", sessionId: "session-1", role: "assistant", content: "late" },
    })).rejects.toThrow("root run lease was lost");
    await expect(stale.operations.recordEnvelope({
      requireRunLease: true,
      outbox: {
        eventId: "stale-event", sessionId: "session-1", runId: "run-1",
        eventType: "client.stream_output", aggregateType: "run", aggregateId: "run-1",
        payload: { client_event: { type: "stream_output" } },
      },
    })).rejects.toThrow("root run lease was lost");
    await expect(stale.operations.finalizeRun({
      runId: "run-1", sessionId: "session-1", status: "failed", leaseRootRunId: "run-1",
    })).rejects.toThrow("root run lease was lost");
    await expect(stale.operations.startRun({
      session: { sessionId: "session-1", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "stale-child", sessionId: "session-1", parentRunId: "run-1" },
      leaseRootRunId: "run-1",
    })).rejects.toThrow("root run lease was lost");

    expect(harness.messages.has("stale-message")).toBe(false);
    expect(harness.eventOutboxes.has("stale-event")).toBe(false);
    expect(harness.runState?.status).toBe("running");
  });

  it("recovers an expired root before starting a new root in the same session", async () => {
    const harness = createExecutorHarness({
      runPatch: { owner_instance_id: "dead-instance", lease_expires_at: "2025-12-31T23:59:00.000Z" },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "live-instance");

    const result = await storage.operations.startOrAppendRoot({
      session: { sessionId: "session-1", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "run-2", sessionId: "session-1" },
      followupFactory: () => { throw new Error("must start after recovery"); },
      buildExpiredRunEndedRecord: (run) => expiredRunRecord(run.sessionId, run.runId),
    });

    expect(result.kind).toBe("started");
    if (result.kind !== "started") throw new Error("expected a new root after expired lease recovery");
    expect(result.records.map((record) => record.outbox.event_id)).toContain("run-1:lease-expired:run_ended");
    expect(harness.runState).toMatchObject({ run_id: "run-2", status: "running", owner_instance_id: "live-instance" });
  });

  it("starts a run atomically with tenant binding and a deterministic initial message", async () => {
    const harness = createExecutorHarness({ sessionExists: false, runExists: false });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    const result = await storage.operations.startRun({
      session: { sessionId: "session-1", ownerUserId: "user-1", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "run-1", sessionId: "session-1", status: "running" },
      initialUserMessage: {
        messageId: "user-message-1",
        sessionId: "session-1",
        role: "user",
        content: "question",
      },
    });

    expect(result.run).toMatchObject({ run_id: "run-1", session_id: "session-1" });
    expect(result.initialUserMessage).toMatchObject({ id: "user-message-1", content: "question" });
    expect(harness.transactionCount).toBe(1);
    expect(harness.rootQueryCount).toBe(0);
    expect(harness.transactionQueries.some(({ sql, params }) =>
      sql.includes("pg_advisory_xact_lock")
      && params[0] === `session-control:${harness.tenantId}:session-1`)).toBe(true);
    const sessionInsert = harness.transactionQueries.find(({ sql }) => sql.startsWith("INSERT INTO conversation_sessions"));
    const runInsert = harness.transactionQueries.find(({ sql }) => sql.includes("INSERT INTO saas_runs"));
    expect(sessionInsert?.params[1]).toBe(harness.tenantId);
    expect(runInsert?.params[0]).toBe(harness.tenantId);
  });

  it("validates the complete existing session identity under the startRun advisory lock", async () => {
    const harness = createExecutorHarness({
      sessionExists: true,
      runExists: false,
      sessionPatch: { owner_user_id: "existing-owner" },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    await expect(storage.operations.startRun({
      session: { sessionId: "session-1", ownerUserId: "requested-owner", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "run-new", sessionId: "session-1" },
    })).rejects.toThrow("different immutable session identity");

    const advisoryIndex = harness.transactionQueries.findIndex(({ sql }) => sql.includes("pg_advisory_xact_lock"));
    const identityIndex = harness.transactionQueries.findIndex(({ sql }) =>
      sql.includes("SELECT tenant_id,owner_user_id,visibility,origin_type,origin_id,origin_channel,workspace_id")
    );
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeGreaterThan(advisoryIndex);
    expect(harness.runState).toBeNull();
  });

  it("validates the complete existing session identity before startOrAppendRoot disposition", async () => {
    const harness = createExecutorHarness({
      sessionExists: true,
      runExists: true,
      sessionPatch: { workspace_id: "existing-workspace" },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    await expect(storage.operations.startOrAppendRoot({
      session: { sessionId: "session-1", ownerUserId: "user-1", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: "requested-workspace" },
      run: { runId: "run-2", sessionId: "session-1" },
      followupFactory: () => { throw new Error("identity must be checked first"); },
    })).rejects.toThrow("different immutable session identity");
  });

  it("atomically appends a second root request to the running root", async () => {
    const harness = createExecutorHarness({
      sessionExists: true,
      runExists: true,
      runStatus: "running",
      runPatch: { owner_instance_id: "instance-a", lease_expires_at: "2099-01-01T00:00:00.000Z" },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "instance-a");

    await expect(storage.operations.startOrAppendRoot({
      session: { sessionId: "session-1", ownerUserId: "user-1", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "run-2", sessionId: "session-1", status: "running" },
      initialUserMessage: { messageId: "message-2", sessionId: "session-1", role: "user", content: "duplicate" },
      followupFactory: ({ activeRunId, roundIndex }) => ({
        message: { messageId: "message-2", sessionId: "session-1", role: "user", content: "duplicate", metadata: { run_id: activeRunId, execution_kind: "session_followup", round_index: roundIndex } },
        recordFactory: () => [],
      }),
    })).resolves.toMatchObject({
      kind: "followup",
      activeRunId: "run-1",
      message: { id: "message-2", metadata: { run_id: "run-1", execution_kind: "session_followup" } },
    });
    expect(harness.messages.has("message-2")).toBe(true);
    expect(harness.transactionQueries.some(({ sql }) =>
      sql.includes("parent_run_id IS NULL") && sql.includes("status IN ('running','suspended')")
    )).toBe(true);
  });

  it("does not acknowledge or persist a followup through a different live owner", async () => {
    const harness = createExecutorHarness({
      sessionExists: true,
      runExists: true,
      runStatus: "running",
      runPatch: { owner_instance_id: "instance-a", lease_expires_at: "2099-01-01T00:00:00.000Z" },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "instance-b");

    const result = await storage.operations.startOrAppendRoot({
      session: { sessionId: "session-1", ownerUserId: "user-1", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "run-2", sessionId: "session-1", status: "running" },
      initialUserMessage: { messageId: "message-2", sessionId: "session-1", role: "user", content: "duplicate" },
      followupFactory: ({ activeRunId }) => ({
        message: { messageId: "message-2", sessionId: "session-1", role: "user", content: "duplicate", metadata: { run_id: activeRunId } },
        recordFactory: () => [],
      }),
    });

    expect(result).toMatchObject({
      kind: "followup",
      activeRunId: "run-1",
      ownedByCurrentInstance: false,
    });
    if (result.kind !== "followup") throw new Error("expected followup disposition");
    expect(result.message).toBeUndefined();
    expect(harness.messages.has("message-2")).toBe(false);
  });

  it("records a step and stable-id outbox event atomically", async () => {
    const harness = createExecutorHarness();
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    const result = await storage.operations.recordEnvelope({
      step: {
        sessionId: "session-1",
        runId: "run-1",
        stepType: "protocol.envelope.v1",
        payload: { type: "tool_call" },
      },
      outbox: {
        eventId: "event-1",
        sessionId: "session-1",
        runId: "run-1",
        eventType: "client.tool_call",
        aggregateType: "run",
        aggregateId: "run-1",
        payload: { client_event: { type: "tool_call" } },
      },
    });

    expect(result.step).toMatchObject({ id: 31, run_id: "run-1" });
    expect(result.outbox).toMatchObject({ id: 41, event_id: "event-1" });
    expect(harness.transactionCount).toBe(1);
    expect(harness.rootQueryCount).toBe(0);
  });

  it("rejects mismatched start and envelope scopes before opening a transaction", async () => {
    const harness = createExecutorHarness();
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    await expect(storage.operations.startRun({
      session: { sessionId: "session-1", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "run-1", sessionId: "session-2" },
    })).rejects.toThrow("run session mismatch");
    await expect(storage.operations.recordEnvelope({
      step: { sessionId: "session-1", runId: "run-1", stepType: "event", payload: {} },
      outbox: {
        eventId: "event-1",
        sessionId: "session-1",
        runId: "run-2",
        eventType: "client.event",
        aggregateType: "run",
        aggregateId: "run-2",
        payload: {},
      },
    })).rejects.toThrow("execution record run mismatch");
    expect(harness.transactionCount).toBe(0);
  });

  it("uses one transaction executor for all finalizeRun domain facades", async () => {
    const harness = createExecutorHarness();
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);
    let callbackMessageSeq: number | null = null;

    const result = await storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "completed",
      finalMessage: {
        messageId: "message-1",
        sessionId: "session-1",
        role: "assistant",
        content: "answer",
        metadata: { run_id: "run-1" },
      },
      deleteProviderContinuationThreadKey: "root",
      interactionRootRunId: "run-1",
      buildTerminalRecords: (message) => {
        callbackMessageSeq = message?.seq ?? null;
        return [{
          step: {
            sessionId: "session-1",
            runId: "run-1",
            stepType: "protocol.envelope.v1",
            payload: { type: "run_ended", message_seq: message?.seq },
          },
          outbox: {
            eventId: "event-1",
            sessionId: "session-1",
            runId: "run-1",
            eventType: "client.run_ended",
            aggregateType: "run",
            aggregateId: "run-1",
            payload: { client_event: { message_seq: message?.seq } },
          },
        }];
      },
    });

    expect(callbackMessageSeq).toBe(17);
    expect(result.finalMessage).toMatchObject({ id: "message-1", seq: 17 });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.step).toMatchObject({ id: 31, run_id: "run-1" });
    expect(result.records[0]?.outbox).toMatchObject({ id: 41, event_id: "event-1" });
    expect(harness.transactionCount).toBe(1);
    expect(harness.rootQueryCount).toBe(0);

    const runUpdate = harness.transactionQueries.find(({ sql }) => sql.startsWith("UPDATE saas_runs"));
    const continuationDelete = harness.transactionQueries.find(({ sql }) => sql.startsWith("DELETE FROM provider_continuations"));
    expect(runUpdate?.params).toEqual([
      "completed",
      "message-1",
      harness.tenantId,
      "run-1",
      "session-1",
    ]);
    expect(continuationDelete?.params).toEqual([
      harness.tenantId,
      "session-1",
      "root",
    ]);
  });

  it("finalizes the root pending-interaction matrix atomically", async () => {
    const cases = [
      { status: "suspended" as const, expected: ["suspended", "consumed", "resolved", "resolved"], ready: ["resolved-1"] },
      { status: "completed" as const, expected: ["cancelled", "consumed", "consumed", "consumed"], ready: [] },
      { status: "failed" as const, expected: ["cancelled", "cancelled", "cancelled", "cancelled"], ready: [] },
      { status: "interrupted" as const, expected: ["cancelled", "cancelled", "cancelled", "cancelled"], ready: [] },
    ];
    for (const testCase of cases) {
      const harness = createExecutorHarness();
      harness.interactions.set("waiting-1", pendingRecord("waiting-1", "waiting", "batch-waiting"));
      harness.interactions.set("resuming-1", pendingRecord("resuming-1", "resuming", "batch-resuming"));
      harness.interactions.set("resolved-1", pendingRecord("resolved-1", "resolved", "batch-resolved"));
      harness.interactions.set("resolved-2", pendingRecord("resolved-2", "resolved", "batch-resolved"));
      const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

      const result = await storage.operations.finalizeRun({
        runId: "run-1",
        sessionId: "session-1",
        status: testCase.status,
        interactionRootRunId: "run-1",
        ...(testCase.status === "completed" ? {
          finalMessage: { messageId: "matrix-final", sessionId: "session-1", role: "assistant" as const, content: "done" },
        } : {}),
      });

      expect([...harness.interactions.values()].map((item) => item.status)).toEqual(testCase.expected);
      expect(result.readyResumeInteractionIds).toEqual(testCase.ready);
    }
  });

  it("interrupts active root trees and pending interactions in one transaction", async () => {
    const harness = createExecutorHarness({
      runStatus: "suspended",
      runPatch: { agent_name: "agent-1" },
    });
    harness.interactions.set("stop-interaction", pendingRecord("stop-interaction", "resolved", "stop-batch"));
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    const result = await storage.operations.interruptSession({
      sessionId: "session-1",
      buildRunEndedRecord: (run) => ({
        outbox: {
          sessionId: "session-1",
          runId: run.runId,
          eventId: `${run.runId}:session-stop:run_ended`,
          eventType: "client.run_ended",
          aggregateType: "run",
          aggregateId: run.runId,
          payload: { client_event: { type: "run_ended", session_id: "session-1", run_id: run.runId, payload: { status: "interrupted" } } },
        },
      }),
    });

    expect(result.interruptedRuns).toEqual([{ runId: "run-1", parentRunId: null }]);
    expect(result.cancelledInteractions).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(harness.runState?.status).toBe("interrupted");
    expect(harness.interactions.get("stop-interaction")?.status).toBe("cancelled");
  });

  it("rejects interaction finalization for a child run", async () => {
    const harness = createExecutorHarness({ runPatch: { parent_run_id: "root-run" } });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    await expect(storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "suspended",
      interactionRootRunId: "run-1",
    })).rejects.toThrow("root interaction finalization rejects a child run");
  });

  it("rolls pending interaction finalization back when terminal record building fails", async () => {
    const harness = createExecutorHarness();
    harness.interactions.set("rollback-waiting", pendingRecord("rollback-waiting", "waiting", "rollback-batch"));
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    await expect(storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "suspended",
      interactionRootRunId: "run-1",
      buildTerminalRecords: () => { throw new Error("terminal rollback sentinel"); },
    })).rejects.toThrow("terminal rollback sentinel");

    expect(harness.runState?.status).toBe("running");
    expect(harness.interactions.get("rollback-waiting")?.status).toBe("waiting");
  });

  it("reuses an existing deterministic final message on retry", async () => {
    const harness = createExecutorHarness();
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);
    const input = {
      runId: "run-1",
      sessionId: "session-1",
      status: "completed" as const,
      finalMessage: {
        messageId: "message-1",
        sessionId: "session-1",
        role: "assistant" as const,
        content: "answer",
      },
    };

    await storage.operations.finalizeRun(input);
    await storage.operations.finalizeRun(input);

    const messageInserts = harness.transactionQueries.filter(({ sql }) => sql.startsWith("INSERT INTO conversation_messages"));
    expect(messageInserts).toHaveLength(1);
    expect(harness.messages.get("message-1")).toMatchObject({ content: "answer" });
  });

  it("exposes fixed atomic operations and preserves callback failures for rollback", async () => {
    const harness = createExecutorHarness();
    const sentinel = new Error("rollback sentinel");
    let executorObserved: unknown;
    harness.rootExecutor.transaction = async (operation) => {
      try {
        return await operation(harness.transactionExecutor);
      } catch (error) {
        executorObserved = error;
        throw error;
      }
    };
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    expect(storage.operations.startRun).toBeTypeOf("function");
    expect(storage.operations.recordEnvelope).toBeTypeOf("function");
    expect(storage.operations.recordInteraction).toBeTypeOf("function");
    expect(storage.operations.resolveInteraction).toBeTypeOf("function");
    expect(storage.operations.claimResume).toBeTypeOf("function");
    expect(storage.operations.rollbackResume).toBeTypeOf("function");
    await expect(storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "interrupted",
      finalMessage: {
        messageId: "message-1",
        sessionId: "session-1",
        role: "assistant",
        content: "answer",
      },
      buildTerminalRecords: () => {
        throw sentinel;
      },
    })).rejects.toBe(sentinel);

    expect(executorObserved).toBe(sentinel);
  });

  it("exposes only tenant identity and fixed operations to the core", () => {
    const harness = createExecutorHarness();
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    expect(storage).not.toHaveProperty("conversation");
    expect(storage).not.toHaveProperty("runs");
    expect(storage).not.toHaveProperty("outbox");
    expect(storage).toMatchObject({ tenantId: harness.tenantId });
  });

  it("rejects cross-tenant sessions and blank event ids", async () => {
    const harness = createExecutorHarness({ sessionTenantId: "tnt_other" });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);
    const base = {
      sessionId: "session-1", runId: "run-1", eventType: "client.event",
      aggregateType: "run", aggregateId: "run-1", payload: {},
    };

    await expect(storage.operations.recordEnvelope({
      outbox: { ...base, eventId: "event-1" },
    })).rejects.toThrow("session belongs to another tenant");
    await expect(storage.operations.recordEnvelope({
      outbox: { ...base, eventId: "   " },
    })).rejects.toThrow("non-empty eventId");
  });

  it("treats an equal run scope as idempotent and rejects immutable scope conflicts", async () => {
    const equal = createExecutorHarness();
    const equalStorage = new PostgresRuntimeStorage(equal.tenantId, equal.rootExecutor);
    await expect(equalStorage.operations.startRun({
      session: { sessionId: "session-1", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "run-1", sessionId: "session-1" },
    })).resolves.toMatchObject({ run: { run_id: "run-1" } });
    expect(equal.transactionQueries.some(({ sql }) => sql.includes("INSERT INTO saas_runs"))).toBe(false);

    const conflict = createExecutorHarness({ runPatch: { agent_name: "agent-a" } });
    const conflictStorage = new PostgresRuntimeStorage(conflict.tenantId, conflict.rootExecutor);
    await expect(conflictStorage.operations.startRun({
      session: { sessionId: "session-1", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "run-1", sessionId: "session-1", agentName: "agent-b" },
    })).rejects.toThrow("run scope conflict (agent)");
  });

  it("rejects final-message identity and terminal-state conflicts", async () => {
    const messageConflict = createExecutorHarness();
    messageConflict.messages.set("message-1", {
      seq: 17, id: "message-1", session_id: "session-1", role: "assistant",
      content: "different", metadata: {}, thread_key: "root", child_agent_id: null, created_at: NOW,
    });
    const messageStorage = new PostgresRuntimeStorage(messageConflict.tenantId, messageConflict.rootExecutor);
    await expect(messageStorage.operations.finalizeRun({
      runId: "run-1", sessionId: "session-1", status: "completed",
      finalMessage: {
        messageId: "message-1", sessionId: "session-1", role: "assistant", content: "answer",
      },
    })).rejects.toThrow("final message immutable fields conflict");

    const statusConflict = createExecutorHarness({ runStatus: "failed" });
    const statusStorage = new PostgresRuntimeStorage(statusConflict.tenantId, statusConflict.rootExecutor);
    await expect(statusStorage.operations.finalizeRun({
      runId: "run-1", sessionId: "session-1", status: "interrupted",
    })).rejects.toThrow("run terminal status conflict");
  });

  it("validates reused initial messages and terminal message rules", async () => {
    const initialConflict = createExecutorHarness();
    initialConflict.messages.set("user-message-1", {
      seq: 1, id: "user-message-1", session_id: "session-1", role: "user",
      content: "different", metadata: {}, thread_key: "root", child_agent_id: null, created_at: NOW,
    });
    const storage = new PostgresRuntimeStorage(initialConflict.tenantId, initialConflict.rootExecutor);
    await expect(storage.operations.startRun({
      session: { sessionId: "session-1", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null },
      run: { runId: "run-1", sessionId: "session-1" },
      initialUserMessage: {
        messageId: "user-message-1", sessionId: "session-1", role: "user", content: "question",
      },
    })).rejects.toThrow("initial user message immutable fields conflict");

    await expect(storage.operations.finalizeRun({
      runId: "run-1", sessionId: "session-1", status: "completed",
    })).rejects.toThrow("completed finalize requires a final message");
    await expect(storage.operations.finalizeRun({
      runId: "run-1", sessionId: "session-1", status: "suspended",
      finalMessage: {
        messageId: "message-1", sessionId: "session-1", role: "assistant", content: "answer",
      },
    })).rejects.toThrow("suspended finalize must not include a final message");
  });

  it("returns the same step and outbox when an event id is retried", async () => {
    const harness = createExecutorHarness();
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);
    const input = {
      step: {
        sessionId: "session-1", runId: "run-1", stepType: "protocol.envelope.v1",
        payload: { type: "tool_call" },
      },
      outbox: {
        eventId: "event-retry", sessionId: "session-1", runId: "run-1",
        eventType: "client.tool_call", aggregateType: "run", aggregateId: "run-1",
        payload: { client_event: { type: "tool_call" } },
      },
    };

    const first = await storage.operations.recordEnvelope(input);
    const second = await storage.operations.recordEnvelope(input);
    expect(second).toEqual(first);
    expect(harness.transactionQueries.filter(({ sql }) => sql.includes("INSERT INTO saas_run_steps"))).toHaveLength(1);
    expect(harness.transactionQueries.filter(({ sql }) => sql.includes("INSERT INTO event_outbox"))).toHaveLength(1);
  });

  it("persists and reuses a deterministic message with its continuation in one transaction", async () => {
    const harness = createExecutorHarness();
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);
    const input = persistMessageInput("message-persist");

    const first = await storage.operations.persistMessage(input);
    const replay = await storage.operations.persistMessage(input);

    expect(replay.message).toEqual(first.message);
    expect(replay.providerContinuation?.message_id).toBe("message-persist");
    expect(harness.messages).toHaveLength(1);
    expect(harness.providerContinuations).toHaveLength(1);
    const advisoryIndex = harness.transactionQueries.findIndex(({ sql, params }) => (
      sql.includes("pg_advisory_xact_lock") && params[0] === "message:message-persist"
    ));
    const lookupIndex = harness.transactionQueries.findIndex(({ sql, params }) => (
      sql.startsWith("SELECT session_id FROM conversation_messages") && params[0] === "message-persist"
    ));
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(advisoryIndex).toBeLessThan(lookupIndex);
  });

  it("treats JSON object key order as immaterial for deterministic message retries", async () => {
    const harness = createExecutorHarness();
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);
    const input = persistMessageInput("message-json-order");

    await storage.operations.persistMessage({
      ...input,
      message: { ...input.message, metadata: { first: 1, second: 2 } },
    });
    await expect(storage.operations.persistMessage({
      ...input,
      message: { ...input.message, metadata: { second: 2, first: 1 } },
    })).resolves.toBeDefined();
  });

  it("deletes the previous continuation and rejects scope or message conflicts", async () => {
    const harness = createExecutorHarness();
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);
    await storage.operations.persistMessage(persistMessageInput("message-old"));
    const replacement = persistMessageInput("message-new");

    const result = await storage.operations.persistMessage({
      ...replacement,
      deleteProviderContinuationThreadKey: "root",
    });
    expect(result.deletedProviderContinuations).toBe(1);
    expect(harness.providerContinuations.has("message-old")).toBe(false);

    await expect(storage.operations.persistMessage({
      ...replacement,
      message: { ...replacement.message, content: "changed" },
    })).rejects.toThrow("message immutable fields conflict");
    await expect(storage.operations.persistMessage({
      ...persistMessageInput("message-scope"),
      providerContinuation: {
        ...persistMessageInput("message-scope").providerContinuation!,
        sessionId: "session-other",
      },
    })).rejects.toThrow("provider continuation session mismatch");
  });

  it("rolls back a newly inserted message when continuation persistence fails", async () => {
    const harness = createExecutorHarness({ failProviderContinuation: true });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    await expect(storage.operations.persistMessage(
      persistMessageInput("message-rollback"),
    )).rejects.toThrow("provider continuation failure");

    expect(harness.messages.has("message-rollback")).toBe(false);
    expect(harness.providerContinuations.has("message-rollback")).toBe(false);
  });

  it("records and resolves a batch idempotently, allows one resume claim, and rolls it back by token", async () => {
    const harness = createExecutorHarness({
      runStatus: "running",
      runPatch: {
        agent_name: "agent-1",
        task_summary: "approve tools",
        request_id: "request-1",
        user_id: "user-1",
        entrypoint: "agent_stream",
        owner_instance_id: "test-instance",
        lease_expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "test-instance");
    const firstInteraction = interactionInput("interaction-1", "tool-1");
    const secondInteraction = interactionInput("interaction-2", "tool-2");

    const firstRecord = await storage.operations.recordInteraction({
      interaction: firstInteraction,
      rootCallId: "root-call-1",
      record: interactionRecord(firstInteraction, "required"),
    });
    const replayedRecord = await storage.operations.recordInteraction({
      interaction: firstInteraction,
      rootCallId: "root-call-1",
      record: interactionRecord(firstInteraction, "required"),
    });
    await storage.operations.recordInteraction({
      interaction: secondInteraction,
      rootCallId: "root-call-1",
      record: interactionRecord(secondInteraction, "required"),
    });

    expect(replayedRecord).toEqual(firstRecord);
    expect(harness.interactions).toHaveLength(2);
    expect([...harness.eventOutboxes.keys()].filter((eventId) => eventId.endsWith(":required")))
      .toHaveLength(2);
    harness.patchRunState({ status: "suspended", owner_instance_id: null, lease_expires_at: null });

    const firstResolution = {
      sessionId: "session-1",
      interactionId: "interaction-1",
      resolution: { kind: "approval" as const, approved: true, message: "allow one" },
      buildRecord: () => interactionRecord(firstInteraction, "responded"),
    };
    const resolvedFirst = await storage.operations.resolveInteraction(firstResolution);
    const replayedFirst = await storage.operations.resolveInteraction(firstResolution);
    await expect(storage.operations.claimResume({
      sessionId: "session-1",
      interactionId: "interaction-1",
      claimId: "claim-too-early",
    })).resolves.toEqual({ claimed: false, reason: "batch_incomplete" });
    const resolvedSecond = await storage.operations.resolveInteraction({
      sessionId: "session-1",
      interactionId: "interaction-2",
      resolution: { kind: "approval", approved: false, message: "deny two" },
      buildRecord: () => interactionRecord(secondInteraction, "responded"),
    });

    expect(resolvedFirst).toMatchObject({ changed: true, batchReady: false, rootRunStatus: "suspended" });
    expect(replayedFirst).toMatchObject({ changed: false, batchReady: false, rootRunStatus: "suspended" });
    expect(resolvedSecond).toMatchObject({ changed: true, batchReady: true, rootRunStatus: "suspended" });
    expect([...harness.eventOutboxes.keys()].filter((eventId) => eventId.endsWith(":responded")))
      .toHaveLength(2);
    await expect(storage.operations.resolveInteraction({
      ...firstResolution,
      resolution: { kind: "approval", approved: false, message: "conflict" },
    })).rejects.toThrow("resolution conflict");

    const claimed = await storage.operations.claimResume({
      sessionId: "session-1",
      interactionId: "interaction-1",
      claimId: "claim-1",
    });
    await expect(storage.operations.claimResume({
      sessionId: "session-1",
      interactionId: "interaction-2",
      claimId: "claim-2",
    })).resolves.toEqual({ claimed: false, reason: "already_claimed" });
    expect(claimed).toMatchObject({
      claimed: true,
      claimId: "claim-1",
      batchId: "batch-1",
      rootRunId: "run-1",
      rootCallId: "root-call-1",
      agentName: "agent-1",
      task: "approve tools",
      requestId: "request-1",
      executionKind: "agent_stream",
      userId: "user-1",
      sessionIdentity: expect.objectContaining({
        sessionId: "session-1",
        metadata: { source: "contract-test" },
      }),
      resolutions: expect.arrayContaining([
        expect.objectContaining({ interactionId: "interaction-1", toolCallId: "tool-1" }),
        expect.objectContaining({ interactionId: "interaction-2", toolCallId: "tool-2" }),
      ]),
    });
    expect(harness.runState).toMatchObject({
      status: "running",
      owner_instance_id: expect.any(String),
      lease_expires_at: "2099-01-01T00:00:00.000Z",
    });

    await expect(storage.operations.rollbackResume({
      sessionId: "session-1",
      rootRunId: "run-1",
      claimId: "stale-claim",
    })).resolves.toEqual({ rolledBack: false });
    expect(harness.runState?.status).toBe("running");
    await expect(storage.operations.rollbackResume({
      sessionId: "session-1",
      rootRunId: "run-1",
      claimId: "claim-1",
    })).resolves.toEqual({ rolledBack: true });
    expect(harness.runState?.status).toBe("suspended");
    expect([...harness.interactions.values()].map((interaction) => [
      interaction.status,
      interaction.resume_claim_id,
    ])).toEqual([
      ["resolved", null],
      ["resolved", null],
    ]);
  });

  it("keeps a grandchild interaction on the durable root lineage", async () => {
    const childRun = {
      run_id: "child-run", session_id: "session-1", tenant_id: createTenantId("tnt_runtime_storage"),
      entrypoint: "call_agent", status: "running", task_summary: "child", request_id: "request-1",
      user_id: "user-1", agent_name: "child-agent", thread_key: "child:one",
      parent_run_id: "run-1", parent_call_id: "tool-child", child_agent_id: "child-1",
      final_message_id: null, created_at: NOW, updated_at: NOW,
    };
    const grandchildRun = {
      ...childRun,
      run_id: "grandchild-run",
      agent_name: "grandchild-agent",
      thread_key: "child:two",
      parent_run_id: "child-run",
      parent_call_id: "tool-grandchild",
      child_agent_id: "child-2",
    };
    const harness = createExecutorHarness({
      runPatch: {
        agent_name: "root-agent", task_summary: "root task", request_id: "request-1",
        user_id: "user-1", entrypoint: "agent_stream",
        owner_instance_id: "test-instance", lease_expires_at: "2099-01-01T00:00:00.000Z",
      },
      additionalRuns: { "child-run": childRun, "grandchild-run": grandchildRun },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "test-instance");
    const interaction = {
      ...interactionInput("grandchild-interaction", "grandchild-tool", "grandchild-batch"),
      runId: "grandchild-run",
      rootRunId: "run-1",
    };

    await storage.operations.recordInteraction({
      interaction,
      rootCallId: "root-call-0",
      record: interactionRecord({ ...interaction, runId: "grandchild-run" }, "required"),
    });
    await storage.operations.finalizeRun({ runId: "run-1", sessionId: "session-1", status: "suspended", interactionRootRunId: "run-1" });
    await storage.operations.resolveInteraction({
      sessionId: "session-1",
      interactionId: "grandchild-interaction",
      resolution: { kind: "approval", approved: true, message: "ok" },
      buildRecord: () => interactionRecord({ ...interaction, runId: "grandchild-run" }, "responded"),
    });
    const claim = await storage.operations.claimResume({
      sessionId: "session-1",
      interactionId: "grandchild-interaction",
      claimId: "grandchild-claim",
    });

    expect(claim).toMatchObject({ claimed: true, rootRunId: "run-1", rootCallId: "root-call-0" });
    expect(harness.interactions.get("grandchild-interaction")).toMatchObject({
      run_id: "grandchild-run",
      root_run_id: "run-1",
    });
  });

  it("rolls back pending, step, and outbox writes when interaction recording fails", async () => {
    const interaction = interactionInput("interaction-rollback", "tool-rollback");
    const harness = createExecutorHarness({
      failOutboxEventId: "interaction-rollback:required",
      runPatch: { owner_instance_id: "test-instance", lease_expires_at: "2099-01-01T00:00:00.000Z" },
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "test-instance");

    await expect(storage.operations.recordInteraction({
      interaction,
      rootCallId: "root-call-1",
      record: interactionRecord(interaction, "required"),
    })).rejects.toThrow("outbox failure");

    expect(harness.interactions).toHaveLength(0);
    expect(harness.eventSteps).toHaveLength(0);
    expect(harness.eventOutboxes).toHaveLength(0);
  });

  it("rejects a pending batch that mixes root runs", async () => {
    const harness = createExecutorHarness({
      runPatch: { owner_instance_id: "test-instance", lease_expires_at: "2099-01-01T00:00:00.000Z" },
    });
    harness.interactions.set("foreign-root-interaction", {
      interaction_id: "foreign-root-interaction",
      session_id: "session-1",
      run_id: "run-foreign",
      root_run_id: "root-foreign",
      tool_call_id: "tool-foreign",
      batch_id: "batch-mixed",
      kind: "approval",
      status: "waiting",
      request_payload: { rootCallId: "root-call-foreign" },
      resolution_payload: null,
      created_at: NOW,
      updated_at: NOW,
      responded_at: null,
      consumed_at: null,
      resume_claim_id: null,
    });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor, "test-instance");
    const interaction = interactionInput("interaction-local", "tool-local", "batch-mixed");

    await expect(storage.operations.recordInteraction({
      interaction,
      rootCallId: "root-call-1",
      record: interactionRecord(interaction, "required"),
    })).rejects.toThrow("batch spans multiple root runs");

    expect(harness.interactions.has("interaction-local")).toBe(false);
    harness.interactions.set("interaction-local", {
      interaction_id: "interaction-local",
      session_id: "session-1",
      run_id: "run-1",
      root_run_id: "run-1",
      tool_call_id: "tool-local",
      batch_id: "batch-mixed",
      kind: "approval",
      status: "waiting",
      request_payload: { ...interaction.requestPayload, rootCallId: "root-call-1" },
      resolution_payload: null,
      created_at: NOW,
      updated_at: NOW,
      responded_at: null,
      consumed_at: null,
      resume_claim_id: null,
    });
    await expect(storage.operations.resolveInteraction({
      sessionId: "session-1",
      interactionId: "interaction-local",
      resolution: { kind: "approval", approved: true, message: "must reject" },
      buildRecord: () => interactionRecord(interaction, "responded"),
    })).rejects.toThrow("batch spans multiple root runs");
    expect(harness.interactions.get("interaction-local")?.status).toBe("waiting");
    await expect(storage.operations.claimResume({
      sessionId: "session-1",
      interactionId: "interaction-local",
      claimId: "claim-mixed",
    })).rejects.toThrow("batch spans multiple root runs");
  });
});
