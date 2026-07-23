import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { load as loadVec } from "sqlite-vec";

import type {
  AsyncKnowledgeChunk,
  AsyncKnowledgeCollectionSummary,
  AsyncKnowledgeDocumentIndexSummary,
  AsyncKnowledgeDocumentSummary,
  AsyncKnowledgeVectorStore,
  AsyncLexicalSearchHit,
  AsyncLexicalSearchInput,
  AsyncVectorRecord,
  AsyncVectorSearchHit,
  AsyncVectorSearchInput,
} from "../../../contracts/knowledge/async-vector-store.js";
import type { AsyncKnowledgeConfigStore } from "../../../contracts/knowledge/async-knowledge-config.js";
import type { AsyncKnowledgeFileStore } from "../../../contracts/knowledge/async-knowledge-file-store.js";
import type {
  AddKnowledgeFileInput,
  CreateRerankerInput,
  CreateVectorizerInput,
  KnowledgeFile,
  StoredReranker,
  StoredVectorizer,
  VectorStoreDriverConfig,
} from "../../../contracts/vector-store/index.js";
import { VectorStoreError } from "../../../contracts/vector-store/errors.js";
import { registerDriver } from "./registry.js";
import { documentsFtsTableDdl, documentsTableDdl, kbFilesTableDdl, rerankersTableDdl, vecTableDdl, vecTableName, vectorizersTableDdl } from "./schema.js";
import { sanitizeFilename } from "../../../utils/file-filter.js";
import { metadataMatchesFilter } from "../../../services/vector-store/metadata-filter.js";
import { tokenize } from "../../../services/vector-store/scoring.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const SEARCH_OVERFETCH = 5;
const DEFAULT_RECALL = 50;
const SQLITE_IN_BATCH = 500;

interface SqliteVecOptions {
  databasePath: string;
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
 * Local sqlite-vec knowledge driver: implements tenant-scoped Async knowledge ports directly.
 *
 * Local deployments are single-tenant per process; tenant_id is accepted for port parity and
 * ignored for storage isolation (one knowledge.db per tenant runtime already).
 *
 * Dimensions: each model_id owns a vec0 table (vec_chunks_${model_id}); first upsert pins
 * embedding.length. Search returns vector_score only; hybrid/rerank stay in the application layer.
 */
export class SqliteVecDriver implements AsyncKnowledgeVectorStore, AsyncKnowledgeConfigStore, AsyncKnowledgeFileStore {
  private readonly db: import("node:sqlite").DatabaseSync;
  private readonly dimensionByModel = new Map<number, number>();
  private readonly knowledgeUploadsRoot: string;
  private readonly knowledgeMarkdownRoot: string;
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
      : path.join(config.dataRoot, "db", "knowledge-uploads");
    this.knowledgeMarkdownRoot = this.dbIsMemory
      ? fs.mkdtempSync(path.join(os.tmpdir(), "rag-kb-markdown-"))
      : path.join(config.dataRoot, "db", "knowledge-md");
    // allowExtension:true 必须创建时设置(node:sqlite 默认禁用 extension loading 且创建后不可启用)。
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    loadVec(this.db);
    this.db.exec(documentsTableDdl());
    this.db.exec(documentsFtsTableDdl());
    this.ensureFtsIndex();
    this.db.exec(kbFilesTableDdl());
    this.ensureKnowledgeFileMarkdownColumn();
    this.db.exec(vectorizersTableDdl());
    this.db.exec(rerankersTableDdl());
    this.loadDimensionsFromSchema();
    warnLegacyVectorsDb(config.dataRoot);
  }

