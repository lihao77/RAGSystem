import { describe, expect, it, vi } from "vitest";

import { AsyncKernelEventPersister } from "../src/services/agent/sdk/async-event-persister.js";
import type { AsyncPersisterRunContext } from "../src/services/agent/sdk/async-event-persister.js";
import type { RuntimeStorage } from "../src/contracts/storage/runtime-storage.js";
import type { ClientEventPublisherPort } from "../src/contracts/runtime/core-runtime-ports.js";
import type { SessionIdentity } from "../src/contracts/session/session.js";

const sessionIdentity = {
  sessionId: "session-1",
  ownerUserId: null,
  visibility: "private" as const,
  originType: "direct" as const,
  originId: null,
  originChannel: "api" as const,
  workspaceId: null,
  teamSnapshot: {},
  metadata: {},
  permissionMode: null,
} as SessionIdentity;

function baseCtx(): AsyncPersisterRunContext {
  return {
    tenantId: "tenant-1" as AsyncPersisterRunContext["tenantId"],
    sessionId: "session-1",
    runId: "run-1",
    threadKey: "root",
    agentName: "agent-1",
    agentDisplayName: "Agent 1",
    rootCallId: "root-call-1",
    sessionIdentity,
  } as AsyncPersisterRunContext;
}

/** finalizeRun 恒回终局消息行（completed 与 interrupted/failed 同形），seq=42。 */
function createHarness(finalMessageRow: { id: string; seq: number } | null) {
  const makeSnapshot = vi.fn(async () => "snapshot-1");
  const finalizeRun = vi.fn(async () => ({
    finalMessage: finalMessageRow
      ? { id: finalMessageRow.id, seq: finalMessageRow.seq, content_parts: [] }
      : null,
    records: [],
    readyResumeInteractionIds: [],
  }));
  const storage = {
    tenantId: "tenant-1",
    operations: { finalizeRun },
  } as unknown as RuntimeStorage;
  const clientEvents = {
    prepare: vi.fn(),
    flush: vi.fn(async () => undefined),
    deliver: vi.fn(async () => undefined),
  } as unknown as Pick<ClientEventPublisherPort, "prepare" | "deliver" | "flush">;
  const persister = new AsyncKernelEventPersister(storage, clientEvents, baseCtx(), { makeSnapshot });
  return { persister, makeSnapshot };
}

describe("AsyncKernelEventPersister file snapshot boundary", () => {
  it("commits a file snapshot on interrupted finalize (stopped runs must not leave edits pending forever)", async () => {
    const { persister, makeSnapshot } = createHarness({ id: "run-1:final", seq: 42 });
    await persister.finalize("interrupted", null, new Error("session_stopped"));
    expect(makeSnapshot).toHaveBeenCalledTimes(1);
    expect(makeSnapshot).toHaveBeenCalledWith("session-1", 42);
  });

  it("commits a file snapshot on failed finalize", async () => {
    const { persister, makeSnapshot } = createHarness({ id: "run-1:final", seq: 42 });
    await persister.finalize("failed", null, new Error("provider unavailable"));
    expect(makeSnapshot).toHaveBeenCalledWith("session-1", 42);
  });

  it("still commits a file snapshot on completed finalize", async () => {
    const { persister, makeSnapshot } = createHarness({ id: "run-1:final", seq: 42 });
    await persister.finalize("completed", { content: "done" });
    expect(makeSnapshot).toHaveBeenCalledWith("session-1", 42);
  });

  it("skips the snapshot when finalize produced no terminal message row", async () => {
    const { persister, makeSnapshot } = createHarness(null);
    await persister.finalize("failed", null, new Error("no terminal row"));
    expect(makeSnapshot).not.toHaveBeenCalled();
  });
});
