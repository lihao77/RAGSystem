import assert from "node:assert/strict";
import test from "node:test";
import { partsToPlainText } from "@ragsystem/agent-protocol";
import { computeSessionTeamRevision, toSessionIdentity } from "@ragsystem/backend-core/contracts/session/session.js";
import { TaskToolService } from "@ragsystem/backend-core/tools/TaskTools/TaskExecution.js";
import { createSessionControl } from "../../backend-core/dist/services/agent/execution/session-control.js";
import { AgentExecutionStatusTracker } from "../../backend-core/dist/services/agent/execution/status-tracker.js";
import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { LocalGoalStore } from "../dist/adapters/local/local-goal-store.js";
import { SqliteRuntimeStorage } from "../dist/adapters/local/sqlite-runtime-storage.js";

function harness(t) {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  t.after(() => store.close());
  const agents = { root: { agent_name: "root" } };
  store.createSession({ tenantId: "tnt_test", sessionId: "session-1", ownerUserId: "usr_test", visibility: "private",
    originType: "direct", originId: null, originChannel: "web", workspaceId: null, metadata: {},
    teamSnapshot: { team_name: "test", team_revision: computeSessionTeamRevision(agents), entry_agent_name: "root", agents },
  });
  const goals = new LocalGoalStore("tnt_test", store);
  const storage = new SqliteRuntimeStorage("tnt_test", store);
  const tools = new TaskToolService({}, goals);
  const control = createSessionControl({ goalStore: goals, runtimeStorage: storage,
    statusTracker: new AgentExecutionStatusTracker(),
    pendingInteractions: { cancelSession: async () => {} },
    clientEvents: { publish: async () => {}, deliver: async () => {} },
  });
  const goal = store.createGoal("session-1", { objective: "完成报告", successCriteria: ["报告已生成"] });
  return { store, goals, storage, tools, control, goal };
}

test("stop between runs pauses once, records history without a run, and explicit resume records its transition", async (t) => {
  const { store, goals, control, goal } = harness(t);
  assert.equal(await control.stopSession("session-1"), true);
  assert.equal(await control.stopSession("session-1"), true);
  assert.equal((await goals.getCurrent("session-1")).status, "paused");
  assert.equal(await goals.claimContinuation("session-1"), null);
  let messages = store.getRecentMessages("session-1", 100, "root");
  assert.equal(messages.length, 1);
  assert.match(partsToPlainText(messages[0].content_parts), /已暂停/);
  assert.equal(store.listRuns("session-1", 100).total, 0);
  await control.startGoal("session-1");
  await control.startGoal("session-1");
  messages = store.getRecentMessages("session-1", 100, "root");
  assert.equal(messages.length, 2);
  assert.ok(messages.some((message) => partsToPlainText(message.content_parts).includes("已由用户恢复")));
  assert.equal((await goals.get("session-1", goal.id)).status, "active");
});

test("a paused goal accepts plan edits, rejects old run writes, and resumes from a fresh user run", async (t) => {
  const { goals, tools, control, goal } = harness(t);
  const oldSignal = new AbortController().signal;
  await tools.captureGoalRun("session-1", oldSignal);
  await control.stopSession("session-1");
  const oldResult = await tools.goalUpdate({ status: "active" }, { sessionId: "session-1", signal: oldSignal });
  assert.equal(oldResult.success, false);
  const signal = new AbortController().signal;
  await tools.captureGoalRun("session-1", signal);
  const ctx = { sessionId: "session-1", signal, executionKind: "agent_stream" };
  assert.equal((await tools.goalUpdate({ progress: { done: 1 } }, ctx)).success, true);
  assert.equal((await goals.getCurrent("session-1")).status, "paused");
  assert.equal((await tools.goalUpdate({ status: "active" }, ctx)).success, true);
  const current = await goals.getCurrent("session-1");
  assert.equal(current.status, "active");
  assert.deepEqual(current.progress, { done: 1 });
  await assert.rejects(goals.update("session-1", goal.id, { progress: { done: 99 } }, { expectedGeneration: goal.continuation_generation }), /旧执行/);
  assert.deepEqual((await goals.getCurrent("session-1")).progress, { done: 1 });
});

test("the durable root start gate rejects queued continuations invalidated by pause and resume", async (t) => {
  const { store, goals, storage, goal } = harness(t);
  const claimed = await goals.claimContinuation("session-1");
  const session = toSessionIdentity(store.getSession("session-1"));
  const input = {
    session,
    run: { runId: "run-1", sessionId: "session-1", entrypoint: "system.goal_continuation", status: "running",
      taskSummary: "continue", requestId: "request-1", agentName: "root", agentCallId: "call-1",
      lineageParentCallId: null, agentDisplayName: "Root", leaseRootRunId: "run-1", threadKey: "root" },
    followupPolicy: "queue",
    mailboxMessage: { messageId: "old-goal-row", tenantId: "tnt_test", sessionId: "session-1", targetThreadKey: "root",
      kind: "request", inputType: "goal_continuation", sourceKind: "system", visibleToUser: false,
      contentParts: [{ type: "text", text: "继续目标" }], metadata: { goal_id: goal.id, goal_generation: claimed.continuation_generation } },
  };
  await store.agentMailbox.enqueue(input.mailboxMessage);
  await goals.update("session-1", goal.id, { status: "paused" });
  await goals.update("session-1", goal.id, { status: "active" });
  await assert.rejects(storage.operations.startOrAppendRoot(input), /expired generation/);
  assert.equal(store.listRuns("session-1", 100).total, 0);
  const fresh = await goals.claimContinuation("session-1");
  input.mailboxMessage = { ...input.mailboxMessage, messageId: "new-goal-row",
    metadata: { goal_id: goal.id, goal_generation: fresh.continuation_generation } };
  assert.equal((await storage.operations.startOrAppendRoot(input)).kind, "started");
  const paused = await goals.update("session-1", goal.id, { status: "paused" });
  await storage.operations.interruptSession({ sessionId: "session-1", pausedGoal: paused });
  await storage.operations.interruptSession({ sessionId: "session-1", pausedGoal: paused });
  const terminals = store.getRecentMessages("session-1", 100, "root").filter((message) => message.metadata.msg_type === "run_terminal");
  assert.equal(terminals.length, 1);
  assert.match(partsToPlainText(terminals[0].content_parts), /目标「完成报告」已暂停/);
});
