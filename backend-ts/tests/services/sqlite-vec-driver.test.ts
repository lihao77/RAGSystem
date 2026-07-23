import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AsyncVectorRecord } from "../../src/contracts/knowledge/async-vector-store.js";
import { SqliteVecDriver } from "../../src/adapters/local/vector-store/sqlite-vec-driver.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const { load: loadVec } = require("sqlite-vec") as typeof import("sqlite-vec");

/**
 * SqliteVecDriver 单测:验证 Async knowledge 端口、vec0 真 ANN 召回、删除、计数、维度约束。
 * 依赖 sqlite-vec native loadExtension(spike 验证 Node24/Windows 可行)。
 */
const TENANT = "tnt_local";

const config = (dbPath = ":memory:") => ({
  backend: "sqlite_vec",
  options: { database_path: dbPath },
  dataRoot: "/tmp/vector-test",
});

const record = (
  docId: string,
  embedding: number[],
  overrides: Partial<AsyncVectorRecord> = {},
): AsyncVectorRecord => ({
  tenant_id: TENANT,
  document_id: docId,
  collection: "col1",
  model_id: 1,
  chunk_index: 0,
  content: `content-${docId}`,
  metadata: {},
  embedding,
  ...overrides,
});

describe("SqliteVecDriver", () => {
  it("upsert + search 使用 cosine 距离并返回正确相似度", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([
      record("d1", [1, 0, 0, 0]),
      record("d2", [0.8, 0.6, 0, 0]),
      record("d3", [0, 1, 0, 0]),
    ]);
    const hits = await driver.search({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0, 0, 0],
      top_k: 3,
    });
    expect(hits).toHaveLength(3);
    expect(hits[0]?.document_id).toBe("d1");
    expect(hits[0]?.vector_score).toBeCloseTo(1, 5);
    expect(hits[1]?.document_id).toBe("d2");
    expect(hits[1]?.vector_score).toBeCloseTo(0.8, 5);
    expect(hits[2]?.document_id).toBe("d3");
    expect(hits[2]?.vector_score).toBeCloseTo(0, 5);
    driver.close();
  });

  it("supports global collection search and exact metadata filters", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([
      record("d1", [1, 0], { collection: "col1", metadata: { category: "guide", tags: ["rag", "ts"] } }),
      record("d2", [0.99, 0.01], { collection: "col2", metadata: { category: "guide", tags: ["rag"] } }),
      record("d3", [0.98, 0.02], { collection: "col2", metadata: { category: "note", tags: ["rag"] } }),
    ]);
    const hits = await driver.search({
      tenant_id: TENANT,
      model_id: 1,
      query_vector: [1, 0],
      top_k: 5,
      filters: { category: "guide", tags: ["ts"] },
    });
    expect(hits.map((item) => `${item.collection}/${item.document_id}`)).toEqual(["col1/d1"]);
    driver.close();
  });

  it("recalls lexical-only chunks with FTS5 BM25 independently from vector top-k", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([
      record("lexical-doc", [0, 1], { content: "incident response handbook with exact recovery steps" }),
      record("vector-doc", [1, 0], { content: "unrelated semantic nearest neighbour" }),
      record("zh-doc", [0.5, 0.5], { content: "知识库混合检索配置与调试说明" }),
      record("mixed-doc", [0.2, 0.8], { content: "RAG向量数据库配置" }),
    ]);
    const vectorHits = await driver.search({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 1,
    });
    const lexicalHits = await driver.lexicalSearch({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query: "incident response recovery",
      top_k: 2,
    });
    const chineseHits = await driver.lexicalSearch({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query: "混合检索",
      top_k: 2,
    });
    const mixedChineseHits = await driver.lexicalSearch({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query: "向量数据库",
      top_k: 2,
    });
    const mixedEnglishHits = await driver.lexicalSearch({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query: "RAG",
      top_k: 2,
    });
    expect(vectorHits[0]?.document_id).toBe("vector-doc");
    expect(lexicalHits[0]).toMatchObject({ document_id: "lexical-doc", keyword_score: 1 });
    expect(chineseHits[0]?.document_id).toBe("zh-doc");
    expect(mixedChineseHits[0]?.document_id).toBe("mixed-doc");
    expect(mixedEnglishHits[0]?.document_id).toBe("mixed-doc");
    driver.close();
  });

  it("atomic replacement rolls back the old vectors when the new batch fails", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([record("d1", [1, 0])]);
    await expect(driver.replaceChunks({
      tenant_id: TENANT,
      collection: "col1",
      document_id: "d1",
      model_id: 1,
      records: [record("d1", [1, 0, 0], { content: "invalid replacement" })],
    })).rejects.toThrow();
    const hits = await driver.search({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 1,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("content-d1");
    driver.close();
  });

  it("rolls back the dimension cache when a new-model batch fails", async () => {
    const driver = new SqliteVecDriver(config());
    await expect(driver.upsertChunks([
      record("d1", [1, 0], { model_id: 9 }),
      record("d2", [1, 0, 0], { model_id: 9 }),
    ])).rejects.toThrow("维度不一致");

    await expect(driver.upsertChunks([
      record("d1", [1, 0], { model_id: 9 }),
    ])).resolves.toBeUndefined();
    expect(await driver.getDimension({ tenant_id: TENANT, model_id: 9 })).toBe(2);
    driver.close();
  });

  it("search 按 collection 过滤(跨 collection 不召回)", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([
      record("d1", [1, 0], { collection: "col1" }),
      record("d2", [1, 0], { collection: "col2" }),
    ]);
    const hits = await driver.search({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.document_id).toBe("d1");
    driver.close();
  });

  it("search 未知 model_id 返回空数组(无 vec 表)", async () => {
    const driver = new SqliteVecDriver(config());
    const hits = await driver.search({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 99,
      query_vector: [1, 0],
      top_k: 5,
    });
    expect(hits).toEqual([]);
    driver.close();
  });

  it("deleteChunks by document 删 chunk + 向量", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([record("d1", [1, 0]), record("d2", [0, 1])]);
    const deleted = await driver.deleteChunks({ tenant_id: TENANT, collection: "col1", document_id: "d1" });
    expect(deleted).toBe(1);
    expect(await driver.countChunks({ tenant_id: TENANT, collection: "col1" })).toBe(1);
    const hits = await driver.search({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.document_id).toBe("d2");
    driver.close();
  });

  it("deleteCollection 清空 collection", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([record("d1", [1, 0]), record("d2", [0, 1])]);
    const deleted = await driver.deleteCollection({ tenant_id: TENANT, collection: "col1" });
    expect(deleted).toBe(2);
    expect(await driver.countChunks({ tenant_id: TENANT, collection: "col1" })).toBe(0);
    driver.close();
  });

  it("deleteChunks by model 删向量", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([record("d1", [1, 0]), record("d2", [0, 1])]);
    const deleted = await driver.deleteChunks({ tenant_id: TENANT, model_id: 1 });
    expect(deleted).toBe(2);
    const hits = await driver.search({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 5,
    });
    expect(hits).toEqual([]);
    driver.close();
  });

  it("deleteChunks by document_id 跨 collection 删同一 document_id 的全部 chunks", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([
      record("d1", [1, 0], { collection: "col1", chunk_index: 0 }),
      record("d1", [0, 1], { collection: "col2", chunk_index: 0 }),
      record("d2", [1, 0], { collection: "col1", chunk_index: 0 }),
    ]);
    const deleted = await driver.deleteChunks({ tenant_id: TENANT, document_id: "d1" });
    expect(deleted).toBe(2);
    expect(await driver.countChunks({ tenant_id: TENANT, collection: "col1" })).toBe(1);
    expect(await driver.countChunks({ tenant_id: TENANT, collection: "col2" })).toBe(0);
    expect(await driver.deleteChunks({ tenant_id: TENANT, document_id: "d1" })).toBe(0);
    driver.close();
  });

  it("deleteChunks by document+model 只清指定 model 向量,不动其他 model", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([
      record("d1", [1, 0], { collection: "col1", model_id: 1 }),
      record("d1", [1, 0, 0], { collection: "col1", model_id: 2 }),
    ]);
    const deleted = await driver.deleteChunks({
      tenant_id: TENANT,
      collection: "col1",
      document_id: "d1",
      model_id: 1,
    });
    expect(deleted).toBe(1);
    const hits1 = await driver.search({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 1,
      query_vector: [1, 0],
      top_k: 1,
    });
    expect(hits1).toHaveLength(0);
    const hits2 = await driver.search({
      tenant_id: TENANT,
      collection: "col1",
      model_id: 2,
      query_vector: [1, 0, 0],
      top_k: 1,
    });
    expect(hits2).toHaveLength(1);
    expect(hits2[0]?.document_id).toBe("d1");
    expect(await driver.countChunks({ tenant_id: TENANT, collection: "col1" })).toBe(1);
    expect(await driver.deleteChunks({
      tenant_id: TENANT,
      collection: "col1",
      document_id: "d1",
      model_id: 999,
    })).toBe(0);
    driver.close();
  });

  it("countVectors / countChunks / listCollections / health", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([record("d1", [1, 0]), record("d2", [0, 1])]);
    expect(await driver.countChunks({ tenant_id: TENANT, collection: "col1" })).toBe(2);
    expect(await driver.countVectors({ tenant_id: TENANT, collection: "col1", model_id: 1 })).toBe(2);
    const cols = await driver.listCollections(TENANT);
    expect(cols).toHaveLength(1);
    expect(cols[0]?.name).toBe("col1");
    const health = await driver.health(TENANT);
    expect(health.runtime).toBe("sqlite_vec");
    expect(health.ann).toBe(true);
    driver.close();
  });

  it("listDocuments 返回 collection 下全部 documents(数组,聚合 chunk_count)", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([
      record("d1", [1, 0], { chunk_index: 0 }),
      record("d1", [0, 1], { chunk_index: 1 }),
      record("d2", [1, 0]),
    ]);
    const docs = await driver.listDocuments({ tenant_id: TENANT, collection: "col1" });
    expect(docs).toHaveLength(2);
    const d1 = docs.find((d) => d.document_id === "d1");
    expect(d1?.chunk_count).toBe(2);
    const d2 = docs.find((d) => d.document_id === "d2");
    expect(d2?.chunk_count).toBe(1);
    driver.close();
  });

  it("countVectorsForDocument 按 document+model_id 计数(无 vec 表返 0)", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([
      record("d1", [1, 0], { chunk_index: 0 }),
      record("d1", [0, 1], { chunk_index: 1 }),
      record("d2", [1, 0]),
    ]);
    expect(await driver.countVectorsForDocument({
      tenant_id: TENANT, collection: "col1", document_id: "d1", model_id: 1,
    })).toBe(2);
    expect(await driver.countVectorsForDocument({
      tenant_id: TENANT, collection: "col1", document_id: "d2", model_id: 1,
    })).toBe(1);
    expect(await driver.countVectorsForDocument({
      tenant_id: TENANT, collection: "col1", document_id: "d1", model_id: 99,
    })).toBe(0);
    driver.close();
  });

  it("同 model_id 维度不一致抛 VectorStoreError", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([record("d1", [1, 0])]);
    await expect(driver.upsertChunks([record("d2", [1, 0, 0])])).rejects.toThrow(/维度不一致/);
    driver.close();
  });

  it("空表重启后从 DDL 推断维度,维度不一致抛中文错(不泄漏 sqlite-vec 原生错)", async () => {
    const dbPath = path.join(os.tmpdir(), `vec-empty-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    try {
      const driver1 = new SqliteVecDriver(config(dbPath));
      await driver1.upsertChunks([record("d1", [1, 0])]);
      await driver1.deleteCollection({ tenant_id: TENANT, collection: "col1" });
      driver1.close();

      const driver2 = new SqliteVecDriver(config(dbPath));
      await expect(driver2.upsertChunks([record("d2", [1, 0, 0])])).rejects.toThrow(/维度不一致/);
      driver2.close();
    } finally {
      for (const ext of ["", "-wal", "-shm"]) {
        fs.rmSync(dbPath + ext, { force: true });
      }
    }
  });

  it("启动时删除旧 L2 vec0 表并允许按 cosine 新维度重建", async () => {
    const dbPath = path.join(os.tmpdir(), `vec-l2-reset-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const initial = new SqliteVecDriver(config(dbPath));
      await initial.upsertChunks([record("d1", [1, 0])]);
      initial.close();

      const legacyDb = new DatabaseSync(dbPath, { allowExtension: true });
      loadVec(legacyDb);
      const document = legacyDb.prepare("SELECT id FROM vec_documents WHERE document_id = ?").get("d1") as { id: number };
      legacyDb.exec("DROP TABLE vec_chunks_1");
      legacyDb.exec("CREATE VIRTUAL TABLE vec_chunks_1 USING vec0(embedding float[2])");
      legacyDb.prepare("INSERT INTO vec_chunks_1(rowid, embedding) VALUES (?, ?)").run(BigInt(document.id), "[1,0]");
      legacyDb.close();

      const migrated = new SqliteVecDriver(config(dbPath));
      await expect(migrated.getDimension({ tenant_id: TENANT, model_id: 1 })).resolves.toBeNull();
      await expect(migrated.search({ tenant_id: TENANT, model_id: 1, query_vector: [1, 0], top_k: 1 })).resolves.toEqual([]);
      await migrated.upsertChunks([record("d2", [1, 0, 0])]);
      migrated.close();

      const verifyDb = new DatabaseSync(dbPath, { allowExtension: true });
      loadVec(verifyDb);
      const ddl = verifyDb.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_chunks_1'").get() as { sql: string };
      expect(ddl.sql).toContain("distance_metric=cosine");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("已删除不兼容"));
      verifyDb.close();
    } finally {
      warn.mockRestore();
      for (const ext of ["", "-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true });
    }
  });

  it("listChunks 返回全量 chunk 行(metadata parsed),listAllDocuments 跨 collection 聚合", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([
      record("d1", [1, 0], { collection: "col1", chunk_index: 0 }),
      record("d1", [0, 1], { collection: "col1", chunk_index: 1 }),
      record("d2", [1, 0], { collection: "col2" }),
    ]);
    const all = await driver.listChunks({ tenant_id: TENANT });
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({
      collection: "col1", document_id: "d1", chunk_index: 0, content: "content-d1", tenant_id: TENANT,
    });
    expect(all[0]?.metadata).toEqual({});
    const col1 = await driver.listChunks({ tenant_id: TENANT, collection: "col1" });
    expect(col1).toHaveLength(2);
    expect(col1.every((c) => c.collection === "col1")).toBe(true);
    const docs = await driver.listAllDocuments(TENANT);
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.document_id === "d1")).toMatchObject({ collection: "col1", chunk_count: 2 });
    driver.close();
  });

  it("getChunk 用十进制字符串 id,拒绝 padded 形式", async () => {
    const driver = new SqliteVecDriver(config());
    await driver.upsertChunks([record("d1", [1, 0])]);
    const [chunk] = await driver.listChunks({ tenant_id: TENANT });
    expect(chunk).toBeTruthy();
    await expect(driver.getChunk(TENANT, chunk!.id)).resolves.toMatchObject({ id: chunk!.id, document_id: "d1" });
    await expect(driver.getChunk(TENANT, `0${chunk!.id}`)).resolves.toBeNull();
    driver.close();
  });

  it("addKnowledgeFile 落盘物理 blob + list/get 读回", async () => {
    const driver = new SqliteVecDriver(config());
    const created = await driver.addKnowledgeFile({
      originalName: "notes.txt",
      buffer: Buffer.from("hello kb"),
      mime: "text/plain",
    });
    expect(created.id).toBeTruthy();
    expect(created.original_name).toBe("notes.txt");
    expect(created.size).toBe(8);
    expect(created.mime).toBe("text/plain");
    expect(fs.existsSync(created.stored_path)).toBe(true);
    expect(fs.readFileSync(created.stored_path, "utf8")).toBe("hello kb");
    expect(await driver.listKnowledgeFiles()).toHaveLength(1);
    expect((await driver.getKnowledgeFile(created.id))?.original_name).toBe("notes.txt");
    expect(await driver.getKnowledgeFile("nope")).toBeNull();
    const storedMd = await driver.putKnowledgeMarkdown(created.id, "# 标题\n\n正文");
    expect(storedMd.md_blob_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await driver.getKnowledgeFile(created.id))?.md_blob_hash).toBe(storedMd.md_blob_hash);
    expect(await driver.readKnowledgeMarkdown(storedMd.md_blob_hash)).toBe("# 标题\n\n正文");
    const source = await driver.getSource(created.id);
    expect(source?.contentType).toBe("text/plain");
    expect(Buffer.from(source!.body).toString("utf8")).toBe("hello kb");
    driver.close();
  });

  it("deleteKnowledgeFile 删行 + 删物理 blob(自包含)", async () => {
    const driver = new SqliteVecDriver(config());
    const created = await driver.addKnowledgeFile({
      originalName: "a.txt",
      buffer: Buffer.from("aaa"),
      mime: "text/plain",
    });
    const storedPath = created.stored_path;
    expect(fs.existsSync(storedPath)).toBe(true);
    const deleted = await driver.deleteKnowledgeFile(created.id);
    expect(deleted?.id).toBe(created.id);
    expect(await driver.getKnowledgeFile(created.id)).toBeNull();
    expect(await driver.listKnowledgeFiles()).toHaveLength(0);
    expect(fs.existsSync(storedPath)).toBe(false);
    expect(await driver.deleteKnowledgeFile("nope")).toBeNull();
    driver.close();
  });

  it("getKnowledgeUploadsRoot :memory: 库落在 os.tmpdir 子目录", () => {
    const driver = new SqliteVecDriver(config());
    expect(driver.getKnowledgeUploadsRoot().startsWith(os.tmpdir())).toBe(true);
    driver.close();
  });

  it("config store 支持 setVectorDimension / activate / delete 回退", async () => {
    const driver = new SqliteVecDriver(config());
    const first = await driver.createVectorizer(TENANT, {
      vectorizer_key: "v1",
      provider_key: "local",
      provider_type: "local",
      model_name: "hash",
      distance_metric: "cosine",
    });
    expect(first.is_active).toBe(true);
    await driver.setVectorDimension(TENANT, "v1", 64);
    expect((await driver.getVectorizerByKey(TENANT, "v1"))?.vector_dimension).toBe(64);
    const second = await driver.createVectorizer(TENANT, {
      vectorizer_key: "v2",
      provider_key: "local",
      provider_type: "local",
      model_name: "hash2",
      distance_metric: "cosine",
    });
    expect(second.is_active).toBe(false);
    await driver.activateVectorizer(TENANT, "v2");
    expect((await driver.getVectorizerByKey(TENANT, "v2"))?.is_active).toBe(true);
    const deleted = await driver.deleteVectorizer(TENANT, "v2");
    expect(deleted.next_active_key).toBe("v1");
    driver.close();
  });
});
