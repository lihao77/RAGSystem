import { describe, expect, it } from "vitest";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { SdkStoreAdapter } from "../../src/services/agent/sdk/sdk-store-adapter.js";

// 回归：子 agent 的 runs 行会被消费端（delegation）预创建一次以预置 SDK 不携带的
// parent_run_id/child_agent_id 血缘字段，随后 SDK Dispatcher.startRun()→store.createRun()
// 会用同一 run_id 再写一次，触发 UNIQUE constraint failed: runs.run_id。SdkStoreAdapter.createRun
// 必须在行已存在时幂等跳过，既不抛约束冲突，也不覆盖预置血缘。
describe("SdkStoreAdapter.createRun (child-run double-write regression)", () => {
  it("skips the SDK createRun when delegation already pre-created the child run, preserving lineage", () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    store.createSession("s1", null, { team: "default" });
    const adapter = new SdkStoreAdapter({ conversationStore: store });

    // delegation 预创建 child run（带 parent_run_id/child_agent_id 血缘）
    store.createRun({
      runId: "child-run-1",
      sessionId: "s1",
      status: "running",
      threadKey: "child:child-existing",
      parentRunId: "parent-run",
      parentCallId: "agent-call-1",
      childAgentId: "child-existing",
    });

    // SDK Dispatcher.startRun() 用同一 run_id 再次 createRun —— 修复前抛 UNIQUE 约束
    expect(() =>
      adapter.createRun({
        id: "child-run-1",
        sessionId: "s1",
        rootCallId: "agent-call-1",
        threadKey: "child:child-existing",
        parentCallId: "root-call",
      }),
    ).not.toThrow();

    // 预置血缘未被 SDK 的重复 createRun 覆盖
    const run = store.getRun("s1", "child-run-1");
    expect(run).toMatchObject({
      run_id: "child-run-1",
      parent_run_id: "parent-run",
      child_agent_id: "child-existing",
      thread_key: "child:child-existing",
    });
    // runId→sessionId 映射仍登记（getRun/updateRunStatus 解析 sessionId 用）
    expect(adapter.getRun("child-run-1")).toMatchObject({ id: "child-run-1", sessionId: "s1" });
    store.close();
  });

  it("creates the run when no row exists (root runs unaffected)", () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    store.createSession("s2", null, {});
    const adapter = new SdkStoreAdapter({ conversationStore: store });

    adapter.createRun({
      id: "root-run-1",
      sessionId: "s2",
      rootCallId: "call_root",
      threadKey: "root",
      parentCallId: "call_root",
    });

    const run = store.getRun("s2", "root-run-1");
    expect(run).toMatchObject({ run_id: "root-run-1", thread_key: "root", parent_call_id: null });
    store.close();
  });
});
