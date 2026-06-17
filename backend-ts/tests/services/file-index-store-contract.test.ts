import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IFileIndexStore } from "../../src/contracts/file-index-store/index.js";
import { FileIndexService } from "../../src/services/stores/file-index-service.js";

/**
 * file-index-store 契约测试样本（路线图④替换验证雏形）。
 *
 * 与 conversation-store / memory-store 契约测试同理：只依赖 IFileIndexStore 窄接口，把
 * FileIndexService 实例赋给接口类型再调用，证明实现服从契约。换实现（如换 ORM/对象存储后端）
 * 注入同一组测试都应通过——可替换的可执行证明。
 *
 * 重点验证 add 收编：物理 blob 落盘 + 元数据登记在同一 store 方法内完成（原子同在），
 * 消除原 route 层裸 fs.writeFile 与元数据非原子的漏网。
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

const addGlobal = (store: IFileIndexStore, name: string, content: string) =>
  store.add({
    originalName: name,
    buffer: encoder.encode(content),
    mime: "text/plain",
    scopeType: "global",
    scopeId: null,
  });

describe("IFileIndexStore 契约", () => {
  it("add 收编：物理 blob 落盘 + 元数据可 get 回（原子同在）", () => {
    const store = build();
    const record = addGlobal(store, "note.txt", "hello");

    const got = store.get(record.id, "global", null);
    expect(got).not.toBeNull();
    expect(got?.original_name).toBe("note.txt");
    expect(got?.size).toBe(5);
    // 物理 blob 落盘（收编后由 store.add 内部写入，非 route 层裸 fs）
    expect(fs.existsSync(record.stored_path)).toBe(true);
    expect(fs.readFileSync(record.stored_path, "utf8")).toBe("hello");
    // 落在 global uploads root 内（store 按 scope 决定根目录）
    expect(record.stored_path.startsWith(store.getGlobalUploadsRoot())).toBe(true);
  });

  it("add session scope 落在 session uploads root", () => {
    const store = build();
    const record = store.add({
      originalName: "a.txt",
      buffer: encoder.encode("x"),
      mime: "text/plain",
      scopeType: "session",
      scopeId: "s1",
    });
    expect(record.stored_path.startsWith(store.getSessionUploadsRoot("s1"))).toBe(true);
  });

  it("get 不存在返回 null（深合约：非抛异常）", () => {
    const store = build();
    expect(store.get("missing", "global", null)).toBeNull();
  });

  it("list 按 uploaded_at 降序", () => {
    const store = build();
    addGlobal(store, "first.txt", "1");
    addGlobal(store, "second.txt", "2");
    const files = store.list({ scopeType: "global", scopeId: null });
    expect(files).toHaveLength(2);
    expect(files[0].uploaded_at >= files[1].uploaded_at).toBe(true);
  });

  it("list extensions 过滤（并集）", () => {
    const store = build();
    addGlobal(store, "a.txt", "1");
    store.add({
      originalName: "b.json",
      buffer: encoder.encode("2"),
      mime: "application/json",
      scopeType: "global",
      scopeId: null,
    });
    const txt = store.list({ scopeType: "global", scopeId: null, extensions: [".txt"] });
    expect(txt).toHaveLength(1);
    expect(txt[0].original_name).toBe("a.txt");
  });

  it("delete 存在返回 record 并清元数据；不存在返回 null", () => {
    const store = build();
    const record = addGlobal(store, "d.txt", "d");
    const deleted = store.delete(record.id, "global", null);
    expect(deleted).not.toBeNull();
    expect(deleted?.id).toBe(record.id);
    expect(store.get(record.id, "global", null)).toBeNull();
    expect(store.delete(record.id, "global", null)).toBeNull();
  });
});

describe("输入边界 zod 契约", () => {
  it("add 非法 scopeType 抛错（深合约前置条件）", () => {
    const store = build();
    expect(() =>
      store.add({
        originalName: "x.txt",
        buffer: encoder.encode("x"),
        mime: "text/plain",
        scopeType: "invalid" as "global",
        scopeId: null,
      }),
    ).toThrow();
  });

  it("add session scope 缺 scopeId 抛错（深合约前置条件，防 sessions//uploads 路径退化）", () => {
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
        scopeType: "global",
        scopeId: null,
      }),
    ).toThrow();
  });
});
