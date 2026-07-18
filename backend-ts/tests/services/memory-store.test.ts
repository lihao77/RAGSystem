import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getWorkspaceMemoryKey, MemoryStore } from "../../src/services/stores/memory-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("MemoryStore", () => {
  it("copies legacy workspace memory into each user's isolated workspace on first access", () => {
    const dataRoot = makeTempDataRoot();
    const legacyRoot = path.join(dataRoot, "memory", "workspaces", "demo");
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "MEMORY.md"), "# Legacy Workspace\n", "utf8");
    fs.writeFileSync(path.join(legacyRoot, "fact_old.md"), "legacy body", "utf8");
    const store = new MemoryStore({ dataRoot });

    expect(store.loadIndexHead({ scope: "workspace", workspace_key: "demo", user_id: "usr_alice" }))
      .toBe("# Legacy Workspace");
    expect(fs.readFileSync(path.join(dataRoot, "memory", "users", "usr_alice", "workspaces", "demo", "fact_old.md"), "utf8"))
      .toBe("legacy body");
    expect(fs.existsSync(path.join(legacyRoot, "fact_old.md"))).toBe(true);
  });

  it("restores the shared scope when publish state commit fails", async () => {
    const dataRoot = makeTempDataRoot();
    const store = new MemoryStore({ dataRoot });
    const scope = { scope: "team" as const, team_name: "default" };
    await store.saveMemory({ ...scope, name: "Existing", description: "existing", memory_type: "fact", content: "old" });
    const before = store.loadIndexHead(scope);

    await expect(store.saveMemoryWithCommit(
      { ...scope, name: "Candidate", description: "candidate", memory_type: "fact", content: "new" },
      () => false,
    )).rejects.toThrow("memory publish state changed before commit");
    expect(store.loadIndexHead(scope)).toBe(before);
    expect(fs.existsSync(path.join(dataRoot, "memory", "teams", "default", "fact_Candidate.md"))).toBe(false);
  });

  it("rejects path traversal in every scope identity segment", () => {
    const store = new MemoryStore({ dataRoot: makeTempDataRoot() });
    expect(() => store.getScopeRoot({ scope: "team", team_name: "../../../tnt_other" })).toThrow("非法路径字符");
    expect(() => store.getScopeRoot({ scope: "agent", team_name: "default", agent_name: "../admin" })).toThrow("非法路径字符");
    expect(() => store.getScopeRoot({ scope: "session", session_id: "..\\outside" })).toThrow("非法路径字符");
    expect(() => store.getScopeRoot({ scope: "workspace", user_id: "usr_alice", workspace_key: "../outside" })).toThrow("非法路径字符");
  });
  it("logs non-ENOENT index read failures and returns an empty string", () => {
    const store = new MemoryStore({ dataRoot: makeTempDataRoot() });
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw error;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(store.loadIndexHead({ scope: "session", session_id: "s1" })).toBe("");
    expect(warnSpy).toHaveBeenCalledWith("[memory-store] loadIndexHead failed", {
      scope: "session",
      error,
    });
  });

  it("logs non-ENOENT entry read failures and returns null", () => {
    const dataRoot = makeTempDataRoot();
    const store = new MemoryStore({ dataRoot });
    const scopeRoot = path.join(dataRoot, "memory", "sessions", "s1");
    fs.mkdirSync(scopeRoot, { recursive: true });
    fs.writeFileSync(path.join(scopeRoot, "fact.md"), "body", "utf8");
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw error;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(store.readEntryFile({ scope: "session", session_id: "s1" }, "fact.md")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("[memory-store] readEntryFile failed", {
      scope: "session",
      fileName: "fact.md",
      error,
    });
  });

  it("reads Python-compatible MEMORY.md index heads from shared scopes", () => {
    const dataRoot = makeTempDataRoot();
    const store = new MemoryStore({ dataRoot });
    const indexPath = path.join(dataRoot, "memory", "teams", "alpha-team", "MEMORY.md");
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, "# Team Memory\n\n- [A](fact_a.md) - first\n- [B](fact_b.md) - second\n", "utf8");

    const content = store.loadIndexHead(
      {
        scope: "team",
        team_name: "alpha-team",
      },
      {
        maxLines: 1,
        maxChars: 100,
      },
    );

    expect(content).toBe("# Team Memory");
    expect(store.getIndexPath({ scope: "team", team_name: "alpha-team" })).toBe(indexPath);
  });

  it("reads memory entry files by basename only", () => {
    const dataRoot = makeTempDataRoot();
    const store = new MemoryStore({ dataRoot });
    const scopeRoot = path.join(dataRoot, "memory", "sessions", "s1");
    fs.mkdirSync(scopeRoot, { recursive: true });
    fs.writeFileSync(path.join(scopeRoot, "fact_alpha.md"), "---\nname: Alpha\n---\n\nbody\n", "utf8");

    const entry = store.readEntryFile(
      {
        scope: "session",
        session_id: "s1",
      },
      "../fact_alpha.md",
    );

    expect(entry).toMatchObject({
      scope: "session",
      file_name: "fact_alpha.md",
      file_path: path.join(scopeRoot, "fact_alpha.md"),
      content: expect.stringContaining("body"),
    });
    expect(store.readEntryFile({ scope: "session", session_id: "s1" }, "MEMORY.md")).toMatchObject({
      file_name: "MEMORY.md",
    });
  });

  it("writes Python-compatible memory markdown and rebuilds active index entries", async () => {
    const dataRoot = makeTempDataRoot();
    const store = new MemoryStore({ dataRoot });

    const saved = await store.saveMemory({
      scope: "session",
      session_id: "s1",
      name: "Alpha Preference",
      description: "prefer alpha",
      memory_type: "preference",
      content: "Use alpha by default.",
      why: "The user asked for it.",
      how_to_apply: "Apply on related tasks.",
      source_run_id: "run-1",
      source_message_id: "msg-1",
    });

    expect(saved).toMatchObject({
      scope: "session",
      file_name: "preference_Alpha-Preference.md",
      file_path: path.join(dataRoot, "memory", "sessions", "s1", "preference_Alpha-Preference.md"),
    });
    const entryText = fs.readFileSync(saved.file_path, "utf8");
    expect(entryText).toContain("name: Alpha Preference");
    expect(entryText).toContain("memory_type: preference");
    expect(entryText).toContain("status: active");
    expect(entryText).toContain("source_run_id: run-1");
    expect(entryText).toContain("**Why:** The user asked for it.");
    expect(entryText).toContain("**How to apply:** Apply on related tasks.");
    expect(store.loadIndexHead({ scope: "session", session_id: "s1" })).toContain(
      "- [Alpha Preference](preference_Alpha-Preference.md) - prefer alpha",
    );
  });

  it("archives memory by status flag and removes it from MEMORY.md", async () => {
    const dataRoot = makeTempDataRoot();
    const store = new MemoryStore({ dataRoot });
    const saved = await store.saveMemory({
      scope: "session",
      session_id: "s1",
      name: "Temporary Fact",
      description: "temporary",
      memory_type: "fact",
      content: "temporary fact",
    });

    expect(await store.archiveMemory({ scope: "session", session_id: "s1" }, saved.file_name)).toBe(true);
    expect(fs.readFileSync(saved.file_path, "utf8")).toContain("status: archived");
    expect(store.loadIndexHead({ scope: "session", session_id: "s1" })).toBe("# Session Memory\n\n暂无记忆。");
    expect(await store.archiveMemory({ scope: "session", session_id: "s1" }, saved.file_name)).toBe(false);
  });

  it("lists only visible managed scopes and resolves opaque ids for archive", async () => {
    const store = new MemoryStore({ dataRoot: makeTempDataRoot() });
    await Promise.all([
      store.saveMemory({ scope: "team", team_name: "alpha", name: "Shared", description: "team", memory_type: "fact", content: "shared" }),
      store.saveMemory({ scope: "user", user_id: "alice", name: "Mine", description: "personal", memory_type: "preference", content: "mine" }),
      store.saveMemory({ scope: "user", user_id: "bob", name: "Hidden", description: "other", memory_type: "fact", content: "hidden" }),
      store.saveMemory({ scope: "workspace", user_id: "alice", workspace_key: "demo", name: "Workspace", description: "project", memory_type: "goal", content: "workspace" }),
      store.saveMemory({ scope: "session", session_id: "owned-session", name: "Owned session", description: "owned", memory_type: "fact", content: "owned" }),
      store.saveMemory({ scope: "session", session_id: "other-session", name: "Hidden session", description: "other", memory_type: "fact", content: "hidden" }),
    ]);
    const options = {
      tenant_id: "tnt_local",
      viewer_user_id: "alice",
      viewer_session_ids: ["owned-session"],
      statuses: ["active" as const],
    };

    const entries = store.listManagedEntries(options);
    expect(entries.map((entry) => entry.name).sort()).toEqual(["Mine", "Owned session", "Shared", "Workspace"]);
    expect(entries.every((entry) => /^[0-9a-f-]{36}$/.test(entry.id))).toBe(true);
    expect(store.countManagedEntries({ ...options, search: "personal" })).toBe(1);

    const mine = entries.find((entry) => entry.name === "Mine");
    expect(mine).toBeDefined();
    const resolved = store.getManagedEntry({ ...options, memory_id: mine!.id });
    expect(resolved).toMatchObject({ memory: { name: "Mine", scope: "user" }, storage_key: expect.stringMatching(/\.md$/) });
    await expect(store.archiveManagedEntry({ ...options, memory_id: mine!.id, expected_version: mine!.version }))
      .resolves.toMatchObject({ outcome: "archived", memory: { status: "archived" } });
    expect(store.listManagedEntries(options).map((entry) => entry.name)).not.toContain("Mine");
    expect(store.listManagedEntries({ ...options, statuses: ["archived"] })).toEqual([
      expect.objectContaining({ name: "Mine", status: "archived" }),
    ]);
  });

  it("uses the same workspace memory key normalization as Python", () => {
    expect(getWorkspaceMemoryKey("E:/Python/RAGSystem/workspaces/demo workspace")).toBe(
      "E-Python-RAGSystem-workspaces-demo-workspace",
    );
    expect(getWorkspaceMemoryKey("")).toBeNull();
  });
});

function makeTempDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-memory-store-"));
  tempRoots.push(root);
  return root;
}
