import assert from "node:assert/strict";
import test from "node:test";

import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";
import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";

test("child participant latest Run update is compare-and-set when an expectation is supplied", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    const agents = { assistant: { agent_name: "assistant" } };
    store.createSession({
      sessionId: "session-1",
      tenantId: "tnt_test",
      ownerUserId: "usr_test",
      visibility: "private",
      originType: "direct",
      originId: null,
      originChannel: "web",
      workspaceId: null,
      permissionMode: null,
      teamSnapshot: {
        team_name: "default",
        team_revision: computeSessionTeamRevision(agents),
        entry_agent_name: "assistant",
        agents,
      },
      metadata: {},
    });
    store.createChildAgent({
      childAgentId: "child-1",
      sessionId: "session-1",
      agentName: "assistant",
      threadKey: "child:child-1",
    });

    assert.equal(store.updateChildAgentLastRun({
      sessionId: "session-1",
      childAgentId: "child-1",
      lastRunId: "run-a",
      expectedLastRunId: null,
    }), true);
    assert.equal(store.updateChildAgentLastRun({
      sessionId: "session-1",
      childAgentId: "child-1",
      lastRunId: "run-b",
      expectedLastRunId: null,
    }), false);
    assert.equal(store.getChildAgent("session-1", "child-1")?.last_run_id, "run-a");
  } finally {
    store.close();
  }
});
