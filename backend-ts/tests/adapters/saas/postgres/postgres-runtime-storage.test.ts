import { describe, expect, it } from "vitest";

import { PostgresRuntimeStorage } from "../../../../src/adapters/saas/postgres/postgres-runtime-storage.js";
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

function createExecutorHarness(options: {
  sessionExists?: boolean;
  sessionTenantId?: string;
  runExists?: boolean;
  runStatus?: string;
  runPatch?: Record<string, unknown>;
  failProviderContinuation?: boolean;
} = {}) {
  const tenantId = createTenantId("tnt_runtime_storage");
  const transactionQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const messages = new Map<string, Record<string, unknown>>();
  const eventSteps = new Map<string, Record<string, unknown>>();
  const eventOutboxes = new Map<string, Record<string, unknown>>();
  const providerContinuations = new Map<string, Record<string, unknown>>();
  let rootQueryCount = 0;
  let transactionCount = 0;
  let sessionExists = options.sessionExists ?? true;
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
        sessionExists = true;
        rows = [{ tenant_id: tenantId }];
      } else if (sql.includes("SELECT tenant_id FROM conversation_sessions")) {
        rows = sessionExists ? [{ tenant_id: options.sessionTenantId ?? tenantId }] : [];
      } else if (sql.includes("FROM saas_runs WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE")) {
        rows = runState ? [runState] : [];
      } else if (sql.includes("SELECT run_id FROM saas_runs")) {
        rows = runState ? [{ run_id: "run-1" }] : [];
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
          created_at: NOW,
          updated_at: NOW,
        };
      } else if (sql.startsWith("UPDATE saas_runs")) {
        if (runState) {
          runState = { ...runState, status: String(params[0]), final_message_id: params[1] ?? null };
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
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(): Promise<PostgresQueryResult<Row>> => {
      rootQueryCount += 1;
      throw new Error("pool executor query must not be used inside an atomic operation");
    },
    transaction: async (operation) => {
      transactionCount += 1;
      const messageSnapshot = new Map(messages);
      const continuationSnapshot = new Map(providerContinuations);
      try {
        return await operation(transactionExecutor);
      } catch (error) {
        messages.clear();
        for (const [key, value] of messageSnapshot) messages.set(key, value);
        providerContinuations.clear();
        for (const [key, value] of continuationSnapshot) providerContinuations.set(key, value);
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
    providerContinuations,
    get rootQueryCount() { return rootQueryCount; },
    get transactionCount() { return transactionCount; },
  };
}

describe("PostgresRuntimeStorage", () => {
  it("starts a run atomically with tenant binding and a deterministic initial message", async () => {
    const harness = createExecutorHarness({ sessionExists: false, runExists: false });
    const storage = new PostgresRuntimeStorage(harness.tenantId, harness.rootExecutor);

    const result = await storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-1" },
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
    const sessionInsert = harness.transactionQueries.find(({ sql }) => sql.startsWith("INSERT INTO conversation_sessions"));
    const runInsert = harness.transactionQueries.find(({ sql }) => sql.includes("INSERT INTO saas_runs"));
    expect(sessionInsert?.params[1]).toBe(harness.tenantId);
    expect(runInsert?.params[0]).toBe(harness.tenantId);
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
      session: { sessionId: "session-1", userId: null },
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
      suspendRootRunId: "run-1",
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
      session: { sessionId: "session-1", userId: null },
      run: { runId: "run-1", sessionId: "session-1" },
    })).resolves.toMatchObject({ run: { run_id: "run-1" } });
    expect(equal.transactionQueries.some(({ sql }) => sql.includes("INSERT INTO saas_runs"))).toBe(false);

    const conflict = createExecutorHarness({ runPatch: { agent_name: "agent-a" } });
    const conflictStorage = new PostgresRuntimeStorage(conflict.tenantId, conflict.rootExecutor);
    await expect(conflictStorage.operations.startRun({
      session: { sessionId: "session-1", userId: null },
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
      session: { sessionId: "session-1", userId: null },
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
});
