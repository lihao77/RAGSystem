import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { buildTestHarness } from "../helpers/app.js";

const close: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(close.splice(0).map((dispose) => dispose()));
});

describe("memory governance routes", () => {
  it("lists Local memory entries and archives a personal entry immediately", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    await harness.localInfrastructure.memoryStore.saveMemory({
      scope: "user", user_id: "usr_local", name: "Preference", description: "personal",
      memory_type: "preference", content: "Use concise answers",
    });
    await harness.localInfrastructure.memoryStore.saveMemory({
      scope: "user", user_id: "usr_other", name: "Private", description: "other user",
      memory_type: "fact", content: "must stay hidden",
    });

    const listed = await harness.app.inject({
      method: "GET",
      url: "/api/memory/entries?scope=user&status=active&search=Preference",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toMatchObject({ total: 1, has_more: false });
    expect(listed.json().data.items).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        tenant_id: "tnt_local",
        scope: "user",
        scope_id: "usr_local",
        name: "Preference",
        status: "active",
        version: 1,
      }),
    ]);

    const entry = listed.json().data.items[0];
    const archived = await harness.app.inject({
      method: "POST",
      url: `/api/memory/entries/${entry.id}/archive`,
      payload: { expected_version: entry.version },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ success: true, data: { status: "archived" } });
  });

  it("creates a Local review candidate instead of directly archiving shared memory", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    await harness.localInfrastructure.memoryStore.saveMemory({
      scope: "team", team_name: "default", name: "Shared", description: "team policy",
      memory_type: "fact", content: "Use citations",
    });
    const listed = await harness.app.inject({ method: "GET", url: "/api/memory/entries?scope=team&status=active" });
    const entry = listed.json().data.items[0];

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/memory/entries/${entry.id}/archive`,
      payload: { expected_version: entry.version },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, data: { status: "candidate" } });
    const candidate = harness.localInfrastructure.conversationStore.getMemoryCandidate(response.json().data.candidate.id);
    expect(candidate).toMatchObject({
      tenant_id: "tnt_local",
      owner_user_id: "usr_local",
      target_scope: "team",
      team_name: "default",
      operation: "archive",
      target_file_name: expect.stringMatching(/\.md$/),
      status: "candidate",
    });
    expect(harness.localInfrastructure.memoryStore.listEntries({ scope: "team", team_name: "default" })).toHaveLength(1);
  });

  it("keeps legacy personal candidates out of the Local admin review queue", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    const create = (name: string, targetScope: "team" | "agent") => harness.localInfrastructure.conversationStore.createMemoryCandidate({
      tenantId: "tnt_local", ownerUserId: "usr_local", targetScope, teamName: "default",
      ...(targetScope === "agent" ? { agentName: "orchestrator_agent" } : {}),
      name, description: name, memoryType: "fact", content: name,
    });
    create("Team", "team");
    create("Agent", "agent");
    const legacyPersonal = create("Legacy personal", "team");
    const db = new DatabaseSync(path.join(harness.root, "test.db"));
    db.exec("PRAGMA ignore_check_constraints=ON");
    db.prepare("UPDATE memory_candidates SET target_scope='user' WHERE id=?").run(legacyPersonal.id);
    db.close();

    const response = await harness.app.inject({ method: "GET", url: "/api/memory/admin/candidates?limit=1" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ total: 2, limit: 1, offset: 0, has_more: true });
    expect(response.json().data.items).toHaveLength(1);
    expect(response.json().data.items[0].target_scope).toMatch(/^(team|agent)$/);

    for (const action of ["approve", "reject"]) {
      const review = await harness.app.inject({
        method: "POST",
        url: `/api/memory/admin/candidates/${legacyPersonal.id}/${action}`,
        payload: {},
      });
      expect(review.statusCode).toBe(400);
    }
    expect(harness.localInfrastructure.conversationStore.getMemoryCandidate(legacyPersonal.id)).toMatchObject({
      status: "candidate",
      reviewer_user_id: null,
    });
  });

  it("publishes the administrator-edited content and can archive it", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    const candidate = harness.localInfrastructure.conversationStore.createMemoryCandidate({
      tenantId: "tnt_local",
      ownerUserId: "usr_local",
      targetScope: "team",
      teamName: "default",
      name: "Draft",
      description: "draft description",
      memoryType: "fact",
      content: "draft content",
    });

    const approved = await harness.app.inject({
      method: "POST",
      url: `/api/memory/admin/candidates/${candidate.id}/approve`,
      payload: { name: "Published", description: "published description", content: "published content" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data).toMatchObject({
      status: "approved",
      name: "Published",
      description: "published description",
      content: "published content",
    });
    expect(fs.readFileSync(harness.localInfrastructure.memoryStore.getIndexPath({ scope: "team", team_name: "default" }), "utf8"))
      .toContain("Published");
  });

  it("updates and withdraws Local candidates without a client version", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    const create = (name: string) => harness.localInfrastructure.conversationStore.createMemoryCandidate({
      tenantId: "tnt_local",
      ownerUserId: "usr_local",
      targetScope: "team",
      teamName: "default",
      name,
      description: name,
      memoryType: "fact",
      content: name,
    });
    const editable = create("Editable");
    const removable = create("Removable");

    const updated = await harness.app.inject({
      method: "PATCH",
      url: `/api/memory/candidates/${editable.id}`,
      payload: { content: "updated" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({ id: editable.id, content: "updated" });

    const withdrawn = await harness.app.inject({
      method: "DELETE",
      url: `/api/memory/candidates/${removable.id}`,
      payload: {},
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(harness.localInfrastructure.conversationStore.getMemoryCandidate(removable.id)).toMatchObject({ status: "withdrawn" });
  });

  it("applies an archive candidate only after administrator approval", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    const saved = await harness.localInfrastructure.memoryStore.saveMemory({
      scope: "team", team_name: "default", name: "Shared", description: "shared", memory_type: "fact", content: "active",
    });
    const candidate = harness.localInfrastructure.conversationStore.createMemoryCandidate({
      tenantId: "tnt_local",
      ownerUserId: "usr_local",
      targetScope: "team",
      operation: "archive",
      targetFileName: saved.file_name,
      teamName: "default",
      name: `Archive ${saved.file_name}`,
      description: "archive request",
      memoryType: "constraint",
      content: "",
    });
    expect(fs.readFileSync(saved.file_path, "utf8")).toContain("status: active");

    const approved = await harness.app.inject({
      method: "POST",
      url: `/api/memory/admin/candidates/${candidate.id}/approve`,
      payload: { comment: "remove obsolete memory" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data).toMatchObject({ status: "approved", operation: "archive" });
    expect(fs.readFileSync(saved.file_path, "utf8")).toContain("status: archived");
  });
});
