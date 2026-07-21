import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/local/memory-store.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { LocalMemoryApplication } from "../../src/adapters/local/application/memory/local-memory-application.js";
import { makeTempDb, makeTempRoot } from "../helpers/temp-db.js";
import { createTenantId } from "../../src/identity/types.js";

describe("LocalMemoryApplication", () => {
  it("projects Local candidate governance through the shared async contract", async () => {
    const root = makeTempRoot();
    const tenant = createTenantId("tnt_local_memory");
    const conversation = createConversationStore({ dbPath: makeTempDb(), dataRoot: root });
    const app = new LocalMemoryApplication(tenant, new MemoryStore({ dataRoot: root }), conversation);
    const candidate = await app.commands.createCandidate({
      scope: "team",
      scope_id: "default",
      operation: "publish",
      owner_user_id: "usr_owner",
      name: "Shared preference",
      description: "desc",
      memory_type: "preference",
      content: "content",
    });
    expect(candidate).toMatchObject({ tenant_id: tenant, scope: "team", status: "candidate", name: "Shared preference" });
    await expect(app.governance.getCandidate(candidate.id)).resolves.toMatchObject({ id: candidate.id, owner_user_id: "usr_owner" });
    await expect(app.governance.countCandidates({ owner_user_id: "usr_owner" })).resolves.toBe(1);
    await expect(app.commands.updateCandidate({
      candidate_id: candidate.id,
      owner_user_id: "usr_owner",
      expected_version: candidate.version + 1,
      content: "stale",
    })).resolves.toEqual({ outcome: "state_conflict" });
    await expect(app.commands.updateCandidate({
      candidate_id: candidate.id,
      owner_user_id: "usr_owner",
      expected_version: candidate.version,
      content: "updated",
    })).resolves.toMatchObject({ outcome: "applied", candidate: { content: "updated" } });
    conversation.close();
  });
});
