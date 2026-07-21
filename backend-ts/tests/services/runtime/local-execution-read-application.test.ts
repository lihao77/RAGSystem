import { describe, expect, it, vi } from "vitest";
import { LocalExecutionReadApplication } from "../../../src/adapters/local/application/execution-read/local-execution-read-application.js";

describe("LocalExecutionReadApplication", () => {
  it("adapts all in-process execution reads to the async contract", async () => {
    const execution = {
      getSessionTaskStatus: vi.fn(() => ({ session_id: "s1" })),
      getSessionExecutionDiagnostics: vi.fn(() => ({ scope: "session_id" })),
      getTaskStatus: vi.fn(() => ({ task_id: "t1" })),
      getTaskExecutionDiagnostics: vi.fn(() => ({ scope: "task_id" })),
      listRunningTasks: vi.fn(() => ({ active_only: true, count: 0, items: [] })),
      getOverview: vi.fn(() => ({ active_only: true, count: 1, by_execution_kind: {}, by_status: {}, sessions: [], items: [] })),
    };
    const conversations = {
      getSession: vi.fn(() => ({ session_id: "s1" })),
      listRuns: vi.fn(() => ({ items: [] })),
      listOutboxForReplay: vi.fn(() => []),
      getPersistedExecutionOverview: vi.fn(() => ({ active_only: false, count: 0, by_execution_kind: {}, by_status: {}, sessions: [], items: [] })),
    };
    const application = new LocalExecutionReadApplication(execution as never, conversations as never);

    await application.getSessionTaskStatus("s1");
    await application.getSessionExecutionDiagnostics("s1");
    await application.getTaskStatus("t1");
    await application.getTaskExecutionDiagnostics("t1");
    await application.listRunningTasks();
    await application.getOverview(true);

    expect(execution.getSessionTaskStatus).toHaveBeenCalledWith("s1");
    expect(execution.getTaskStatus).toHaveBeenCalledWith("t1");
    expect(conversations.getPersistedExecutionOverview).toHaveBeenCalled();
  });

  it("falls back to persisted overview when no live tasks are tracked", async () => {
    const live = { active_only: false, count: 0, by_execution_kind: {}, by_status: {}, sessions: [], items: [] };
    const persisted = { ...live, count: 2 };
    const execution = { getOverview: vi.fn(() => live) };
    const conversations = {
      getSession: vi.fn(() => ({ session_id: "s1" })),
      listRuns: vi.fn(() => ({ items: [] })),
      listOutboxForReplay: vi.fn(() => []),
      getPersistedExecutionOverview: vi.fn(() => persisted),
    };
    const application = new LocalExecutionReadApplication(execution as never, conversations as never);

    await expect(application.getOverview(false)).resolves.toBe(persisted);
    expect(conversations.getPersistedExecutionOverview).toHaveBeenCalledWith(false);
  });
});
