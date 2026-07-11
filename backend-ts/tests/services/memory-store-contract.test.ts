import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IMemoryStore, MemoryScopeSpec, SaveMemoryInput } from "../../src/contracts/memory-store/index.js";
import { SaveMemoryInputSchema } from "../../src/contracts/memory-store/types.js";
import { MemoryStore } from "../../src/services/stores/memory-store.js";

/**
 * memory-store 契约测试样本（路线图④替换验证雏形）。
 *
 * 与 conversation-store 契约测试同理：只依赖 IMemoryStore 窄接口，把 MemoryStore 实例
 * 赋给接口类型再调用，证明实现服从契约。换实现（如将来换 KV/DB 后端）注入同一组测试
 * 都应通过——可替换的可执行证明。
 *
 * 深合约：readEntryFile/archiveMemory 不存在返回 null/false、loadIndexHead 缺索引返回空串、
 * saveMemory 幂等覆盖 + 重建索引、listEntries 按 updated_at 降序且默认仅 active、输入边界 zod。
 */

let dataRoot: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `mem-contract-${randomUUID()}-`));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const build = (): IMemoryStore => new MemoryStore({ dataRoot });

const sessionScope = (sessionId: string): MemoryScopeSpec => ({ scope: "session", session_id: sessionId });

const baseSave = (sessionId: string, name: string): SaveMemoryInput => ({
  scope: "session",
  session_id: sessionId,
  name,
  description: "d",
  memory_type: "fact",
  content: "body",
});

describe("IMemoryStore 契约", () => {
  it("saveMemory 写入，同名再次写入幂等（文件名稳定）", () => {
    const store = build();
    const first = store.saveMemory(baseSave("s1", "m1"));
    const second = store.saveMemory(baseSave("s1", "m1"));
    expect(second.file_name).toBe(first.file_name);
    expect(second.scope).toBe("session");
  });

  it("saveMemory 覆盖保持原始 created_at（幂等）", () => {
    const store = build();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      store.saveMemory(baseSave("s1", "m1"));
      const firstEntry = store.listEntries(sessionScope("s1"))[0]!;

      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
      store.saveMemory({ ...baseSave("s1", "m1"), content: "updated body" });
      const secondEntry = store.listEntries(sessionScope("s1"))[0]!;

      expect(secondEntry.created_at).toBe(firstEntry.created_at);
      expect(secondEntry.updated_at).toBe("2026-01-01T00:01:00Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("readEntryFile 不存在返回 null（深合约：非抛异常）", () => {
    const store = build();
    expect(store.readEntryFile(sessionScope("s1"), "missing.md")).toBeNull();
  });

  it("loadIndexHead 首次调用 ensureScope 建默认索引，返回非空标题", () => {
    const store = build();
    const head = store.loadIndexHead(sessionScope("s1"));
    expect(head).toContain("Memory");
    expect(head.length).toBeGreaterThan(0);
  });

  it("saveMemory 后 loadIndexHead 含条目，readEntryFile 可读回", () => {
    const store = build();
    const saved = store.saveMemory(baseSave("s1", "m1"));
    const index = store.loadIndexHead(sessionScope("s1"));
    expect(index).toContain("m1");
    const entry = store.readEntryFile(sessionScope("s1"), saved.file_name);
    expect(entry).not.toBeNull();
    expect(entry?.content).toContain("body");
  });

  it("listEntries 按 updated_at 降序（字典序即时间序）", () => {
    const store = build();
    store.saveMemory(baseSave("s1", "first"));
    store.saveMemory(baseSave("s1", "second"));
    const entries = store.listEntries(sessionScope("s1"));
    expect(entries).toHaveLength(2);
    expect(entries[0]!.updated_at >= entries[1]!.updated_at).toBe(true);
  });

  it("archiveMemory 不存在返回 false", () => {
    const store = build();
    expect(store.archiveMemory(sessionScope("s1"), "missing.md")).toBe(false);
  });

  it("archiveMemory 后默认 listEntries 仅 active；includeArchived 含已归档", () => {
    const store = build();
    store.saveMemory(baseSave("s1", "m1"));
    const entries = store.listEntries(sessionScope("s1"));
    expect(entries).toHaveLength(1);
    expect(store.archiveMemory(sessionScope("s1"), entries[0]!.file_name)).toBe(true);
    expect(store.listEntries(sessionScope("s1"))).toHaveLength(0);
    expect(store.listEntries(sessionScope("s1"), { includeArchived: true })).toHaveLength(1);
  });

  it("saveMemory 非白名单 memory_type 抛错（深合约前置条件）", () => {
    const store = build();
    expect(() => store.saveMemory({ ...baseSave("s1", "m1"), memory_type: "invalid" })).toThrow();
  });
});

describe("输入边界 zod 契约", () => {
  it("SaveMemoryInputSchema 拒绝非法 scope", () => {
    expect(() =>
      SaveMemoryInputSchema.parse({
        scope: "invalid",
        name: "x",
        description: "d",
        memory_type: "fact",
        content: "c",
      }),
    ).toThrow();
  });

  it("saveMemory 入口拒绝非法 scope（zod 边界生效）", () => {
    const store = build();
    expect(() =>
      store.saveMemory({
        scope: "invalid" as SaveMemoryInput["scope"],
        name: "x",
        description: "d",
        memory_type: "fact",
        content: "c",
      }),
    ).toThrow();
  });

  it("saveMemory 入口对合法 input 正常通过（宽松不拒历史形状）", () => {
    const store = build();
    const input: unknown = {
      ...baseSave("s1", "ok"),
      why: "reason",
      how_to_apply: "tip",
      extra_unknown_field: "ignored", // z.object 默认 strip，不抛错
    };
    const saved = store.saveMemory(input as SaveMemoryInput);
    expect(saved.file_name).toContain("ok");
  });
});