  async upsertChunks(records: AsyncVectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const dimensionsBefore = new Map(this.dimensionByModel);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.upsertRecordsSync(records);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.restoreDimensionCache(dimensionsBefore);
      throw error;
    }
  }

  async replaceChunks(input: {
    tenant_id: string;
    collection: string;
    document_id: string;
    model_id: number;
    records: AsyncVectorRecord[];
  }): Promise<void> {
    if (input.records.some((record) =>
      record.tenant_id !== input.tenant_id
      || record.collection !== input.collection
      || record.document_id !== input.document_id
      || record.model_id !== input.model_id
    )) {
      throw new VectorStoreError("replacement chunks must match their tenant, collection, document, and model scope", 400);
    }
    const dimensionsBefore = new Map(this.dimensionByModel);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.dimensionByModel.has(input.model_id)) {
        const ids = this.db
          .prepare("SELECT id FROM vec_documents WHERE collection = ? AND document_id = ?")
          .all(input.collection, input.document_id) as unknown as Array<{ id: number }>;
        if (ids.length > 0) {
          const placeholders = ids.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM ${vecTableName(input.model_id)} WHERE rowid IN (${placeholders})`)
            .run(...ids.map((row) => BigInt(row.id)));
        }
      }
      this.upsertRecordsSync(input.records);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.restoreDimensionCache(dimensionsBefore);
      throw error;
    }
  }

  private restoreDimensionCache(snapshot: ReadonlyMap<number, number>): void {
    this.dimensionByModel.clear();
    for (const [modelId, dimension] of snapshot) this.dimensionByModel.set(modelId, dimension);
  }

  private upsertRecordsSync(records: AsyncVectorRecord[]): void {
    if (records.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    const insertDoc = this.db.prepare(
      `INSERT INTO vec_documents (collection, document_id, chunk_index, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // Shared chunk text rows are keyed by (collection, document_id, chunk_index) across models.
    const findDoc = this.db.prepare(
      `SELECT id FROM vec_documents WHERE collection = ? AND document_id = ? AND chunk_index = ?`,
    );
    const updateDoc = this.db.prepare(`UPDATE vec_documents SET content = ?, metadata = ? WHERE id = ?`);
    for (const record of records) {
      this.ensureVecTable(record.model_id, record.embedding.length);
      const existing = findDoc.get(record.collection, record.document_id, record.chunk_index) as
        | { id: number }
        | undefined;
      let rowid: number;
      if (existing) {
        rowid = Number(existing.id);
        updateDoc.run(record.content, JSON.stringify(record.metadata ?? {}), rowid);
      } else {
        const result = insertDoc.run(
          record.collection,
          record.document_id,
          record.chunk_index,
          record.content,
          JSON.stringify(record.metadata ?? {}),
          now,
        );
        rowid = Number(result.lastInsertRowid);
      }
      this.upsertFtsRow(rowid, record.content);
      const table = vecTableName(record.model_id);
      this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(rowid));
      this.db.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`).run(
        BigInt(rowid),
        JSON.stringify(record.embedding),
      );
    }
  }

  async search(input: AsyncVectorSearchInput): Promise<AsyncVectorSearchHit[]> {
    if (!this.dimensionByModel.has(input.model_id)) {
      return [];
    }
    const table = vecTableName(input.model_id);
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
    const total = Number(totalRow?.n ?? 0);
    if (total === 0) return [];

    let recall = Math.min(total, Math.max(input.top_k * SEARCH_OVERFETCH, DEFAULT_RECALL));
    while (recall > 0) {
      const knnRows = this.db
        .prepare(`SELECT rowid, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ${recall}`)
        .all(JSON.stringify(input.query_vector)) as unknown as KnnRow[];
      if (knnRows.length === 0) return [];

      const rowids = knnRows.map((row) => row.rowid);
      const docs: Array<VecDocRow & { chunk_index: number }> = [];
      for (let start = 0; start < rowids.length; start += SQLITE_IN_BATCH) {
        const batch = rowids.slice(start, start + SQLITE_IN_BATCH);
        const placeholders = batch.map(() => "?").join(",");
        docs.push(...this.db
          .prepare(
            `SELECT id, document_id, collection, content, metadata, chunk_index
             FROM vec_documents WHERE id IN (${placeholders})`,
          )
          .all(...batch.map((id) => BigInt(id))) as unknown as Array<VecDocRow & { chunk_index: number }>);
      }
      const docById = new Map(docs.map((doc) => [doc.id, doc]));
      const hits: AsyncVectorSearchHit[] = [];
      for (const knn of knnRows) {
        const doc = docById.get(knn.rowid);
        if (!doc || (input.collection !== undefined && doc.collection !== input.collection)) continue;
        const metadata = parseRecord(doc.metadata);
        if (!metadataMatchesFilter(metadata, input.filters)) continue;
        hits.push({
          id: String(knn.rowid),
          tenant_id: input.tenant_id,
          collection: doc.collection,
          document_id: doc.document_id,
          model_id: input.model_id,
          chunk_index: doc.chunk_index,
          content: doc.content,
          metadata,
          vector_score: Math.max(0, 1 - knn.distance),
        });
        if (hits.length >= input.top_k) return hits;
      }

      if (recall >= total) return hits;
      recall = Math.min(total, recall * 2);
    }
    return [];
  }

  async lexicalSearch(input: AsyncLexicalSearchInput): Promise<AsyncLexicalSearchHit[]> {
    if (!this.dimensionByModel.has(input.model_id)) return [];
    const ftsQuery = sqliteFtsQuery(input.query);
    if (!ftsQuery) return [];
    const table = vecTableName(input.model_id);
    const collectionPredicate = input.collection === undefined ? "" : " AND d.collection = ?";
    const params = input.collection === undefined ? [ftsQuery] : [ftsQuery, input.collection];
    const countRow = this.db.prepare(
      `SELECT COUNT(*) AS n
       FROM vec_documents_fts
       JOIN vec_documents d ON d.id = vec_documents_fts.rowid
       JOIN ${table} v ON v.rowid = d.id
       WHERE vec_documents_fts MATCH ?${collectionPredicate}`,
    ).get(...params) as unknown as { n: number } | undefined;
    const total = Number(countRow?.n ?? 0);
    if (total === 0) return [];

    let recall = Math.min(total, Math.max(input.top_k * SEARCH_OVERFETCH, DEFAULT_RECALL));
    while (recall > 0) {
      const rows = this.db.prepare(
        `SELECT d.id, d.document_id, d.collection, d.content, d.metadata, d.chunk_index,
                bm25(vec_documents_fts) AS bm25_rank
         FROM vec_documents_fts
         JOIN vec_documents d ON d.id = vec_documents_fts.rowid
         JOIN ${table} v ON v.rowid = d.id
         WHERE vec_documents_fts MATCH ?${collectionPredicate}
         ORDER BY bm25_rank ASC
         LIMIT ${recall}`,
      ).all(...params) as unknown as Array<VecDocRow & { chunk_index: number; bm25_rank: number }>;
      const filtered = rows.flatMap((row) => {
        const metadata = parseRecord(row.metadata);
        return metadataMatchesFilter(metadata, input.filters) ? [{ row, metadata }] : [];
      });
      if (filtered.length >= input.top_k || recall >= total) {
        const selected = filtered.slice(0, input.top_k);
        const rawScores = selected.map(({ row }) => Math.max(0, -Number(row.bm25_rank)));
        const maximum = Math.max(0, ...rawScores);
        return selected.map(({ row, metadata }, index) => ({
          id: String(row.id),
          tenant_id: input.tenant_id,
          collection: row.collection,
          document_id: row.document_id,
          model_id: input.model_id,
          chunk_index: row.chunk_index,
          content: row.content,
          metadata,
          keyword_score: maximum > 0 ? (rawScores[index] ?? 0) / maximum : 0,
        }));
      }
      recall = Math.min(total, recall * 2);
    }
    return [];
  }

  async listCollections(_tenantId: string): Promise<AsyncKnowledgeCollectionSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT collection, COUNT(*) AS total_chunks, COUNT(DISTINCT document_id) AS document_count
         FROM vec_documents GROUP BY collection ORDER BY collection`,
      )
      .all() as unknown as Array<{ collection: string; total_chunks: number; document_count: number }>;
    const defaultDimension = this.dimensionByModel.values().next().value ?? null;
    return rows.map((row) => ({
      name: row.collection,
      document_count: row.document_count,
      chunk_count: row.total_chunks,
      total_chunks: row.total_chunks,
      embedding_dimension: defaultDimension,
    }));
  }

  async listDocumentIndexes(_tenantId: string): Promise<AsyncKnowledgeDocumentIndexSummary[]> {
    const documents = await this.listAllDocuments(_tenantId);
    const vectorizers = await this.listVectorizers(_tenantId);
    const indexes = await Promise.all(documents.flatMap((document) => vectorizers.map(async (vectorizer) => ({
      collection: document.collection,
      document_id: document.document_id,
      model_id: vectorizer.model_id,
      chunk_count: await this.countVectorsForDocument({
        tenant_id: _tenantId,
        collection: document.collection,
        document_id: document.document_id,
        model_id: vectorizer.model_id,
      }),
    }))));
    return indexes.filter((index) => index.chunk_count > 0);
  }

  async listChunks(input: {
    tenant_id: string;
    collection?: string;
    document_id?: string;
    model_id?: number;
  }): Promise<AsyncKnowledgeChunk[]> {
    const sql = input.collection
      ? `SELECT id, collection, document_id, chunk_index, content, metadata FROM vec_documents WHERE collection = ? ORDER BY collection, document_id, chunk_index`
      : `SELECT id, collection, document_id, chunk_index, content, metadata FROM vec_documents ORDER BY collection, document_id, chunk_index`;
    let rows = (input.collection
      ? this.db.prepare(sql).all(input.collection)
      : this.db.prepare(sql).all()) as unknown as Array<{
      id: number;
      collection: string;
      document_id: string;
      chunk_index: number;
      content: string;
      metadata: string;
    }>;
    if (input.document_id !== undefined) {
      rows = rows.filter((row) => row.document_id === input.document_id);
    }

    if (input.model_id !== undefined) {
      const indexed = await this.indexedDocumentKeys(rows, input.model_id);
      return rows
        .filter((row) => indexed.has(documentKey(row)))
        .map((row) => this.mapChunk(row, input.tenant_id, input.model_id!));
    }

    const projected = await this.projectedModelsByDocument(rows);
    return rows.map((row) => this.mapChunk(row, input.tenant_id, projected.get(documentKey(row)) ?? 0));
  }

  async getChunk(tenantId: string, chunkId: string): Promise<AsyncKnowledgeChunk | null> {
    const asNumber = Number(chunkId);
    if (!Number.isSafeInteger(asNumber) || String(asNumber) !== chunkId) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT id, collection, document_id, chunk_index, content, metadata FROM vec_documents WHERE id = ?`,
      )
      .get(asNumber) as unknown as {
      id: number;
      collection: string;
      document_id: string;
      chunk_index: number;
      content: string;
      metadata: string;
    } | undefined;
    // Opaque ids are the decimal string of the integer primary key — reject padded forms.
    if (!row || String(row.id) !== chunkId) return null;
    const [modelId] = await this.modelIdsForDocument(row.collection, row.document_id);
    return this.mapChunk(row, tenantId, modelId ?? 0);
  }

  async listChunkVersions(tenantId: string, chunkId: string): Promise<AsyncKnowledgeChunk[]> {
    const target = await this.getChunk(tenantId, chunkId);
    if (!target) return [];
    const modelIds = await this.modelIdsForDocument(target.collection, target.document_id);
    return modelIds.map((modelId) => ({ ...target, model_id: modelId }));
  }

  async listDocuments(input: { tenant_id: string; collection: string }): Promise<AsyncKnowledgeDocumentSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT document_id, COUNT(*) AS chunk_count, MIN(metadata) AS metadata
         FROM vec_documents WHERE collection = ? GROUP BY document_id ORDER BY document_id`,
      )
      .all(input.collection) as unknown as Array<{ document_id: string; chunk_count: number; metadata: string | null }>;
    return rows.map((row) => ({
      collection: input.collection,
      document_id: row.document_id,
      chunk_count: row.chunk_count,
      metadata: row.metadata ? parseRecord(row.metadata) : null,
    }));
  }

  async listAllDocuments(_tenantId: string): Promise<AsyncKnowledgeDocumentSummary[]> {
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

  async countVectors(input: { tenant_id: string; collection: string; model_id: number }): Promise<number> {
    const table = vecTableName(input.model_id);
    if (!this.tableExists(table)) return 0;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} v JOIN vec_documents d ON d.id = v.rowid WHERE d.collection = ?`)
      .get(input.collection) as unknown as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async countVectorsByModel(input: { tenant_id: string; model_id: number }): Promise<Array<{ collection: string; count: number }>> {
    const table = vecTableName(input.model_id);
    if (!this.tableExists(table)) return [];
    return this.db
      .prepare(`SELECT d.collection, COUNT(*) AS count FROM ${table} v JOIN vec_documents d ON d.id = v.rowid GROUP BY d.collection`)
      .all() as unknown as Array<{ collection: string; count: number }>;
  }

  async countVectorsForDocument(input: {
    tenant_id: string;
    collection: string;
    document_id: string;
    model_id: number;
  }): Promise<number> {
    const table = vecTableName(input.model_id);
    if (!this.tableExists(table)) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table} v JOIN vec_documents d ON d.id = v.rowid WHERE d.collection = ? AND d.document_id = ?`,
      )
      .get(input.collection, input.document_id) as unknown as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async countChunks(input: { tenant_id: string; collection: string }): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM vec_documents WHERE collection = ?`)
      .get(input.collection) as unknown as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async getDimension(input: { tenant_id: string; model_id: number }): Promise<number | null> {
    return this.dimensionByModel.get(input.model_id) ?? null;
  }

  async health(_tenantId: string): Promise<{ status: string; runtime: string; ann: boolean; collections_count: number }> {
    const row = this.db
      .prepare(`SELECT COUNT(DISTINCT collection) AS n FROM vec_documents`)
      .get() as unknown as { n: number } | undefined;
    return { status: "healthy", runtime: "sqlite_vec", ann: true, collections_count: row?.n ?? 0 };
  }

  async deleteChunks(input: {
    tenant_id: string;
    collection?: string;
    document_id?: string;
    model_id?: number;
  }): Promise<number> {
    if (input.model_id !== undefined) {
      if (input.document_id !== undefined) {
        const collections = input.collection === undefined
          ? unique((await this.listAllDocuments(input.tenant_id))
            .filter((document) => document.document_id === input.document_id)
            .map((document) => document.collection))
          : [input.collection];
        let deleted = 0;
        for (const collection of collections) {
          deleted += this.deleteDocumentVectorsByModelSync(collection, input.document_id, input.model_id);
        }
        return deleted;
      }
      if (input.collection !== undefined) {
        const documents = await this.listDocuments({ tenant_id: input.tenant_id, collection: input.collection });
        let deleted = 0;
        for (const document of documents) {
          deleted += this.deleteDocumentVectorsByModelSync(input.collection, document.document_id, input.model_id);
        }
        return deleted;
      }
      return this.deleteByModelSync(input.model_id);
    }

    if (input.document_id !== undefined) {
      if (input.collection === undefined) {
        return this.deleteDocumentVectorsSync(input.document_id);
      }
      return this.deleteDocumentSync(input.collection, input.document_id);
    }
    if (input.collection !== undefined) {
      return this.deleteCollectionSync(input.collection);
    }

    const collections = await this.listCollections(input.tenant_id);
    let deleted = 0;
    for (const collection of collections) {
      deleted += this.deleteCollectionSync(collection.name);
    }
    return deleted;
  }

  async deleteCollection(input: { tenant_id: string; collection: string }): Promise<number> {
    return this.deleteCollectionSync(input.collection);
  }

  private deleteDocumentSync(collection: string, documentId: string): number {
    const ids = this.db
      .prepare(`SELECT id FROM vec_documents WHERE collection = ? AND document_id = ?`)
      .all(collection, documentId) as unknown as Array<{ id: number }>;
    if (ids.length === 0) return 0;
    this.purgeVecRows(ids.map((row) => row.id));
    this.deleteFtsRows(ids.map((row) => row.id));
    this.db.prepare(`DELETE FROM vec_documents WHERE collection = ? AND document_id = ?`).run(collection, documentId);
    return ids.length;
  }

  private deleteDocumentVectorsSync(documentId: string): number {
    const ids = this.db
      .prepare(`SELECT id FROM vec_documents WHERE document_id = ?`)
      .all(documentId) as unknown as Array<{ id: number }>;
    if (ids.length === 0) return 0;
    this.purgeVecRows(ids.map((row) => row.id));
    this.deleteFtsRows(ids.map((row) => row.id));
    this.db.prepare(`DELETE FROM vec_documents WHERE document_id = ?`).run(documentId);
    return ids.length;
  }

  private deleteDocumentVectorsByModelSync(collection: string, documentId: string, modelId: number): number {
    if (!this.dimensionByModel.has(modelId)) return 0;
    const ids = this.db
      .prepare(`SELECT id FROM vec_documents WHERE collection = ? AND document_id = ?`)
      .all(collection, documentId) as unknown as Array<{ id: number }>;
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = this.db
      .prepare(`DELETE FROM ${vecTableName(modelId)} WHERE rowid IN (${placeholders})`)
      .run(...ids.map((row) => BigInt(row.id)));
    return Number(result.changes);
  }

  private deleteCollectionSync(collection: string): number {
    const ids = this.db
      .prepare(`SELECT id FROM vec_documents WHERE collection = ?`)
      .all(collection) as unknown as Array<{ id: number }>;
    this.purgeVecRows(ids.map((row) => row.id));
    this.deleteFtsRows(ids.map((row) => row.id));
    this.db.prepare(`DELETE FROM vec_documents WHERE collection = ?`).run(collection);
    return ids.length;
  }

  private deleteByModelSync(modelId: number): number {
    const table = vecTableName(modelId);
    if (!this.tableExists(table)) return 0;
    const count = this.countRowsSafe(table);
    this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    this.dimensionByModel.delete(modelId);
    return count;
  }

  private async indexedDocumentKeys(
    chunks: Array<{ collection: string; document_id: string }>,
    modelId: number,
  ): Promise<Set<string>> {
    const documents = uniqueDocuments(chunks);
    const counts = await Promise.all(documents.map((document) =>
      this.countVectorsForDocument({
        tenant_id: "",
        collection: document.collection,
        document_id: document.document_id,
        model_id: modelId,
      })
    ));
    return new Set(documents.filter((_document, index) => (counts[index] ?? 0) > 0).map(documentKey));
  }

  private async projectedModelsByDocument(
    chunks: Array<{ collection: string; document_id: string }>,
  ): Promise<Map<string, number>> {
    const documents = uniqueDocuments(chunks);
    const models = await Promise.all(documents.map(async (document) => {
      const [modelId] = await this.modelIdsForDocument(document.collection, document.document_id);
      return modelId;
    }));
    return new Map(documents.flatMap((document, index) => {
      const modelId = models[index];
      return modelId === undefined ? [] : [[documentKey(document), modelId]];
    }));
  }

  private async modelIdsForDocument(collection: string, documentId: string): Promise<number[]> {
    const vectorizers = await this.listVectorizers("");
    const counts = await Promise.all(vectorizers.map((vectorizer) =>
      this.countVectorsForDocument({
        tenant_id: "",
        collection,
        document_id: documentId,
        model_id: vectorizer.model_id,
      })
    ));
    return vectorizers
      .filter((_vectorizer, index) => (counts[index] ?? 0) > 0)
      .map((vectorizer) => vectorizer.model_id);
  }

  private mapChunk(
    chunk: { id: number; collection: string; document_id: string; chunk_index: number; content: string; metadata: string | Record<string, unknown> },
    tenantId: string,
    modelId: number,
  ): AsyncKnowledgeChunk {
    return {
      id: String(chunk.id),
      tenant_id: tenantId,
      collection: chunk.collection,
      document_id: chunk.document_id,
      model_id: modelId,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      metadata: typeof chunk.metadata === "string" ? parseRecord(chunk.metadata) : chunk.metadata,
    };
  }

  close(): void {
    try {
      this.db.close();
    } finally {
      if (this.dbIsMemory && this.knowledgeUploadsRoot.startsWith(os.tmpdir())) {
        fs.rmSync(this.knowledgeUploadsRoot, { recursive: true, force: true });
        fs.rmSync(this.knowledgeMarkdownRoot, { recursive: true, force: true });
      }
    }
  }

  // ====== AsyncKnowledgeConfigStore ======

  async listVectorizers(_tenantId: string): Promise<StoredVectorizer[]> {
    const rows = this.db
      .prepare(
        `SELECT model_id, vectorizer_key, provider_key, provider_type, model_name, distance_metric, created_at, vector_dimension, is_active
         FROM vectorizers ORDER BY model_id ASC`,
      )
      .all() as unknown as VectorizerRow[];
    return rows.map(rowToVectorizer);
  }

  async getVectorizerByKey(_tenantId: string, key: string): Promise<StoredVectorizer | null> {
    const row = this.db
      .prepare(
        `SELECT model_id, vectorizer_key, provider_key, provider_type, model_name, distance_metric, created_at, vector_dimension, is_active
         FROM vectorizers WHERE vectorizer_key = ?`,
      )
      .get(key) as unknown as VectorizerRow | undefined;
    return row ? rowToVectorizer(row) : null;
  }


  async createVectorizer(_tenantId: string, input: CreateVectorizerInput): Promise<StoredVectorizer> {
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

  async setVectorDimension(_tenantId: string, key: string, dimension: number): Promise<void> {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new VectorStoreError("vector dimension must be a positive integer", 400);
    }
    const existing = await this.getVectorizerByKey(_tenantId, key);
    if (!existing) {
      throw new VectorStoreError(`vectorizer not found: ${key}`, 404);
    }
    if (existing.vector_dimension !== null && existing.vector_dimension !== dimension) {
      throw new VectorStoreError(`vectorizer dimension mismatch: ${key}`, 400);
    }
    if (existing.vector_dimension === dimension) return;
    this.db.prepare(`UPDATE vectorizers SET vector_dimension = ? WHERE vectorizer_key = ?`).run(dimension, key);
  }

  async deleteVectorizer(_tenantId: string, key: string): Promise<{ next_active_key: string | null }> {
    const existing = await this.getVectorizerByKey(_tenantId, key);
    if (!existing) {
      throw new VectorStoreError(`vectorizer 不存在: ${key}`, 404);
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM vectorizers WHERE model_id = ?`).run(existing.model_id);
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

  async activateVectorizer(_tenantId: string, key: string): Promise<void> {
    const existing = await this.getVectorizerByKey(_tenantId, key);
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

  async listRerankers(_tenantId: string): Promise<StoredReranker[]> {
    const rows = this.db
      .prepare(
        `SELECT reranker_key, mode, provider_key, provider_type, model_name, api_endpoint, api_key, created_at, is_active
         FROM rerankers ORDER BY created_at ASC`,
      )
      .all() as unknown as RerankerRow[];
    return rows.map(rowToReranker);
  }

  async getReranker(_tenantId: string, key: string): Promise<StoredReranker | null> {
    const row = this.db
      .prepare(
        `SELECT reranker_key, mode, provider_key, provider_type, model_name, api_endpoint, api_key, created_at, is_active
         FROM rerankers WHERE reranker_key = ?`,
      )
      .get(key) as unknown as RerankerRow | undefined;
    return row ? rowToReranker(row) : null;
  }

  async createReranker(_tenantId: string, input: CreateRerankerInput): Promise<StoredReranker> {
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

  async deleteReranker(_tenantId: string, key: string): Promise<{ next_active_key: string | null }> {
    const existing = await this.getReranker(_tenantId, key);
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

  async activateReranker(_tenantId: string, key: string): Promise<void> {
    const existing = await this.getReranker(_tenantId, key);
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
    const physical = this.readVecTableSchema(modelId);
    if (physical) {
      if (physical.dimension === null || physical.distanceMetric !== "cosine") {
        this.dropIncompatibleVecTable(modelId, physical);
      } else {
        this.dimensionByModel.set(modelId, physical.dimension);
        if (physical.dimension !== dimension) {
          throw new VectorStoreError(`model_id ${modelId} 维度不一致:已存在 ${physical.dimension},本次 ${dimension}`, 400);
        }
        return;
      }
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
      const schema = this.readVecTableSchema(modelId);
      if (!schema) continue;
      if (schema.dimension === null || schema.distanceMetric !== "cosine") {
        this.dropIncompatibleVecTable(modelId, schema);
        continue;
      }
      this.dimensionByModel.set(modelId, schema.dimension);
    }
  }

  private readVecTableSchema(modelId: number): {
    dimension: number | null;
    distanceMetric: string | null;
  } | null {
    const row = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(vecTableName(modelId)) as unknown as { sql: string | null } | undefined;
    if (!row?.sql) return null;
    return {
      dimension: inferDimensionFromDdl(row.sql),
      distanceMetric: inferDistanceMetricFromDdl(row.sql),
    };
  }

  private dropIncompatibleVecTable(
    modelId: number,
    schema: { dimension: number | null; distanceMetric: string | null },
  ): void {
    this.db.exec(`DROP TABLE IF EXISTS ${vecTableName(modelId)}`);
    this.db.prepare(`UPDATE vectorizers SET vector_dimension = NULL WHERE model_id = ?`).run(modelId);
    this.dimensionByModel.delete(modelId);
    console.warn(
      `[vector-store] 已删除不兼容的 model_id=${modelId} 向量索引`
      + `（dimension=${schema.dimension ?? "unknown"}, distance_metric=${schema.distanceMetric ?? "l2(default)"}），请重新索引。`,
    );
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

  private ensureFtsIndex(): void {
    const documents = this.db.prepare("SELECT id, content FROM vec_documents ORDER BY id")
      .all() as unknown as Array<{ id: number; content: string }>;
    const indexed = Number((this.db.prepare("SELECT COUNT(*) AS n FROM vec_documents_fts").get() as { n: number } | undefined)?.n ?? 0);
    if (indexed === documents.length) return;
    this.db.exec("DELETE FROM vec_documents_fts");
    const insert = this.db.prepare("INSERT INTO vec_documents_fts(rowid, search_terms) VALUES (?, ?)");
    for (const document of documents) insert.run(BigInt(document.id), lexicalTermsText(document.content));
  }

  private upsertFtsRow(rowid: number, content: string): void {
    this.db.prepare("DELETE FROM vec_documents_fts WHERE rowid = ?").run(BigInt(rowid));
    this.db.prepare("INSERT INTO vec_documents_fts(rowid, search_terms) VALUES (?, ?)")
      .run(BigInt(rowid), lexicalTermsText(content));
  }

  private deleteFtsRows(ids: number[]): void {
    if (ids.length === 0) return;
    for (let start = 0; start < ids.length; start += SQLITE_IN_BATCH) {
      const batch = ids.slice(start, start + SQLITE_IN_BATCH);
      const placeholders = batch.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM vec_documents_fts WHERE rowid IN (${placeholders})`)
        .run(...batch.map((id) => BigInt(id)));
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

  // ====== AsyncKnowledgeFileStore ======
  getKnowledgeUploadsRoot(): string {
    return this.knowledgeUploadsRoot;
  }

  async listKnowledgeFiles(): Promise<KnowledgeFile[]> {
    const rows = this.db
      .prepare(
        `SELECT id, original_name, stored_name, stored_path, size, mime, uploaded_at, md_blob_hash FROM kb_files ORDER BY uploaded_at DESC`,
      )
      .all() as unknown as KbFileRow[];
    return rows.map(rowToKnowledgeFile);
  }

  async getKnowledgeFile(fileId: string): Promise<KnowledgeFile | null> {
    const row = this.db
      .prepare(
        `SELECT id, original_name, stored_name, stored_path, size, mime, uploaded_at, md_blob_hash FROM kb_files WHERE id = ?`,
      )
      .get(fileId) as unknown as KbFileRow | undefined;
    return row ? rowToKnowledgeFile(row) : null;
  }

  async addKnowledgeFile(input: AddKnowledgeFileInput): Promise<KnowledgeFile> {
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
    const record = await this.getKnowledgeFile(fileId);
    if (!record) {
      // INSERT 成功却读不回(防御):删物理 + DB 行,避免孤儿
      fs.rmSync(storedPath, { force: true });
      this.db.prepare(`DELETE FROM kb_files WHERE id = ?`).run(fileId);
      throw new Error(`failed to read created kb file record: ${fileId}`);
    }
    return record;
  }

  async deleteKnowledgeFile(fileId: string): Promise<KnowledgeFile | null> {
    const record = await this.getKnowledgeFile(fileId);
    if (!record) {
      return null;
    }
    this.db.prepare(`DELETE FROM kb_files WHERE id = ?`).run(fileId);
    // 删物理 blob(自包含:知识库 blob 归 driver 管)
    fs.rmSync(record.stored_path, { force: true });
    return record;
  }

  async putKnowledgeMarkdown(fileId: string, markdown: string): Promise<{ md_blob_hash: string }> {
    const mdBlobHash = createHash("sha256").update(markdown, "utf8").digest("hex");
    const directory = path.join(this.knowledgeMarkdownRoot, mdBlobHash.slice(0, 2));
    const target = path.join(directory, mdBlobHash);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, markdown, "utf8");
    const result = this.db.prepare(`UPDATE kb_files SET md_blob_hash = ? WHERE id = ?`).run(mdBlobHash, fileId);
    if (result.changes === 0) throw new Error(`知识库文件不存在: ${fileId}`);
    return { md_blob_hash: mdBlobHash };
  }

  async readKnowledgeMarkdown(mdBlobHash: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(mdBlobHash)) throw new Error("无效的 Markdown blob hash");
    return fs.readFileSync(path.join(this.knowledgeMarkdownRoot, mdBlobHash.slice(0, 2), mdBlobHash), "utf8");
  }


  async getSource(fileId: string): Promise<{ body: Uint8Array; contentType: string | null } | null> {
    const file = await this.getKnowledgeFile(fileId);
    if (!file) return null;

    const uploadsRoot = path.resolve(this.knowledgeUploadsRoot);
    const storedPath = path.resolve(file.stored_path);
    if (!isPathWithin(storedPath, uploadsRoot)) return null;

    try {
      const realRoot = fs.realpathSync(uploadsRoot);
      const realStoredPath = fs.realpathSync(storedPath);
      if (!isPathWithin(realStoredPath, realRoot)) return null;
      const stat = fs.statSync(realStoredPath);
      if (!stat.isFile()) return null;
      return {
        body: fs.readFileSync(realStoredPath),
        contentType: file.mime || null,
      };
    } catch (error) {
      if (isMissingOrInvalidPath(error)) return null;
      throw error;
    }
  }

  private ensureKnowledgeFileMarkdownColumn(): void {
    const columns = this.db.prepare(`PRAGMA table_info(kb_files)`).all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "md_blob_hash")) {
      this.db.exec(`ALTER TABLE kb_files ADD COLUMN md_blob_hash TEXT`);
    }
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
function warnLegacyVectorsDb(dataRoot: string): void {
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

function lexicalTermsText(content: string): string {
  return tokenize(content).join(" ");
}

function sqliteFtsQuery(query: string): string {
  return unique(tokenize(query))
    .slice(0, 64)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

/** 从 vec0 DDL 提取维度:匹配 `embedding float[N]`,如 `CREATE VIRTUAL TABLE ... USING vec0(embedding float[1536])`。 */
function inferDimensionFromDdl(sql: string): number | null {
  const match = sql.match(/float\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function inferDistanceMetricFromDdl(sql: string): string | null {
  const match = sql.match(/\bdistance_metric\s*=\s*["']?([a-z0-9_]+)["']?/i);
  return match?.[1]?.toLowerCase() ?? null;
}

interface KbFileRow {
  id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  size: number;
  mime: string;
  uploaded_at: string;
  md_blob_hash: string | null;
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
    md_blob_hash: row.md_blob_hash,
  };
}


function documentKey(document: { collection: string; document_id: string }): string {
  return `${document.collection}` + String.fromCharCode(0) + `${document.document_id}`;
}

function uniqueDocuments(chunks: Array<{ collection: string; document_id: string }>): Array<{ collection: string; document_id: string }> {
  const documents = new Map<string, { collection: string; document_id: string }>();
  for (const chunk of chunks) documents.set(documentKey(chunk), { collection: chunk.collection, document_id: chunk.document_id });
  return [...documents.values()];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingOrInvalidPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
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
