/**
 * 向量存储数据面契约(身份证的能力面)——对齐 Python `VectorStoreBase` 思路,TS 独立设计不复刻签名。
 *
 * driver 只承担「存储 + 召回 + 向量相似度」;文本切分(chunkText)、混合打分(keyword/hybrid/rerank)、
 * embedding 生成(IEmbedder)、vectorizer/reranker 配置管理均在应用编排层,不进 driver。
 *
 * 深合约:
 * - upsertRecords 批量写入(embedding 已由编排层经 IEmbedder 算好传入);driver 内部 id 生成;
 *   空数组无操作;I/O 失败抛 VectorStoreError(非静默);
 * - search 按 collection+model_id 召回 top_k,**仅返回 vector_score**;hybrid 的 keyword/重排由编排层
 *   (scoring.ts)补到 keyword_score/hybrid_score;无命中返回空数组(非 null/异常);
 *   query_vector 维度与 collection 的 model_id 维度不一致 → driver 抛 VectorStoreError(前置违反);
 * - deleteDocument/deleteCollection/deleteByModel 返回受影响数;不存在返回 0(非失败);
 *   deleteByModel 是 B/A 解耦口:编排层删 vectorizer 时调它清向量数据,而非直连库;
 * - listCollections/listDocuments/countVectors/countChunks 返空集合/0 不抛异常;
 * - health 反映 driver 状态(runtime/ann/collections_count);ann=false 表示降级到应用层算分(无 sqlite-vec 扩展);
 * - close 释放连接(WAL/句柄),幂等。
 */

/** 写入向量记录。id 由 driver 内部生成(调用方传空字符串或由 driver 覆盖)。 */
export interface VectorRecord {
  id: string;
  doc_id: string;
  collection: string;
  model_id: number;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
}

export interface VectorStoreQuery {
  collection: string;
  model_id: number;
  query_vector: number[];
  top_k: number;
  search_mode: "vector" | "hybrid";
  query_text?: string;
}

/** 召回命中:driver 填 vector_score;keyword_score/hybrid_score 由编排层(scoring.ts)补。 */
export interface VectorSearchHit {
  id: string;
  doc_id: string;
  document_id: string;
  collection: string;
  content: string;
  metadata: Record<string, unknown>;
  vector_score: number;
  keyword_score: number;
  hybrid_score: number;
}

export interface CollectionInfo {
  name: string;
  total_chunks: number;
  document_count: number;
  embedding_dimension: number | null;
}

export interface DocumentInfo {
  collection: string;
  document_id: string;
  chunk_count: number;
  metadata: Record<string, unknown> | null;
}

/** chunk 全量行(driver 唯一文本源):供 migrate/sync 重嵌取数。metadata 已 parse。 */
export interface StoredChunk {
  id: number;
  collection: string;
  document_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface VectorStoreHealth {
  status: string;
  runtime: string;
  ann: boolean;
  collections_count: number;
}

export interface IVectorStore {
  upsertRecords(records: VectorRecord[]): Promise<void>;
  search(query: VectorStoreQuery): Promise<VectorSearchHit[]>;
  deleteDocument(collection: string, documentId: string): Promise<{ deleted_chunks: number }>;
  deleteCollection(collection: string): Promise<{ deleted_chunks: number }>;
  deleteByModel(model_id: number): Promise<{ deleted: number }>;
  listCollections(): Promise<CollectionInfo[]>;
  listDocuments(collection: string): Promise<DocumentInfo[]>;
  countVectors(collection: string, model_id: number): Promise<number>;
  /** 该 model_id 的向量按 collection 分组计数(modelStats 的 group-by-collection breakdown 用)。 */
  countVectorsByModel(model_id: number): Promise<Array<{ collection: string; count: number }>>;
  /** document 级向量计数:fileStatus 判某文件在某 model_id 下是否已索引(B/A 交叉查询)。 */
  countVectorsForDocument(collection: string, documentId: string, model_id: number): Promise<number>;
  countChunks(collection: string): Promise<number>;
  /** 全量 chunk 行(migrate/sync 重嵌取数,driver 唯一文本源);collection 可选,不传=全部。metadata 已 parse。 */
  listChunks(collection?: string): Promise<StoredChunk[]>;
  /** 跨 collection 的 document 聚合(fileStatus 把 file 与已索引位置 join 用)。 */
  listAllDocuments(): Promise<DocumentInfo[]>;
  /**
   * 查 model_id 的向量维度(同步,内存查询 driver 维度缓存)。
   * 未 index 过该 model(维度未知)→ null。供编排层 listVectorizers 显示真维度(替 addVectorizer 的占位 64)。
   * 同步例外:纯内存 Map 查询无 I/O,故非 Promise(其余方法 async 为未来 Qdrant 等网络后端预留)。
   */
  getDimension(model_id: number): number | null;
  health(): Promise<VectorStoreHealth>;
  close(): void;
}
