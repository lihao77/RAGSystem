import assert from "node:assert/strict";
import test from "node:test";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";

const agents = { assistant: { agent_name: "assistant" } };

function createSession(store) {
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
}

test("visible message SQL only treats native JSON booleans as visibility flags", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    createSession(store);
    const cases = [
      ["default", {}, true],
      ["native hidden", { hidden: true }, false],
      ["string hidden", { hidden: "true" }, true],
      ["numeric hidden", { hidden: 1 }, true],
      ["native invisible", { visible_to_user: false }, false],
      ["numeric invisible", { visible_to_user: 0 }, true],
      ["string invisible", { visible_to_user: "false" }, true],
      ["native agent message override", { visible_to_user: false, agent_message: true }, true],
      ["string agent message does not override", { visible_to_user: false, agent_message: "true" }, false],
    ];
    for (const [content, metadata] of cases) {
      store.addMessage({
        sessionId: "session-1",
        role: "user",
        content,
        contentParts: [{ type: "text", text: content }],
        metadata,
        threadKey: "root",
      });
    }

    const page = store.listVisibleMessages("session-1", "root");
    assert.deepEqual(page.items.map(item => item.content), cases.filter(item => item[2]).map(item => item[0]));
    assert.equal(page.total, cases.filter(item => item[2]).length);
  } finally {
    store.close();
  }
});
