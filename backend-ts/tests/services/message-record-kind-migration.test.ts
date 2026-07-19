import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { BASELINE_SCHEMA_SQL } from "../../src/adapters/local/sqlite/conversation-store/schema.js";
import { MIGRATIONS } from "../../src/adapters/local/sqlite/conversation-store/migrations.js";

// node:sqlite 是实验性内置,vite 不识别其 ESM import,改用 require(与 src/shared/db.ts 一致)。
const requireModule = createRequire(import.meta.url);
const sqlite = requireModule("node:sqlite") as typeof import("node:sqlite");
type Db = InstanceType<typeof sqlite.DatabaseSync>;

const v4 = MIGRATIONS.find((m) => m.version === 4)!;

function metadataOf(db: Db, id: string): Record<string, unknown> {
  const row = db.prepare("SELECT metadata FROM messages WHERE id = ?").get(id) as { metadata: string };
  return JSON.parse(row.metadata);
}

function insertMessage(db: Db, id: string, metadata: Record<string, unknown> | null): void {
  db.prepare("INSERT INTO messages(id, session_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)").run(
    id,
    "s1",
    "user",
    "x",
    metadata === null ? null : JSON.stringify(metadata),
  );
}

describe("migration v4 message_record_kind_unify", () => {
  it("把散落的 metadata.type / metadata.compression 回填到 msg_type 并清除老字段", () => {
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(BASELINE_SCHEMA_SQL);
    db.prepare("INSERT INTO sessions(session_id) VALUES (?)").run("s1");

    insertMessage(db, "m1", { type: "command_result", command: "help", success: true });
    insertMessage(db, "m2", { type: "command", command: "help", command_mode: "system" });
    insertMessage(db, "m3", { compression: true, replaces_up_to_seq: 2 });
    insertMessage(db, "m4", { msg_type: "context_compression_summary", replaces_up_to_seq: 5 });
    insertMessage(db, "m5", { msg_type: "intent" });

    v4.up(db);

    expect(metadataOf(db, "m1")).toEqual({ msg_type: "command_result", command: "help", success: true });
    expect(metadataOf(db, "m2")).toEqual({ msg_type: "command", command: "help", command_mode: "system" });
    expect(metadataOf(db, "m3")).toEqual({ msg_type: "context_compression_summary", replaces_up_to_seq: 2 });
    expect(metadataOf(db, "m4")).toEqual({ msg_type: "context_compression_summary", replaces_up_to_seq: 5 });
    expect(metadataOf(db, "m5")).toEqual({ msg_type: "intent" });
  });

  it("对无类型字段的普通消息是 no-op", () => {
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(BASELINE_SCHEMA_SQL);
    db.prepare("INSERT INTO sessions(session_id) VALUES (?)").run("s1");
    insertMessage(db, "m1", { msg_type: "observation" });
    insertMessage(db, "m2", {});

    expect(() => v4.up(db)).not.toThrow();
    expect(metadataOf(db, "m1")).toEqual({ msg_type: "observation" });
    expect(metadataOf(db, "m2")).toEqual({});
  });

  it("NULL metadata 行不报错", () => {
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(BASELINE_SCHEMA_SQL);
    db.prepare("INSERT INTO sessions(session_id) VALUES (?)").run("s1");
    insertMessage(db, "m1", null);

    expect(() => v4.up(db)).not.toThrow();
    const row = db.prepare("SELECT metadata FROM messages WHERE id = ?").get("m1") as { metadata: string | null };
    expect(row.metadata).toBeNull();
  });
});
