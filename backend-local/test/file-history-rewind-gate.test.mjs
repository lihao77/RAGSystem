import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileHistoryService } from "../dist/adapters/local/files/file-history-service.js";

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-history-rewind-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

test("rewind keeps pending edits tracked before the anchor (stopped-run rollback incident)", () => {
  // 事故复刻（session 16036930）：completed run 提交快照 @100；被停止的 run 编辑文件（tracked_seq=150，
  // 无快照边界）；用户对更晚的消息（锚点 200）做编辑重发——文件必须原样保留，pending 留守。
  const ws = createWorkspace();
  try {
    const file = path.join(ws.root, "geomap_data.py");
    fs.writeFileSync(file, "original\n", "utf8");
    let seq = 0;
    const service = new FileHistoryService({ dataRoot: ws.root, maxSeqProvider: () => seq });

    service.trackEdit("session-1", file);
    fs.writeFileSync(file, "v1-completed-run\n", "utf8");
    seq = 100;
    assert.ok(service.makeSnapshot("session-1", 100));

    seq = 150;
    service.trackEdit("session-1", file);
    fs.writeFileSync(file, "v2-stopped-run\n", "utf8");

    const unrelated = service.rewind("session-1", 200);
    assert.equal(unrelated.reverted_files, 0);
    assert.equal(fs.readFileSync(file, "utf8"), "v2-stopped-run\n");

    // 留守的 pending 仍可被更早锚点回退（回到停止 run 之前）
    const earlier = service.rewind("session-1", 120);
    assert.equal(earlier.reverted_files, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "v1-completed-run\n");
  } finally {
    ws.cleanup();
  }
});

test("rewind reverts pending edits tracked at exactly the anchor seq (retry of the anchor's own run)", () => {
  // 锚点用户消息是编辑时刻的最大 seq（其 run 刚启动就动了文件）——重试该消息必须撤销这些编辑。
  const ws = createWorkspace();
  try {
    const file = path.join(ws.root, "plot_map.py");
    fs.writeFileSync(file, "before\n", "utf8");
    const service = new FileHistoryService({ dataRoot: ws.root, maxSeqProvider: () => 100 });

    service.trackEdit("session-1", file);
    fs.writeFileSync(file, "after\n", "utf8");

    const result = service.rewind("session-1", 100);
    assert.equal(result.reverted_files, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "before\n");
  } finally {
    ws.cleanup();
  }
});

test("trackEdit stamps tracked_seq; consumed pending entries are cleared so re-edits re-track cleanly", () => {
  const ws = createWorkspace();
  try {
    const file = path.join(ws.root, "geomap_render.py");
    fs.writeFileSync(file, "a\n", "utf8");
    let seq = 7;
    const service = new FileHistoryService({ dataRoot: ws.root, maxSeqProvider: () => seq });

    service.trackEdit("session-1", file);
    assert.equal(service.getPendingTracked("session-1")[path.resolve(file)].tracked_seq, 7);
    fs.writeFileSync(file, "b\n", "utf8");

    service.rewind("session-1", 7);
    assert.equal(fs.readFileSync(file, "utf8"), "a\n");
    assert.equal(service.getPendingTracked("session-1"), null);

    // 旧条目被消费后重新追踪：备份基于当前内容、tracked_seq 取新值，可被后续锚点正常回退
    seq = 9;
    service.trackEdit("session-1", file);
    fs.writeFileSync(file, "c\n", "utf8");
    assert.equal(service.getPendingTracked("session-1")[path.resolve(file)].tracked_seq, 9);
    const again = service.rewind("session-1", 8);
    assert.equal(again.reverted_files, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "a\n");
  } finally {
    ws.cleanup();
  }
});

test("legacy pending entries without tracked_seq are never flushed by rewind and survive to the next snapshot", () => {
  // 历史形状夹具：升级前的 pending.json 无 tracked_seq。回退不得冲刷（宁可漏回退不可错回退），
  // 条目保留并归档进下个快照，此后按快照 seq 正常参与回退。
  const ws = createWorkspace();
  try {
    const sessionRoot = path.join(ws.root, "file-history", "session-legacy");
    fs.mkdirSync(path.join(sessionRoot, "backups"), { recursive: true });
    const file = path.join(ws.root, "legacy.py");
    fs.writeFileSync(file, "edited-by-stopped-run\n", "utf8");
    fs.writeFileSync(path.join(sessionRoot, "backups", sha256("original\n")), "original\n", "utf8");
    fs.writeFileSync(
      path.join(sessionRoot, "pending.json"),
      JSON.stringify({
        [path.resolve(file)]: { backup_hash: sha256("original\n"), action: "modified" },
      }, null, 2),
      "utf8",
    );

    const service = new FileHistoryService({ dataRoot: ws.root, maxSeqProvider: () => 999 });
    const skipped = service.rewind("session-legacy", 999);
    assert.equal(skipped.reverted_files, 0);
    assert.equal(fs.readFileSync(file, "utf8"), "edited-by-stopped-run\n");

    assert.ok(service.makeSnapshot("session-legacy", 1000));
    fs.writeFileSync(file, "newer\n", "utf8");
    const reverted = service.rewind("session-legacy", 500);
    assert.equal(reverted.reverted_files, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "original\n");
  } finally {
    ws.cleanup();
  }
});
