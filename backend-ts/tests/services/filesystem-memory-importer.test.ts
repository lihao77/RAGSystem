import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PostgresMemoryImporter,
  type PostgresMemoryExecutor,
  type PostgresQueryResult,
} from "../../src/adapters/saas/postgres/index.js";
import { scanFilesystemMemory } from "../../src/services/memory-import/filesystem-memory-scanner.js";
import { makeTempRoot } from "../helpers/temp-db.js";

describe("filesystem Memory importer", () => {
  it("scans all canonical scopes from an explicit dataRoot", () => {
    const root = makeTempRoot();
    writeEntry(root, "teams/alpha/fact_team.md", { type: "team", name: "Team" });
    writeEntry(root, "sessions/session-1/fact_session.md", { type: "session", name: "Session" });
    writeEntry(root, "teams/alpha/agents/assistant/fact_agent.md", { type: "agent", name: "Agent" });
    writeEntry(root, "users/usr_alpha/fact_user.md", { type: "user", name: "User" });
    writeEntry(root, "users/usr_alpha/workspaces/work-1/fact_workspace.md", {
      type: "workspace",
      name: "Workspace",
    });
    fs.writeFileSync(path.join(root, "memory", "teams", "alpha", "MEMORY.md"), "# derived\n", "utf8");

    const result = scanFilesystemMemory(root, "tnt_alpha");

    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(5);
    expect(result.entries.map((entry) => [entry.scope, entry.scope_id])).toEqual(expect.arrayContaining([
      ["session", "session-1"],
      ["team", "alpha"],
      ["agent", JSON.stringify(["alpha", "assistant"])],
      ["user", "usr_alpha"],
      ["workspace", JSON.stringify(["usr_alpha", "work-1"])],
    ]));
    expect(result.excluded).toMatchObject({ derived_indexes: 1, sqlite_candidates: true });
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(5);
  });

  it("preserves metadata and separates generated Why/How sections", () => {
    const root = makeTempRoot();
    writeEntry(root, "sessions/session-1/preference_editor.md", {
      type: "session",
      name: "Editor",
      status: "archived",
      source_run_id: "run-1",
      source_message_id: "msg-1",
      body: "Use Vim.\n\n**Why:** User preference.\n**How to apply:** Use it for edits.",
    });

    const first = scanFilesystemMemory(root, "tnt_alpha").entries[0]!;
    const movedRoot = makeTempRoot();
    fs.cpSync(path.join(root, "memory"), path.join(movedRoot, "memory"), { recursive: true });
    const moved = scanFilesystemMemory(movedRoot, "tnt_alpha").entries[0]!;

    expect(first).toMatchObject({
      content: "Use Vim.",
      why: "User preference.",
      how_to_apply: "Use it for edits.",
      status: "archived",
      source_run_id: "run-1",
      source_message_id: "msg-1",
    });
    expect(first.id).toBe(moved.id);
    expect(first.semantic_checksum).toBe(moved.semantic_checksum);
  });

  it("reports malformed entries instead of partially interpreting them", () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "memory", "sessions", "session-1", "broken.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not frontmatter", "utf8");

    const result = scanFilesystemMemory(root, "tnt_alpha");

    expect(result.entries).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({
      source_relative_path: "sessions/session-1/broken.md",
      message: expect.stringContaining("frontmatter"),
    })]);
  });

  it("imports transactionally and treats an identical rerun as idempotent", async () => {
    const root = makeTempRoot();
    writeEntry(root, "sessions/session-1/fact_alpha.md", { type: "session", name: "Alpha" });
    const scan = scanFilesystemMemory(root, "tnt_alpha");
    const executor = new InMemoryImportExecutor();
    const importer = new PostgresMemoryImporter(executor);

    const first = await importer.importEntries("tnt_alpha", scan.entries);
    const second = await importer.importEntries("tnt_alpha", scan.entries);

    expect(first).toMatchObject({ imported: 1, verified: 1, affected_scopes: 1 });
    expect(second).toMatchObject({ imported: 0, skipped_identical: 1, verified: 1, affected_scopes: 0 });
    expect(executor.revisions.get("tnt_alpha:session:session-1")).toBe(1);
  });

  it("fails closed on changed deterministic source identity unless skip is explicit", async () => {
    const root = makeTempRoot();
    writeEntry(root, "sessions/session-1/fact_alpha.md", { type: "session", name: "Alpha" });
    const executor = new InMemoryImportExecutor();
    const importer = new PostgresMemoryImporter(executor);
    const original = scanFilesystemMemory(root, "tnt_alpha").entries;
    await importer.importEntries("tnt_alpha", original);
    const changed = original.map((entry) => ({ ...entry, content: "changed" }));

    await expect(importer.importEntries("tnt_alpha", changed)).rejects.toThrow("conflict");
    await expect(importer.importEntries("tnt_alpha", changed, "skip")).resolves.toMatchObject({
      skipped_conflicts: 1,
      imported: 0,
    });
  });
});

function writeEntry(
  root: string,
  relativePath: string,
  options: {
    type: string;
    name: string;
    status?: string;
    source_run_id?: string;
    source_message_id?: string;
    body?: string;
  },
): void {
  const filePath = path.join(root, "memory", ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    "---",
    `name: ${options.name}`,
    "description: imported description",
    `type: ${options.type}`,
    "memory_type: fact",
    `status: ${options.status ?? "active"}`,
    "created_at: 2026-01-01T00:00:00Z",
    "updated_at: 2026-01-02T00:00:00Z",
    `source_run_id: ${options.source_run_id ?? ""}`,
    `source_message_id: ${options.source_message_id ?? ""}`,
    "---",
    "",
    options.body ?? "Imported content.",
    "",
  ].join("\n"), "utf8");
}

class InMemoryImportExecutor implements PostgresMemoryExecutor {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly revisions = new Map<string, number>();

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes("INSERT INTO memory_entries")) {
      const id = String(params[0]);
      if (this.rows.has(id)) return { rows: [] };
      const row = rowFromParams(params);
      this.rows.set(id, row);
      return { rows: [{ id } as unknown as Row] };
    }
    if (sql.includes("SELECT * FROM memory_entries") && Array.isArray(params[1])) {
      const ids = params[1] as string[];
      return { rows: ids.flatMap((id) => {
        const row = this.rows.get(id);
        return row ? [row as Row] : [];
      }) };
    }
    if (sql.includes("SELECT * FROM memory_entries")) {
      const row = this.rows.get(String(params[1]));
      return { rows: row ? [row as Row] : [] };
    }
    if (sql.includes("INSERT INTO memory_scope_revisions")) {
      const key = `${String(params[0])}:${String(params[1])}:${String(params[2])}`;
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      return { rows: [] };
    }
    return { rows: [] };
  }

  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function rowFromParams(params: readonly unknown[]): Record<string, unknown> {
  const keys = [
    "id", "tenant_id", "scope", "scope_id", "name", "description", "memory_type", "content",
    "why", "how_to_apply", "status", "source_run_id", "source_message_id", "version",
    "created_at", "updated_at", "archived_at",
  ];
  return Object.fromEntries(keys.map((key, index) => [key, params[index]]));
}
