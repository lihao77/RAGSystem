import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { VectorRecord } from "../../src/contracts/vector-store/index.js";
import { SqliteVecDriver } from "../../src/services/vector-store/sqlite-vec/sqlite-vec-driver.js";

/**
 * SqliteVecDriver 单测:验证 vec0 真 ANN 召回、collection 过滤、删除、计数、维度约束。
 * 依赖 sqlite-vec native loadExtension(spike 验证 Node24/Windows 可行)。
 */
const config = (dbPath = ":memory:") => ({
  backend: "sqlite_vec",
  options: { database_path: dbPath, vector_dimension: 0, distance_metric: "cosine" },
  dataRoot: "/tmp/vector-test",
});

const record = (
  docId: string,
  embedding: number[],
  overrides: Partial<VectorRecord> = {},
): VectorRecord => ({
  id: "",
  doc_id: docId,
  collection: "col1",
  model_id: 1,
  chunk_index: 0,
  content: `content-${docId}`,
  metadata: {},
  embedding,
  ...overrides,
});

describe("SqliteVecDriver", () => {
  it("upsert + search KNN 召回最近邻,相同向量 cosine distance=0 → similarity=1", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([
      record("d1", [1, 0, 0, 0]),
      record("d2", [0, 1, 0, 0]),
      record("d3", [0, 0, 1, 0]),
    ]);
    const hits = await driver.search({
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0, 0, 0],
      top_k: 1,
      search_mode: "vector",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.doc_id).toBe("d1");
    expect(hits[0]?.vector_score).toBeCloseTo(1, 5);
    driver.close();
  });

  it("atomic replacement rolls back the old vectors when the new batch fails", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([record("d1", [1, 0])]);
    await expect(driver.replaceDocumentVectorsByModel(
      "col1",
      "d1",
      1,
      [record("d1", [1, 0, 0], { content: "invalid replacement" })],
    )).rejects.toThrow();
    const hits = await driver.search({
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 1,
      search_mode: "vector",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("content-d1");
    driver.close();
  });

  it("rolls back the dimension cache when a new-model batch fails", async () => {
    const driver = new SqliteVecDriver(config());
    await expect(driver.upsertRecords([
      record("d1", [1, 0], { model_id: 9 }),
      record("d2", [1, 0, 0], { model_id: 9 }),
    ])).rejects.toThrow("维度不一致");

    await expect(driver.upsertRecords([
      record("d1", [1, 0], { model_id: 9 }),
    ])).resolves.toBeUndefined();
    expect(driver.getDimension(9)).toBe(2);
    driver.close();
  });

  it("search 按 collection 过滤(跨 collection 不召回)", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([
      record("d1", [1, 0], { collection: "col1" }),
      record("d2", [1, 0], { collection: "col2" }),
    ]);
    const hits = await driver.search({
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 5,
      search_mode: "vector",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.doc_id).toBe("d1");
    driver.close();
  });

  it("search 未知 model_id 返回空数组(无 vec 表)", async () => {
    const driver = new SqliteVecDriver(config());
    const hits = await driver.search({
      collection: "col1",
      model_id: 99,
      query_vector: [1, 0],
      top_k: 5,
      search_mode: "vector",
    });
    expect(hits).toEqual([]);
    driver.close();
  });

  it("deleteDocument 删 chunk + 向量", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([record("d1", [1, 0]), record("d2", [0, 1])]);
    const result = await driver.deleteDocument("col1", "d1");
    expect(result.deleted_chunks).toBe(1);
    expect(await driver.countChunks("col1")).toBe(1);
    const hits = await driver.search({
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 5,
      search_mode: "vector",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.doc_id).toBe("d2");
    driver.close();
  });

  it("deleteCollection 清空 collection", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([record("d1", [1, 0]), record("d2", [0, 1])]);
    const result = await driver.deleteCollection("col1");
    expect(result.deleted_chunks).toBe(2);
    expect(await driver.countChunks("col1")).toBe(0);
    driver.close();
  });

  it("deleteByModel 删向量(driver.deleteByModel 解耦口)", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([record("d1", [1, 0]), record("d2", [0, 1])]);
    const result = await driver.deleteByModel(1);
    expect(result.deleted).toBe(2);
    const hits = await driver.search({
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 5,
      search_mode: "vector",
    });
    expect(hits).toEqual([]);
    driver.close();
  });

  it("deleteDocumentVectors 跨 collection 删同一 document_id 的全部 chunks", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([
      record("d1", [1, 0], { collection: "col1", chunk_index: 0 }),
      record("d1", [0, 1], { collection: "col2", chunk_index: 0 }),
      record("d2", [1, 0], { collection: "col1", chunk_index: 0 }),
    ]);
    const result = await driver.deleteDocumentVectors("d1");
    expect(result.deleted_chunks).toBe(2);
    // col1 剩 d2,col2 清空(跨 collection 全清)
    expect(await driver.countChunks("col1")).toBe(1);
    expect(await driver.countChunks("col2")).toBe(0);
    // 不存在的 document_id 返 0(幂等,删文件联动可安全重试)
    expect((await driver.deleteDocumentVectors("d1")).deleted_chunks).toBe(0);
    driver.close();
  });

  it("deleteDocumentVectorsByModel 只清指定 model 向量,不动其他 model", async () => {
    const driver = new SqliteVecDriver(config());
    // 同一 document col1/d1 两个 model 各嵌一份(共享一条 chunk 文本行)
    await driver.upsertRecords([
      record("d1", [1, 0], { collection: "col1", model_id: 1 }),
      record("d1", [1, 0, 0], { collection: "col1", model_id: 2 }),
    ]);
    // 删 model 1 的向量
    const result = await driver.deleteDocumentVectorsByModel("col1", "d1", 1);
    expect(result.deleted).toBe(1);
    // model 1 召回空(已清),model 2 召回仍在(未被波及)
    const hits1 = await driver.search({
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 1,
      search_mode: "vector",
    });
    expect(hits1).toHaveLength(0);
    const hits2 = await driver.search({
      collection: "col1",
      model_id: 2,
      query_vector: [1, 0, 0],
      top_k: 1,
      search_mode: "vector",
    });
    expect(hits2).toHaveLength(1);
    expect(hits2[0]?.doc_id).toBe("d1");
    // 共享 chunk 文本行仍在(model 2 还引用,未删 vec_documents)
    expect(await driver.countChunks("col1")).toBe(1);
    // 不存在的 model_id 返 0(无向量表,幂等)
    expect((await driver.deleteDocumentVectorsByModel("col1", "d1", 999)).deleted).toBe(0);
    driver.close();
  });

  it("countVectors / countChunks / listCollections / health", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([record("d1", [1, 0]), record("d2", [0, 1])]);
    expect(await driver.countChunks("col1")).toBe(2);
    expect(await driver.countVectors("col1", 1)).toBe(2);
    const cols = await driver.listCollections();
    expect(cols).toHaveLength(1);
    expect(cols[0]?.name).toBe("col1");
    const health = await driver.health();
    expect(health.runtime).toBe("sqlite_vec");
    expect(health.ann).toBe(true);
    driver.close();
  });

  it("listDocuments 返回 collection 下全部 documents(数组,聚合 chunk_count)", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([
      record("d1", [1, 0], { chunk_index: 0 }),
      record("d1", [0, 1], { chunk_index: 1 }),
      record("d2", [1, 0]),
    ]);
    const docs = await driver.listDocuments("col1");
    expect(docs).toHaveLength(2);
    const d1 = docs.find((d) => d.document_id === "d1");
    expect(d1?.chunk_count).toBe(2);
    const d2 = docs.find((d) => d.document_id === "d2");
    expect(d2?.chunk_count).toBe(1);
    driver.close();
  });

  it("countVectorsForDocument 按 document+model_id 计数(无 vec 表返 0)", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([
      record("d1", [1, 0], { chunk_index: 0 }),
      record("d1", [0, 1], { chunk_index: 1 }),
      record("d2", [1, 0]),
    ]);
    expect(await driver.countVectorsForDocument("col1", "d1", 1)).toBe(2);
    expect(await driver.countVectorsForDocument("col1", "d2", 1)).toBe(1);
    expect(await driver.countVectorsForDocument("col1", "d1", 99)).toBe(0);
    driver.close();
  });

  it("同 model_id 维度不一致抛 VectorStoreError", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([record("d1", [1, 0])]);
    await expect(driver.upsertRecords([record("d2", [1, 0, 0])])).rejects.toThrow(/维度不一致/);
    driver.close();
  });

  it("空表重启后从 DDL 推断维度,维度不一致抛中文错(不泄漏 sqlite-vec 原生错)", async () => {
    // 文件库跨实例持久化,模拟"建表 → 清空数据 → 重启"。
    const dbPath = path.join(os.tmpdir(), `vec-empty-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    try {
      // 阶段1:建 float[2] 表并写入,随后 deleteCollection 清空数据(表结构保留 → 空表)。
      const driver1 = new SqliteVecDriver(config(dbPath));
      await driver1.upsertRecords([record("d1", [1, 0])]);
      await driver1.deleteCollection("col1");
      driver1.close();

      // 阶段2:重新打开模拟重启,loadDimensionsFromSchema 扫到空表。
      // 旧实现:SELECT embedding LIMIT 1 读行推断,空表返回 null → dimensionByModel 漏记 →
      //        3维 upsert 绕过中文拦截,CREATE IF NOT EXISTS 静默 no-op,INSERT 3维到 float[2] → sqlite-vec 抛原生 Dimension mismatch。
      // 新实现:从 DDL float[2] 推断 → ensureVecTable 抛中文 维度不一致。
      const driver2 = new SqliteVecDriver(config(dbPath));
      await expect(driver2.upsertRecords([record("d2", [1, 0, 0])])).rejects.toThrow(/维度不一致/);
      driver2.close();
    } finally {
      for (const ext of ["", "-wal", "-shm"]) {
        fs.rmSync(dbPath + ext, { force: true });
      }
    }
  });

  it("listChunks 返回全量 chunk 行(metadata parsed),listAllDocuments 跨 collection 聚合", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([
      record("d1", [1, 0], { collection: "col1", chunk_index: 0 }),
      record("d1", [0, 1], { collection: "col1", chunk_index: 1 }),
      record("d2", [1, 0], { collection: "col2" }),
    ]);
    // listChunks 全量(跨 collection),metadata 已 parse 为 object
    const all = await driver.listChunks();
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ collection: "col1", document_id: "d1", chunk_index: 0, content: "content-d1" });
    expect(all[0]?.metadata).toEqual({});
    // listChunks 按 collection 过滤
    const col1 = await driver.listChunks("col1");
    expect(col1).toHaveLength(2);
    expect(col1.every((c) => c.collection === "col1")).toBe(true);
    // listAllDocuments 跨 collection 聚合(GROUP BY collection, document_id → chunk_count)
    const docs = await driver.listAllDocuments();
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.document_id === "d1")).toMatchObject({ collection: "col1", chunk_count: 2 });
    driver.close();
  });

  it("addKnowledgeFile 落盘物理 blob + list/get 读回", () => {
    const driver = new SqliteVecDriver(config());
    const created = driver.addKnowledgeFile({
      originalName: "notes.txt",
      buffer: Buffer.from("hello kb"),
      mime: "text/plain",
    });
    expect(created.id).toBeTruthy();
    expect(created.original_name).toBe("notes.txt");
    expect(created.size).toBe(8);
    expect(created.mime).toBe("text/plain");
    // 物理 blob 落盘(driver 自管目录)
    expect(fs.existsSync(created.stored_path)).toBe(true);
    expect(fs.readFileSync(created.stored_path, "utf8")).toBe("hello kb");
    // list/get 读回
    expect(driver.listKnowledgeFiles()).toHaveLength(1);
    expect(driver.getKnowledgeFile(created.id)?.original_name).toBe("notes.txt");
    expect(driver.getKnowledgeFile("nope")).toBeNull();
    const storedMd = driver.putKnowledgeMarkdown(created.id, "# 标题\n\n正文");
    expect(storedMd.md_blob_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(driver.getKnowledgeFile(created.id)?.md_blob_hash).toBe(storedMd.md_blob_hash);
    expect(driver.readKnowledgeMarkdown(storedMd.md_blob_hash)).toBe("# 标题\n\n正文");
    driver.close();
  });

  it("deleteKnowledgeFile 删行 + 删物理 blob(自包含)", () => {
    const driver = new SqliteVecDriver(config());
    const created = driver.addKnowledgeFile({
      originalName: "a.txt",
      buffer: Buffer.from("aaa"),
      mime: "text/plain",
    });
    const storedPath = created.stored_path;
    expect(fs.existsSync(storedPath)).toBe(true);
    const deleted = driver.deleteKnowledgeFile(created.id);
    expect(deleted?.id).toBe(created.id);
    // 元数据行删
    expect(driver.getKnowledgeFile(created.id)).toBeNull();
    expect(driver.listKnowledgeFiles()).toHaveLength(0);
    // 物理 blob 删(知识库 blob 归 driver 管,非留路由层 removeStoredFile)
    expect(fs.existsSync(storedPath)).toBe(false);
    // 不存在返回 null(非抛)
    expect(driver.deleteKnowledgeFile("nope")).toBeNull();
    driver.close();
  });

  it("getKnowledgeUploadsRoot :memory: 库落在 os.tmpdir 子目录", () => {
    const driver = new SqliteVecDriver(config());
    expect(driver.getKnowledgeUploadsRoot().startsWith(os.tmpdir())).toBe(true);
    driver.close();
  });
});
