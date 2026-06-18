import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { load as loadVec } from "sqlite-vec";

import type {
  CollectionInfo,
  DocumentInfo,
  IVectorStore,
  VectorRecord,
  VectorSearchHit,
  VectorStoreDriverConfig,
  VectorStoreHealth,
  VectorStoreQuery,
} from "../../../contracts/vector-store/index.js";
import { VectorStoreError } from "../../../contracts/vector-store/index.js";
import { registerDriver } from "../registry.js";
import { documentsTableDdl, vecTableDdl, vecTableName } from "./schema.js";

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
export class SqliteVecDriver implements IVectorStore {
  private readonly db: import("node:sqlite").DatabaseSync;
  private readonly dimensionByModel = new Map<number, number>();

  constructor(config: VectorStoreDriverConfig) {
    const options = parseOptions(config);
    const dbPath = resolveDbPath(options.databasePath, config.dataRoot);
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    // allowExtension:true 必须创建时设置(node:sqlite 默认禁用 extension loading 且创建后不可启用)。
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    loadVec(this.db);
    this.db.exec(documentsTableDdl());
    this.loadDimensionsFromSchema();
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

  async countChunks(collection: string): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM vec_documents WHERE collection = ?`)
      .get(collection) as unknown as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async health(): Promise<VectorStoreHealth> {
    const row = this.db
      .prepare(`SELECT COUNT(DISTINCT collection) AS n FROM vec_documents`)
      .get() as unknown as { n: number } | undefined;
    return { status: "healthy", runtime: "sqlite_vec", ann: true, collections_count: row?.n ?? 0 };
  }

  close(): void {
    this.db.close();
  }

  private ensureVecTable(modelId: number, dimension: number): void {
    const existing = this.dimensionByModel.get(modelId);
    if (existing === dimension) {
      return;
    }
    if (existing !== undefined) {
      throw new VectorStoreError(`model_id ${modelId} 维度不一致:已存在 ${existing},本次 ${dimension}`, 400);
    }
    this.db.exec(vecTableDdl(modelId, dimension));
    this.dimensionByModel.set(modelId, dimension);
  }

  private loadDimensionsFromSchema(): void {
    const tables = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_chunks_%'`)
      .all() as unknown as Array<{ name: string }>;
    for (const { name } of tables) {
      const modelId = Number(name.replace("vec_chunks_", ""));
      if (Number.isFinite(modelId)) {
        const dimension = this.inferDimensionFromTable(name);
        if (dimension !== null) {
          this.dimensionByModel.set(modelId, dimension);
        }
      }
    }
  }

  private inferDimensionFromTable(table: string): number | null {
    const row = this.db.prepare(`SELECT embedding FROM ${table} LIMIT 1`).get() as unknown as
      | { embedding: string }
      | undefined;
    if (!row?.embedding) {
      return null;
    }
    const parsed = parseArray(row.embedding);
    return parsed ? parsed.length : null;
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
  return trimmed ? path.resolve(trimmed) : path.join(dataRoot, "db", "vectors.db");
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

function parseArray(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number) : null;
  } catch {
    return null;
  }
}

// 模块加载时自注册 sqlite-vec driver(单向依赖 driver→registry,避免循环)。
registerDriver("sqlite_vec", {
  create: (config) => new SqliteVecDriver(config),
});
