import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IFileIndexStore } from "../../src/contracts/file-index-store/index.js";
import { FileIndexService } from "../../src/services/stores/file-index-service.js";

/**
 * file-index-store 契约测试(session-only:知识库文件已独立到 driver kb_files,
 * uploaded_files 只留会话附件 session scope)。
 *
 * 只依赖 IFileIndexStore 窄接口,注入 FileIndexService 证明服从契约。
 * 重点验证 add 收编:物理 blob 落盘 + 元数据登记原子同在。
 */

let dataRoot: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `fileidx-contract-${randomUUID()}-`));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const build = (): IFileIndexStore => new FileIndexService({ dbPath: ":memory:", dataRoot });

const encoder = new TextEncoder();

const SESSION_ID = "s1";

const addSession = (store: IFileIndexStore, name: string, content: string) =>
  store.add({
    originalName: name,
    buffer: encoder.encode(content),
    mime: "text/plain",
    scopeType: "session",
    scopeId: SESSION_ID,
  });

describe("IFileIndexStore 契约", () => {
  it("add 收编:物理 blob 落盘 + 元数据可 get 回(原子同在)", () => {
    const store = build();
    const record = addSession(store, "note.txt", "hello");

    const got = store.get(record.id, "session", SESSION_ID);
    expect(got).not.toBeNull();
    expect(got?.original_name).toBe("note.txt");
    expect(got?.size).toBe(5);
    // 物理 blob 落盘(收编后由 store.add 内部写入,非 route 层裸 fs)
    expect(fs.existsSync(record.stored_path)).toBe(true);
    expect(fs.readFileSync(record.stored_path, "utf8")).toBe("hello");
    // 落在 session uploads root 内(store 按 scope 决定根目录)
    expect(record.stored_path.startsWith(store.getSessionUploadsRoot(SESSION_ID))).toBe(true);
  });

  it("get 不存在返回 null(深合约:非抛异常)", () => {
    const store = build();
    expect(store.get("missing", "session", SESSION_ID)).toBeNull();
  });

  it("list 按 uploaded_at 降序", () => {
    const store = build();
    addSession(store, "first.txt", "1");
    addSession(store, "second.txt", "2");
    const files = store.list({ scopeType: "session", scopeId: SESSION_ID });
    expect(files).toHaveLength(2);
    expect(files[0].uploaded_at >= files[1].uploaded_at).toBe(true);
  });

  it("list extensions 过滤(并集)", () => {
    const store = build();
    addSession(store, "a.txt", "1");
    store.add({
      originalName: "b.json",
      buffer: encoder.encode("2"),
      mime: "application/json",
      scopeType: "session",
      scopeId: SESSION_ID,
    });
    const txt = store.list({ scopeType: "session", scopeId: SESSION_ID, extensions: [".txt"] });
    expect(txt).toHaveLength(1);
    expect(txt[0].original_name).toBe("a.txt");
  });

  it("delete 存在返回 record 并清元数据;不存在返回 null", () => {
    const store = build();
    const record = addSession(store, "d.txt", "d");
    const deleted = store.delete(record.id, "session", SESSION_ID);
    expect(deleted).not.toBeNull();
    expect(deleted?.id).toBe(record.id);
    expect(store.get(record.id, "session", SESSION_ID)).toBeNull();
    expect(store.delete(record.id, "session", SESSION_ID)).toBeNull();
  });
});

describe("输入边界 zod 契约", () => {
  it("add 非法 scopeType 抛错(深合约前置条件)", () => {
    const store = build();
    expect(() =>
      store.add({
        originalName: "x.txt",
        buffer: encoder.encode("x"),
        mime: "text/plain",
        scopeType: "invalid" as "session",
        scopeId: SESSION_ID,
      }),
    ).toThrow();
  });

  it("add session scope 缺 scopeId 抛错(深合约前置条件,防 sessions//uploads 路径退化)", () => {
    const store = build();
    expect(() =>
      store.add({
        originalName: "x.txt",
        buffer: encoder.encode("x"),
        mime: "text/plain",
        scopeType: "session",
        scopeId: null,
      }),
    ).toThrow();
  });

  it("add 非 Uint8Array buffer 抛错", () => {
    const store = build();
    expect(() =>
      store.add({
        originalName: "x.txt",
        buffer: "not-bytes" as unknown as Uint8Array,
        mime: "text/plain",
        scopeType: "session",
        scopeId: SESSION_ID,
      }),
    ).toThrow();
  });
});
