import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { load as loadVec } from "sqlite-vec";

import type {
  AddKnowledgeFileInput,
  CollectionInfo,
  CreateRerankerInput,
  CreateVectorizerInput,
  DocumentInfo,
  IKnowledgeConfig,
  IKnowledgeFileStore,
  IVectorStore,
  KnowledgeFile,
  StoredChunk,
  StoredReranker,
  StoredVectorizer,
  VectorRecord,
  VectorSearchHit,
  VectorStoreDriverConfig,
  VectorStoreHealth,
  VectorStoreQuery,
} from "../../../contracts/vector-store/index.js";
import { VectorStoreError } from "../../../contracts/vector-store/index.js";
import { registerDriver } from "../registry.js";
import { documentsTableDdl, kbFilesTableDdl, rerankersTableDdl, vecTableDdl, vecTableName, vectorizersTableDdl } from "./schema.js";
import { sanitizeFilename } from "../../../utils/file-filter.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const SEARCH_OVERFETCH = 5;
const DEFAULT_RECALL = 50;

interface SqliteVecOptions {
  databasePath: string;
  vectorDimension: number;
  distanceMetric: string;
}

interface VecDocRow {
  id: number;
  document_id: string;
  collection: string;
  content: string;
  metadata: string;
}

interface KnnRow {
  rowid: number;
  distance: number;
}

/**
 * sqlite-vec driver:用 sqlite-vec 扩展(vec0 虚拟表)做真 ANN 检索。
 *
 * spike 验证(Node 24 / Windows):new DatabaseSync(path, { allowExtension: true }) + loadVec(db) 可行;
 * vec0 rowid 用 bigint;embedding JSON 字符串;KNN `WHERE embedding MATCH ? ORDER BY distance LIMIT k`。
 *
 * 维度策略:每个 model_id 一个 vec0 表(vec_chunks_${model_id}),维度由首次 upsert 的 embedding.length
 * 决定(config.vector_dimension=0 自动,对齐 Python client.py:96-142)。search 召回 vector_score(1 - distance);
 * keyword/hybrid/rerank 由编排层(scoring.ts)补。
 */
export class SqliteVecDriver implements IVectorStore, IKnowledgeConfig, IKnowledgeFileStore {
  private readonly db: import("node:sqlite").DatabaseSync;
  private readonly dimensionByModel = new Map<number, number>();
  private readonly knowledgeUploadsRoot: string;
  private readonly dbIsMemory: boolean;

  constructor(config: VectorStoreDriverConfig) {
    const options = parseOptions(config);
    const dbPath = resolveDbPath(options.databasePath, config.dataRoot);
    this.dbIsMemory = dbPath === ":memory:";
    if (!this.dbIsMemory) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    // 知识库文件物理 blob 根:文件库 → <dataRoot>/db/knowledge-uploads(与 knowledge.db 同目录树,知识库自包含);
    // :memory: 临时库(测试/瞬态)→ os.tmpdir 下 mkdtemp 临时目录,close 时清理,不污染工作区。
    this.knowledgeUploadsRoot = this.dbIsMemory
      ? fs.mkdtempSync(path.join(os.tmpdir(), "rag-kb-uploads-"))
      : path.join(config.dataRoot ?? path.join(os.homedir(), ".ragsystem"), "db", "knowledge-uploads");
    // allowExtension:true 必须创建时设置(node:sqlite 默认禁用 extension loading 且创建后不可启用)。
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    loadVec(this.db);
    this.db.exec(documentsTableDdl());
    this.db.exec(kbFilesTableDdl());
    this.db.exec(vectorizersTableDdl());
    this.db.exec(rerankersTableDdl());
    this.loadDimensionsFromSchema();
    warnLegacyVectorsDb(config.dataRoot);
  }

