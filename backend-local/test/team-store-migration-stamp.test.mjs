import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FileAgentConfigTeamStore } from "../dist/adapters/filesystem/agent/file-team-store.js";

/** 迁移应用戳 sidecar：仅随迁移回写落盘、追加式、损坏容错（写失败不阻断）。 */
function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "team-store-stamp-"));
  const store = new FileAgentConfigTeamStore({ configRoot: dir });
  const teams = new Map([
    ["default", new Map([["orchestrator_agent", { agent_name: "orchestrator_agent", enabled: true }]])],
  ]);
  return { dir, store, teams };
}

test("agent config 迁移应用戳随 saveAll 追加落盘，普通回写不产生 sidecar", async () => {
  const { dir, store, teams } = makeStore();
  try {
    await store.saveAll("default", teams);
    assert.equal(existsSync(path.join(dir, ".migrations.json")), false);

    await store.saveAll("default", teams, [{ id: "strip_stock_default_llm_tier", applied_at: "2026-08-31T06:00:00.000Z" }]);
    const first = JSON.parse(readFileSync(path.join(dir, ".migrations.json"), "utf8"));
    assert.equal(first.length, 1);
    assert.equal(first[0].id, "strip_stock_default_llm_tier");

    await store.saveAll("default", teams, [{ id: "strip_dangling_delegation_refs", applied_at: "2026-08-31T07:00:00.000Z" }]);
    const second = JSON.parse(readFileSync(path.join(dir, ".migrations.json"), "utf8"));
    assert.deepEqual(second.map((item) => item.id), ["strip_stock_default_llm_tier", "strip_dangling_delegation_refs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("已损坏的应用戳文件被重建而非让回写失败", async () => {
  const { dir, store, teams } = makeStore();
  try {
    writeFileSync(path.join(dir, ".migrations.json"), "{ not valid json", "utf8");
    await store.saveAll("default", teams, [{ id: "strip_stock_default_llm_tier", applied_at: "2026-08-31T06:00:00.000Z" }]);
    const entries = JSON.parse(readFileSync(path.join(dir, ".migrations.json"), "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "strip_stock_default_llm_tier");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
