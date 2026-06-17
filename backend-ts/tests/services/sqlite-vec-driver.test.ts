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

  it("同 model_id 维度不一致抛 VectorStoreError", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertRecords([record("d1", [1, 0])]);
    await expect(driver.upsertRecords([record("d2", [1, 0, 0])])).rejects.toThrow(/维度不一致/);
    driver.close();
  });
});
