/**
 * sqlite-vec driver 的表结构(DDL 辅助)。
 *
 * 设计:
 * - vec_documents:存 chunk 文本/元数据(共享,跨 model_id),UNIQUE(collection, document_id, chunk_index)
 * - vec_chunks_${model_id}:vec0 虚拟表(per model_id,因 vec0 维度固定),rowid 关联 vec_documents.id
 *
 * 为避免与现有 VectorLibraryService 的 documents/document_vectors 表(共享 ragsystem.db)冲突,
 * 本 driver 用 vec_ 前缀表名。Batch 6 迁移后清理旧表。
 */

export function documentsTableDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS vec_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vec_documents_col_doc_chunk
      ON vec_documents(collection, document_id, chunk_index);
    CREATE INDEX IF NOT EXISTS idx_vec_documents_collection
      ON vec_documents(collection);
  `;
}

/** vec0 虚拟表名(per model_id,维度固定)。 */
export function vecTableName(modelId: number): string {
  return `vec_chunks_${modelId}`;
}

/** 创建某 model_id 的 vec0 表(维度 = 该 model embedding 维度)。幂等。 */
export function vecTableDdl(modelId: number, dimension: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTableName(modelId)} USING vec0(embedding float[${dimension}])`;
}
