import fs from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { buildTestHarness } from "../helpers/app.js";

const close: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(close.splice(0).map((dispose) => dispose()));
});

describe("memory governance routes", () => {
  it("publishes the administrator-edited content and can archive it", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    const candidate = harness.container.conversationStore.createMemoryCandidate({
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
    expect(fs.readFileSync(harness.container.memoryStore.getIndexPath({ scope: "team", team_name: "default" }), "utf8"))
      .toContain("Published");
  });

  it("applies an archive candidate only after administrator approval", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    const saved = harness.container.memoryStore.saveMemory({
      scope: "team", team_name: "default", name: "Shared", description: "shared", memory_type: "fact", content: "active",
    });
    const candidate = harness.container.conversationStore.createMemoryCandidate({
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
