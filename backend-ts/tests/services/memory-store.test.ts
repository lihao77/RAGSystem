import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getWorkspaceMemoryKey, MemoryStore } from "../../src/services/memory-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("MemoryStore", () => {
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
    expect(store.readEntryFile({ scope: "session", session_id: "s1" }, "MEMORY.md")).toBeNull();
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