  async upsertRecords(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    const insertDoc = this.db.prepare(
      `INSERT INTO vec_documents (collection, document_id, chunk_index, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // vec_documents 幂等:同 (collection, document_id, chunk_index) 复用现有行——migrate/sync 给已存在 chunk
    // 补向量时 content 已在(UNIQUE 三列不含 model_id),避免冲突;向量写各自 model_id 的 vec_chunks 表。
    const findDoc = this.db.prepare(
      `SELECT id FROM vec_documents WHERE collection = ? AND document_id = ? AND chunk_index = ?`,
    );
    const updateDoc = this.db.prepare(`UPDATE vec_documents SET content = ?, metadata = ? WHERE id = ?`);
    for (const record of records) {
      this.ensureVecTable(record.model_id, record.embedding.length);
      const existing = findDoc.get(record.collection, record.doc_id, record.chunk_index) as
        | { id: number }
        | undefined;
      let rowid: number;
      if (existing) {
        rowid = Number(existing.id);
        updateDoc.run(record.content, JSON.stringify(record.metadata ?? {}), rowid);
      } else {
        const result = insertDoc.run(
          record.collection,
          record.doc_id,
          record.chunk_index,
          record.content,
          JSON.stringify(record.metadata ?? {}),
          now,
        );
        rowid = Number(result.lastInsertRowid);
      }
      const table = vecTableName(record.model_id);
      this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(rowid));
      this.db.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`).run(
        BigInt(rowid),
        JSON.stringify(record.embedding),
      );
    }
  }

  async search(query: VectorStoreQuery): Promise<VectorSearchHit[]> {
    if (!this.dimensionByModel.has(query.model_id)) {
      return [];
    }
    const recall = Math.max(query.top_k * SEARCH_OVERFETCH, DEFAULT_RECALL);
    const table = vecTableName(query.model_id);
    const knnRows = this.db
      .prepare(`SELECT rowid, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ${recall}`)
      .all(JSON.stringify(query.query_vector)) as unknown as KnnRow[];
    if (knnRows.length === 0) {
      return [];
    }
    const rowids = knnRows.map((row) => row.rowid);
    const placeholders = rowids.map(() => "?").join(",");
    const docs = this.db
      .prepare(`SELECT id, document_id, collection, content, metadata FROM vec_documents WHERE id IN (${placeholders})`)
      .all(...rowids.map((id) => BigInt(id))) as unknown as VecDocRow[];
    const docById = new Map(docs.map((doc) => [doc.id, doc]));
    const hits: VectorSearchHit[] = [];
    for (const knn of knnRows) {
      const doc = docById.get(knn.rowid);
      if (!doc || doc.collection !== query.collection) {
        continue;
      }
      hits.push({
        id: String(knn.rowid),
        doc_id: doc.document_id,
        document_id: doc.document_id,
        collection: doc.collection,
        content: doc.content,
        metadata: parseRecord(doc.metadata),
        vector_score: Math.max(0, 1 - knn.distance),
        keyword_score: 0,
        hybrid_score: 0,
      });
      if (hits.length >= query.top_k) {
        break;
      }
    }
    return hits;
  }

  async deleteDocument(collection: string, documentId: string): Promise<{ deleted_chunks: number }> {
    const ids = this.db
      .prepare(`SELECT id FROM vec_documents WHERE collection = ? AND document_id = ?`)
      .all(collection, documentId) as unknown as Array<{ id: number }>;
    if (ids.length === 0) {
      return { deleted_chunks: 0 };
    }
    this.purgeVecRows(ids.map((row) => row.id));
    this.db.prepare(`DELETE FROM vec_documents WHERE collection = ? AND document_id = ?`).run(collection, documentId);
    return { deleted_chunks: ids.length };
  }

  /** 按 document_id 跨 collection 删全部 chunks+向量(知识库文件删除联动清向量);不存在返 0。 */
  async deleteDocumentVectors(documentId: string): Promise<{ deleted_chunks: number }> {
    const ids = this.db
      .prepare(`SELECT id FROM vec_documents WHERE document_id = ?`)
      .all(documentId) as unknown as Array<{ id: number }>;
    if (ids.length === 0) {
      return { deleted_chunks: 0 };
    }
    this.purgeVecRows(ids.map((row) => row.id));
    this.db.prepare(`DELETE FROM vec_documents WHERE document_id = ?`).run(documentId);
    return { deleted_chunks: ids.length };
  }

  /**
   * 按 (collection, document_id, model_id) 只删该 model 的向量(重索引幂等);
   * 不动其他 model 向量、不删共享 chunk 文本行(vec_documents)。model 无向量表返 0。
   */
  async deleteDocumentVectorsByModel(
    collection: string,
    documentId: string,
    model_id: number,
  ): Promise<{ deleted: number }> {
    if (!this.dimensionByModel.has(model_id)) {
      return { deleted: 0 };
    }
    const ids = this.db
      .prepare(`SELECT id FROM vec_documents WHERE collection = ? AND document_id = ?`)
      .all(collection, documentId) as unknown as Array<{ id: number }>;
    if (ids.length === 0) {
      return { deleted: 0 };
    }
    const placeholders = ids.map(() => "?").join(",");
    const result = this.db
      .prepare(`DELETE FROM ${vecTableName(model_id)} WHERE rowid IN (${placeholders})`)
      .run(...ids.map((row) => BigInt(row.id)));
    return { deleted: result.changes };
  }

  async deleteCollection(collection: string): Promise<{ deleted_chunks: number }> {
    const ids = this.db
      .prepare(`SELECT id FROM vec_documents WHERE collection = ?`)
      .all(collection) as unknown as Array<{ id: number }>;
    this.purgeVecRows(ids.map((row) => row.id));
    this.db.prepare(`DELETE FROM vec_documents WHERE collection = ?`).run(collection);
    return { deleted_chunks: ids.length };
  }

  async deleteByModel(model_id: number): Promise<{ deleted: number }> {
    const table = vecTableName(model_id);
    if (!this.tableExists(table)) {
      return { deleted: 0 };
    }
    const count = this.countRowsSafe(table);
    this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    this.dimensionByModel.delete(model_id);
    return { deleted: count };
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT collection, COUNT(*) AS total_chunks, COUNT(DISTINCT document_id) AS document_count
         FROM vec_documents GROUP BY collection ORDER BY collection`,
      )
      .all() as unknown as Array<{ collection: string; total_chunks: number; document_count: number }>;
    const defaultDimension = this.dimensionByModel.values().next().value ?? null;
    return rows.map((row) => ({
      name: row.collection,
      total_chunks: row.total_chunks,
      document_count: row.document_count,
      embedding_dimension: defaultDimension,
    }));
  }

  async listDocuments(collection: string): Promise<DocumentInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT document_id, COUNT(*) AS chunk_count, MIN(metadata) AS metadata
         FROM vec_documents WHERE collection = ? GROUP BY document_id ORDER BY document_id`,
      )
      .all(collection) as unknown as Array<{ document_id: string; chunk_count: number; metadata: string | null }>;
    return rows.map((row) => ({
      collection,
      document_id: row.document_id,
      chunk_count: row.chunk_count,
      metadata: row.metadata ? parseRecord(row.metadata) : null,
    }));
  }

  /** 全量 chunk 行(migrate/sync 重嵌取数,driver 唯一文本源);collection 可选,不传=全部。 */
  async listChunks(collection?: string): Promise<StoredChunk[]> {
    const sql = collection
      ? `SELECT id, collection, document_id, chunk_index, content, metadata FROM vec_documents WHERE collection = ? ORDER BY collection, document_id, chunk_index`
      : `SELECT id, collection, document_id, chunk_index, content, metadata FROM vec_documents ORDER BY collection, document_id, chunk_index`;
    const rows = (collection ? this.db.prepare(sql).all(collection) : this.db.prepare(sql).all()) as unknown as Array<{
      id: number;
      collection: string;
      document_id: string;
      chunk_index: number;
      content: string;
      metadata: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      collection: row.collection,
      document_id: row.document_id,
      chunk_index: row.chunk_index,
      content: row.content,
      metadata: parseRecord(row.metadata),
    }));
  }

  /** 跨 collection 的 document 聚合(fileStatus 把 file 与已索引位置 join)。 */
  async listAllDocuments(): Promise<DocumentInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT collection, document_id, COUNT(*) AS chunk_count, MIN(metadata) AS metadata
         FROM vec_documents GROUP BY collection, document_id ORDER BY collection, document_id`,
      )
      .all() as unknown as Array<{ collection: string; document_id: string; chunk_count: number; metadata: string | null }>;
    return rows.map((row) => ({
      collection: row.collection,
      document_id: row.document_id,
      chunk_count: row.chunk_count,
      metadata: row.metadata ? parseRecord(row.metadata) : null,
    }));
  }

  async countVectorsForDocument(collection: string, documentId: string, model_id: number): Promise<number> {
    const table = vecTableName(model_id);
    if (!this.tableExists(table)) {
      return 0;
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table} v JOIN vec_documents d ON d.id = v.rowid WHERE d.collection = ? AND d.document_id = ?`,
      )
      .get(collection, documentId) as unknown as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async countVectors(collection: string, model_id: number): Promise<number> {
    const table = vecTableName(model_id);
    if (!this.tableExists(table)) {
      return 0;
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} v JOIN vec_documents d ON d.id = v.rowid WHERE d.collection = ?`)
      .get(collection) as unknown as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async countVectorsByModel(model_id: number): Promise<Array<{ collection: string; count: number }>> {
    const table = vecTableName(model_id);
    if (!this.tableExists(table)) {
      return [];
    }
    const rows = this.db
      .prepare(`SELECT d.collection, COUNT(*) AS count FROM ${table} v JOIN vec_documents d ON d.id = v.rowid GROUP BY d.collection`)
      .all() as unknown as Array<{ collection: string; count: number }>;
    return rows;
  }

  async countChunks(collection: string): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM vec_documents WHERE collection = ?`)
      .get(collection) as unknown as { n: number } | undefined;
    return row?.n ?? 0;
  }

  getDimension(model_id: number): number | null {
    return this.dimensionByModel.get(model_id) ?? null;
  }

  async health(): Promise<VectorStoreHealth> {
    const row = this.db
      .prepare(`SELECT COUNT(DISTINCT collection) AS n FROM vec_documents`)
      .get() as unknown as { n: number } | undefined;
    return { status: "healthy", runtime: "sqlite_vec", ann: true, collections_count: row?.n ?? 0 };
  }

  close(): void {
    try {
      this.db.close();
    } finally {
      // :memory: 临时库的 blob 目录随 close 清理(测试隔离);文件库 blob 持久保留。
      if (this.dbIsMemory && this.knowledgeUploadsRoot.startsWith(os.tmpdir())) {
        fs.rmSync(this.knowledgeUploadsRoot, { recursive: true, force: true });
      }
    }
  }

  // ====== IKnowledgeConfig 实现(vectorizer/reranker 配置面)======

  listVectorizers(): StoredVectorizer[] {
    const rows = this.db
      .prepare(
        `SELECT model_id, vectorizer_key, provider_key, provider_type, model_name, distance_metric, created_at, vector_dimension, is_active
         FROM vectorizers ORDER BY model_id ASC`,
      )
      .all() as unknown as VectorizerRow[];
    return rows.map(rowToVectorizer);
  }

  getVectorizerByKey(key: string): StoredVectorizer | null {
    const row = this.db
      .prepare(
        `SELECT model_id, vectorizer_key, provider_key, provider_type, model_name, distance_metric, created_at, vector_dimension, is_active
         FROM vectorizers WHERE vectorizer_key = ?`,
      )
      .get(key) as unknown as VectorizerRow | undefined;
    return row ? rowToVectorizer(row) : null;
  }

  getVectorizerByModelId(modelId: number): StoredVectorizer | null {
    const row = this.db
      .prepare(
        `SELECT model_id, vectorizer_key, provider_key, provider_type, model_name, distance_metric, created_at, vector_dimension, is_active
         FROM vectorizers WHERE model_id = ?`,
      )
      .get(modelId) as unknown as VectorizerRow | undefined;
    return row ? rowToVectorizer(row) : null;
  }

  createVectorizer(input: CreateVectorizerInput): StoredVectorizer {
    const createdAt = new Date().toISOString();
    // 空表 → 自动激活;否则按现有激活态(partial UNIQUE 保证单例)。
    const isActive = this.countVectorizers() === 0 ? 1 : 0;
    const result = this.db
      .prepare(
        `INSERT INTO vectorizers (vectorizer_key, provider_key, provider_type, model_name, distance_metric, created_at, vector_dimension, is_active)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        input.vectorizer_key,
        input.provider_key,
        input.provider_type,
        input.model_name,
        input.distance_metric,
        createdAt,
        isActive,
      );
    return {
      model_id: Number(result.lastInsertRowid),
      vectorizer_key: input.vectorizer_key,
      provider_key: input.provider_key,
      provider_type: input.provider_type,
      model_name: input.model_name,
      distance_metric: input.distance_metric,
      created_at: createdAt,
      vector_dimension: null,
      is_active: isActive === 1,
    };
  }

  deleteVectorizer(key: string): { next_active_key: string | null } {
    const existing = this.getVectorizerByKey(key);
    if (!existing) {
      throw new VectorStoreError(`vectorizer 不存在: ${key}`, 404);
    }
    const modelId = existing.model_id;
    this.db.exec("BEGIN");
    try {
      // 1. 清向量(同 model_id 的 vec_chunks_${model_id} + dimension 缓存)
      this.db.exec(`DROP TABLE IF EXISTS ${vecTableName(modelId)}`);
      this.dimensionByModel.delete(modelId);
      // 2. 删 vectorizers 行
      this.db.prepare(`DELETE FROM vectorizers WHERE model_id = ?`).run(modelId);
      // 3. 清旧 active 标记 + 回退到 model_id 最小的剩余项
      this.db.exec(`UPDATE vectorizers SET is_active = 0`);
      const next = this.db
        .prepare(`SELECT vectorizer_key FROM vectorizers ORDER BY model_id ASC LIMIT 1`)
        .get() as unknown as { vectorizer_key: string } | undefined;
      let nextKey: string | null = null;
      if (next) {
        this.db.prepare(`UPDATE vectorizers SET is_active = 1 WHERE vectorizer_key = ?`).run(next.vectorizer_key);
        nextKey = next.vectorizer_key;
      }
      this.db.exec("COMMIT");
      return { next_active_key: nextKey };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  activateVectorizer(key: string): void {
    const existing = this.getVectorizerByKey(key);
    if (!existing) {
      throw new VectorStoreError(`vectorizer 不存在: ${key}`, 404);
    }
    // partial UNIQUE index 保证全局单例;事务原子切换。
    this.db.exec("BEGIN");
    try {
      this.db.exec(`UPDATE vectorizers SET is_active = 0`);
      this.db.prepare(`UPDATE vectorizers SET is_active = 1 WHERE vectorizer_key = ?`).run(key);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listRerankers(): StoredReranker[] {
    const rows = this.db
      .prepare(
        `SELECT reranker_key, mode, provider_key, provider_type, model_name, api_endpoint, api_key, created_at, is_active
         FROM rerankers ORDER BY created_at ASC`,
      )
      .all() as unknown as RerankerRow[];
    return rows.map(rowToReranker);
  }

  getReranker(key: string): StoredReranker | null {
    const row = this.db
      .prepare(
        `SELECT reranker_key, mode, provider_key, provider_type, model_name, api_endpoint, api_key, created_at, is_active
         FROM rerankers WHERE reranker_key = ?`,
      )
      .get(key) as unknown as RerankerRow | undefined;
    return row ? rowToReranker(row) : null;
  }

  createReranker(input: CreateRerankerInput): StoredReranker {
    const createdAt = new Date().toISOString();
    const isActive = this.countRerankers() === 0 ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO rerankers (reranker_key, mode, provider_key, provider_type, model_name, api_endpoint, api_key, created_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.reranker_key,
        input.mode,
        input.provider_key,
        input.provider_type,
        input.model_name,
        input.api_endpoint,
        input.api_key,
        createdAt,
        isActive,
      );
    return { ...input, created_at: createdAt, is_active: isActive === 1 };
  }

  deleteReranker(key: string): { next_active_key: string | null } {
    const existing = this.getReranker(key);
    if (!existing) {
      throw new VectorStoreError(`reranker 不存在: ${key}`, 404);
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM rerankers WHERE reranker_key = ?`).run(key);
      this.db.exec(`UPDATE rerankers SET is_active = 0`);
      const next = this.db
        .prepare(`SELECT reranker_key FROM rerankers ORDER BY created_at ASC LIMIT 1`)
        .get() as unknown as { reranker_key: string } | undefined;
      let nextKey: string | null = null;
      if (next) {
        this.db.prepare(`UPDATE rerankers SET is_active = 1 WHERE reranker_key = ?`).run(next.reranker_key);
        nextKey = next.reranker_key;
      }
      this.db.exec("COMMIT");
      return { next_active_key: nextKey };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  activateReranker(key: string): void {
    const existing = this.getReranker(key);
    if (!existing) {
      throw new VectorStoreError(`reranker 不存在: ${key}`, 404);
    }
    this.db.exec("BEGIN");
    try {
      this.db.exec(`UPDATE rerankers SET is_active = 0`);
      this.db.prepare(`UPDATE rerankers SET is_active = 1 WHERE reranker_key = ?`).run(key);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private countVectorizers(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM vectorizers`).get() as unknown as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  private countRerankers(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM rerankers`).get() as unknown as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  private ensureVecTable(modelId: number, dimension: number): void {
    const existing = this.dimensionByModel.get(modelId);
    if (existing === dimension) {
      return;
    }
    if (existing !== undefined) {
      throw new VectorStoreError(`model_id ${modelId} 维度不一致:已存在 ${existing},本次 ${dimension}`, 400);
    }
    // 缓存未命中:表可能已物理存在但构造期推断漏记(如空表曾被读行推断跳过)。
    // 再次从 DDL 读真实维度——避免 CREATE VIRTUAL TABLE IF NOT EXISTS 对已存在表静默 no-op、
    // 却把脏维度写入缓存、最终绕过本处中文拦截、由 sqlite-vec 抛原生 Dimension mismatch。
    const physical = this.readDimensionFromSchema(modelId);
    if (physical !== null) {
      this.dimensionByModel.set(modelId, physical);
      if (physical !== dimension) {
        throw new VectorStoreError(`model_id ${modelId} 维度不一致:已存在 ${physical},本次 ${dimension}`, 400);
      }
      return;
    }
    this.db.exec(vecTableDdl(modelId, dimension));
    this.dimensionByModel.set(modelId, dimension);
  }

  private loadDimensionsFromSchema(): void {
    // vec0 虚拟表名 vec_chunks_<model_id>;sqlite-vec 另建 *_info/*_chunks/*_rowids/*_vector_chunksNN 影子表,
    // 仅主表严格匹配 vec_chunks_<纯数字>。维度从建表语句 float[N] 提取(不读数据行)——
    // 旧实现 SELECT embedding LIMIT 1 读行,空表返回 null → dimensionByModel 漏记 → ensureVecTable 误判表不存在,
    // CREATE IF NOT EXISTS 静默 no-op 后写入脏维度缓存,最终绕过中文拦截、由 sqlite-vec 抛原生维度错。
    const rows = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_chunks_%'`)
      .all() as unknown as Array<{ name: string }>;
    for (const { name } of rows) {
      const match = name.match(/^vec_chunks_(\d+)$/);
      if (!match) {
        continue; // 影子表跳过
      }
      const modelId = Number(match[1]);
      const dimension = this.readDimensionFromSchema(modelId);
      if (dimension !== null) {
        this.dimensionByModel.set(modelId, dimension);
      }
    }
  }

  /** 从 sqlite_master 的 vec_chunks_<modelId> DDL 提取维度(float[N]);表不存在或无维度声明 → null。 */
  private readDimensionFromSchema(modelId: number): number | null {
    const row = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(vecTableName(modelId)) as unknown as { sql: string | null } | undefined;
    return row?.sql ? inferDimensionFromDdl(row.sql) : null;
  }

  private purgeVecRows(ids: number[]): void {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    for (const modelId of this.dimensionByModel.keys()) {
      this.db
        .prepare(`DELETE FROM ${vecTableName(modelId)} WHERE rowid IN (${placeholders})`)
        .run(...ids.map((id) => BigInt(id)));
    }
  }

  private tableExists(table: string): boolean {
    const row = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table) as unknown as { name: string } | undefined;
    return Boolean(row);
  }

  private countRowsSafe(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  // ====== IKnowledgeFileStore 实现(知识库上传源文件:元数据 + 物理 blob 自包含)======
  getKnowledgeUploadsRoot(): string {
    return this.knowledgeUploadsRoot;
  }

  listKnowledgeFiles(): KnowledgeFile[] {
    const rows = this.db
      .prepare(
        `SELECT id, original_name, stored_name, stored_path, size, mime, uploaded_at FROM kb_files ORDER BY uploaded_at DESC`,
      )
      .all() as unknown as KbFileRow[];
    return rows.map(rowToKnowledgeFile);
  }

  getKnowledgeFile(fileId: string): KnowledgeFile | null {
    const row = this.db
      .prepare(
        `SELECT id, original_name, stored_name, stored_path, size, mime, uploaded_at FROM kb_files WHERE id = ?`,
      )
      .get(fileId) as unknown as KbFileRow | undefined;
    return row ? rowToKnowledgeFile(row) : null;
  }

  addKnowledgeFile(input: AddKnowledgeFileInput): KnowledgeFile {
    const { originalName, buffer, mime } = input;
    const storedName = `${randomBytes(8).toString("hex")}_${sanitizeFilename(originalName)}`;
    const storedPath = path.join(this.knowledgeUploadsRoot, storedName);
    const size = buffer.byteLength;
    // 物理 blob 落盘(收编进 driver:知识库文件唯一持久化载体)
    fs.mkdirSync(this.knowledgeUploadsRoot, { recursive: true });
    fs.writeFileSync(storedPath, buffer);
    const fileId = this.nextKbFileId();
    const now = new Date().toISOString();
    // INSERT 元数据;失败回滚物理文件,不留孤儿 blob
    try {
      this.db
        .prepare(
          `INSERT INTO kb_files (id, original_name, stored_name, stored_path, size, mime, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(fileId, originalName, storedName, storedPath, size, mime, now);
    } catch (err) {
      fs.rmSync(storedPath, { force: true });
      throw err;
    }
    const record = this.getKnowledgeFile(fileId);
    if (!record) {
      // INSERT 成功却读不回(防御):删物理 + DB 行,避免孤儿
      fs.rmSync(storedPath, { force: true });
      this.db.prepare(`DELETE FROM kb_files WHERE id = ?`).run(fileId);
      throw new Error(`failed to read created kb file record: ${fileId}`);
    }
    return record;
  }

  deleteKnowledgeFile(fileId: string): KnowledgeFile | null {
    const record = this.getKnowledgeFile(fileId);
    if (!record) {
      return null;
    }
    this.db.prepare(`DELETE FROM kb_files WHERE id = ?`).run(fileId);
    // 删物理 blob(自包含:知识库 blob 归 driver 管)
    fs.rmSync(record.stored_path, { force: true });
    return record;
  }

  private nextKbFileId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const fileId = randomBytes(5).toString("hex");
      const row = this.db.prepare(`SELECT id FROM kb_files WHERE id = ?`).get(fileId) as
        | { id: string }
        | undefined;
      if (!row) {
        return fileId;
      }
    }
    return randomBytes(8).toString("hex");
  }
}

function parseOptions(config: VectorStoreDriverConfig): SqliteVecOptions {
  const opts = (config.options ?? {}) as Record<string, unknown>;
  return {
    databasePath: typeof opts.database_path === "string" ? opts.database_path : "",
    vectorDimension: typeof opts.vector_dimension === "number" ? opts.vector_dimension : 0,
    distanceMetric: typeof opts.distance_metric === "string" ? opts.distance_metric : "cosine",
  };
}

function resolveDbPath(databasePath: string, dataRoot: string): string {
  const trimmed = databasePath.trim();
  if (trimmed === ":memory:") {
    return ":memory:";
  }
  return trimmed ? path.resolve(trimmed) : path.join(dataRoot, "db", "knowledge.db");
}

/**
 * 旧 vectors.db 检测:Batch A2 改名 knowledge.db 后,遗留文件不会被引用。
 * 启动 warn 提示用户重新配置(用户决策:不做自动迁移)。不删除,避免误操作。
 */
function warnLegacyVectorsDb(dataRoot: string | undefined): void {
  if (!dataRoot?.trim()) {
    return;
  }
  const legacy = path.join(dataRoot, "db", "vectors.db");
  if (fs.existsSync(legacy)) {
    console.warn(
      `[vector-store] 检测到旧 vectors.db(${legacy})。知识库已迁移到 knowledge.db,旧文件不再引用。请重新配置 vectorizer/reranker 并重新索引。`,
    );
  }
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 从 vec0 DDL 提取维度:匹配 `embedding float[N]`,如 `CREATE VIRTUAL TABLE ... USING vec0(embedding float[1536])`。 */
function inferDimensionFromDdl(sql: string): number | null {
  const match = sql.match(/float\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

interface KbFileRow {
  id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  size: number;
  mime: string;
  uploaded_at: string;
}

function rowToKnowledgeFile(row: KbFileRow): KnowledgeFile {
  return {
    id: row.id,
    original_name: row.original_name,
    stored_name: row.stored_name,
    stored_path: row.stored_path,
    size: row.size,
    mime: row.mime,
    uploaded_at: row.uploaded_at,
  };
}

// 模块加载时自注册 sqlite-vec driver(单向依赖 driver→registry,避免循环)。
registerDriver("sqlite_vec", {
  create: (config) => new SqliteVecDriver(config),
});

interface VectorizerRow {
  model_id: number;
  vectorizer_key: string;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  distance_metric: string;
  created_at: string;
  vector_dimension: number | null;
  is_active: number;
}

interface RerankerRow {
  reranker_key: string;
  mode: string;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  api_endpoint: string;
  api_key: string | null;
  created_at: string;
  is_active: number;
}

function rowToVectorizer(row: VectorizerRow): StoredVectorizer {
  return {
    model_id: row.model_id,
    vectorizer_key: row.vectorizer_key,
    provider_key: row.provider_key,
    provider_type: row.provider_type,
    model_name: row.model_name,
    distance_metric: row.distance_metric,
    created_at: row.created_at,
    vector_dimension: row.vector_dimension,
    is_active: row.is_active === 1,
  };
}

function rowToReranker(row: RerankerRow): StoredReranker {
  return {
    reranker_key: row.reranker_key,
    mode: row.mode as "model" | "lexical" | "none",
    provider_key: row.provider_key,
    provider_type: row.provider_type,
    model_name: row.model_name,
    api_endpoint: row.api_endpoint,
    api_key: row.api_key,
    created_at: row.created_at,
    is_active: row.is_active === 1,
  };
}
