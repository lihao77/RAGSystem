import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IFileHistoryStore } from "../../src/contracts/file-history-store/index.js";
import { FileHistoryService } from "../../src/services/stores/file-history-service.js";

/**
 * file-history-store 契约测试样本（路线图④替换验证雏形）。
 *
 * 与 conversation-store / memory-store / file-index-store 契约测试同理：只依赖 IFileHistoryStore
 * 窄接口，把 FileHistoryService 实例赋给接口类型再调用，证明实现服从契约。换实现（如换 DB 后端）
 * 注入同一组测试都应通过——可替换的可执行证明。
 *
 * 重点验证深合约：trackEdit 幂等备份、makeSnapshot 关联 seq、rewind modified 恢复/created 删除、
 * 非法输入返回 null/失败（非抛异常）。
 */

let dataRoot: string;
let workDir: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `filehist-contract-${randomUUID()}-`));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), `filehist-work-${randomUUID()}-`));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

const build = (): IFileHistoryStore => new FileHistoryService({ dataRoot });

describe("IFileHistoryStore 契约", () => {
  it("trackEdit + makeSnapshot + rewind 闭环：modified 文件恢复原始内容", () => {
    const store = build();
    const filePath = path.join(workDir, "a.txt");
    fs.writeFileSync(filePath, "original");

    store.trackEdit("s1", filePath); // 备份 original
    fs.writeFileSync(filePath, "changed"); // 模拟 agent 编辑
    const snapshotId = store.makeSnapshot("s1", 10);
    expect(snapshotId).not.toBeNull();
    expect(store.hasSnapshots("s1")).toBe(true);

    expect(fs.readFileSync(filePath, "utf8")).toBe("changed");
    const result = store.rewind("s1", 5); // seq 5 < 10 → 回退
    expect(result.success).toBe(true);
    expect(result.reverted_files).toBe(1);
    expect(fs.readFileSync(filePath, "utf8")).toBe("original");
  });

  it("trackEdit 幂等：同文件重复 trackEdit 仅首次备份（恢复到首次内容）", () => {
    const store = build();
    const filePath = path.join(workDir, "b.txt");
    fs.writeFileSync(filePath, "v1");
    store.trackEdit("s2", filePath);
    store.trackEdit("s2", filePath); // 重复，无副作用
    fs.writeFileSync(filePath, "v2");
    store.makeSnapshot("s2", 1);
    store.rewind("s2", 0);
    expect(fs.readFileSync(filePath, "utf8")).toBe("v1");
  });

  it("trackEdit created 文件：rewind 删除（无备份）", () => {
    const store = build();
    const filePath = path.join(workDir, "new.txt");
    expect(fs.existsSync(filePath)).toBe(false);
    store.trackEdit("s3", filePath); // 文件不存在 → created（无备份）
    fs.writeFileSync(filePath, "created content");
    store.makeSnapshot("s3", 1);
    expect(fs.existsSync(filePath)).toBe(true);
    store.rewind("s3", 0);
    expect(fs.existsSync(filePath)).toBe(false); // created 文件被删除
  });

  it("makeSnapshot 无 tracked 返回 null", () => {
    const store = build();
    expect(store.makeSnapshot("s4", 1)).toBeNull();
  });

  it("makeSnapshot 非法 session/seq 返回 null（深合约：非抛异常）", () => {
    const store = build();
    expect(store.makeSnapshot(null, 1)).toBeNull();
    expect(store.makeSnapshot("s5", 1.5)).toBeNull();
  });

  it("rewind 无快照无 pending 返回 success:true（无可回退内容，非失败）", () => {
    const store = build();
    const result = store.rewind("s6", 10);
    expect(result.success).toBe(true);
    expect(result.reverted_files).toBe(0);
  });

  it("listSnapshots / hasSnapshots 非法 session 返回空/false", () => {
    const store = build();
    expect(store.hasSnapshots(null)).toBe(false);
    expect(store.listSnapshots(null)).toEqual([]);
  });

  it("cleanup 删除 session 的快照与备份", () => {
    const store = build();
    const filePath = path.join(workDir, "c.txt");
    fs.writeFileSync(filePath, "x");
    store.trackEdit("s7", filePath);
    store.makeSnapshot("s7", 1);
    expect(store.hasSnapshots("s7")).toBe(true);
    store.cleanup("s7");
    expect(store.hasSnapshots("s7")).toBe(false);
  });

  it("多 snapshot rewind：按 message_seq 升序还原，恢复每个文件最早的备份", () => {
    const store = build();
    const filePath = path.join(workDir, "multi.txt");
    fs.writeFileSync(filePath, "v0");

    store.trackEdit("s8", filePath); // 备份 v0
    fs.writeFileSync(filePath, "v1");
    store.makeSnapshot("s8", 1);

    store.trackEdit("s8", filePath); // 备份 v1
    fs.writeFileSync(filePath, "v2");
    store.makeSnapshot("s8", 2);

    expect(fs.readFileSync(filePath, "utf8")).toBe("v2");
    // rewind targetSeq=0：回退所有 seq>0 快照，restoreMap 取最早备份（v0），最终回到 v0
    const result = store.rewind("s8", 0);
    expect(result.success).toBe(true);
    expect(result.reverted_files).toBe(1); // 同文件去重为 1
    expect(fs.readFileSync(filePath, "utf8")).toBe("v0");
  });
});
