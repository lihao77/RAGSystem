/**
 * Local sqlite-vec adapter table definitions.
 *
 * 设计:
 * - vec_documents:存 chunk 文本/元数据(共享,跨 model_id),UNIQUE(collection, document_id, chunk_index)
 * - vec_chunks_${model_id}:vec0 虚拟表(per model_id,因 vec0 维度固定),rowid 关联 vec_documents.id
 * - vectorizers/rerankers:配置面下沉(AsyncKnowledgeConfigStore),is_active 列替 vector_settings KV + 内存副本
 *
 * 本 driver 用 vec_ 前缀表名，与主库业务表隔离。
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

/**
 * vectorizers 配置表(下沉 driver 库,替主库同名表 + vector_settings KV + 内存 activeVectorizerKey)。
 * is_active partial UNIQUE index 保证全局单例;vector_dimension 占位 null,首次 index 后由 driver 回写。
 */
export function vectorizersTableDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS vectorizers (
      model_id INTEGER PRIMARY KEY AUTOINCREMENT,
      vectorizer_key TEXT NOT NULL UNIQUE,
      provider_key TEXT NOT NULL,
      provider_type TEXT,
      model_name TEXT NOT NULL,
      distance_metric TEXT NOT NULL,
      created_at TEXT NOT NULL,
      vector_dimension INTEGER,
      is_active INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vectorizers_active ON vectorizers(is_active) WHERE is_active = 1;
  `;
}

/** rerankers 配置表(api_key 仅落 DB,不入任何 YAML);is_active partial UNIQUE 保证全局单例。 */
export function rerankersTableDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS rerankers (
      reranker_key TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      provider_type TEXT,
      model_name TEXT NOT NULL,
      api_endpoint TEXT NOT NULL,
      api_key TEXT,
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rerankers_active ON rerankers(is_active) WHERE is_active = 1;
  `;
}

/**
 * kb_files:知识库上传源文件(物理 blob 的元数据索引)。driver 是知识库文件唯一持久化载体,
 * 不再写主库 uploaded_files(后者只留会话附件 session scope)。blob 物理文件落 driver 自管目录,
 * 表只存元数据 + stored_path 指针。deleteKnowledgeFile 删行同时删 blob(自包含)。
 */
export function kbFilesTableDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS kb_files (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      md_blob_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kb_files_uploaded_at ON kb_files(uploaded_at);
  `;
}
