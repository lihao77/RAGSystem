import type {
  GenericVectorRequest,
  IndexFileRequest,
  RerankerConfig,
  RerankerCreate,
  SearchVectorsRequest,
  VectorFileStatusResponse,
  VectorizerConfig,
  VectorizerCreate,
} from "./knowledge/knowledge-base.js";
import type { KnowledgeSearchResponse } from "./knowledge/knowledge-query.js";
import type { KnowledgeCollectionSummary } from "./knowledge/knowledge-query.js";
import type { KnowledgeFile } from "./vector-store/knowledge-file-store.js";

export interface KnowledgeUploadPart {
  filename: string;
  buffer: Buffer;
  mime: string;
}

export interface KnowledgeDownload {
  body: Uint8Array;
  filename: string;
  mime: string | null;
}

export interface KnowledgeApplication {
  upload(parts: KnowledgeUploadPart[]): Promise<KnowledgeFile[]>;
  listFiles(): Promise<KnowledgeFile[]>;
  getFile(fileId: string): Promise<KnowledgeFile | null>;
  readMarkdown(fileId: string): Promise<{ markdown: string; md_blob_hash: string }>;
  updateMarkdown(fileId: string, content: string): Promise<unknown>;
  listChunks(fileId: string): Promise<Array<{ id: string | number; content: string; metadata: Record<string, unknown>; chunk_index: number }>>;
  updateChunk(fileId: string, chunkId: string | number, content: string): Promise<unknown>;
  getModelStats(modelId: number): Promise<{ vector_count: number; storage_size_mb: number; collections: Record<string, number> }>;
  getSyncStatus(collection: string): Promise<Array<{ model_id: number; vectorizer_key: string; total_documents: number; synced_documents: number; pending_documents: number; sync_percentage: number }>>;
  syncModel(modelId: number, input: { collection: string; limit?: number | null }): Promise<Record<string, unknown>>;
  deleteFile(fileId: string): Promise<{ deleted_chunks: number } | null>;
  download(fileId: string): Promise<KnowledgeDownload | null>;
  fileStatus(): Promise<VectorFileStatusResponse>;
  indexFile(input: IndexFileRequest): Promise<Record<string, unknown>>;
  listVectorizers(): Promise<VectorizerConfig[]>;
  addVectorizer(input: VectorizerCreate): Promise<unknown>;
  activateVectorizer(key: string): Promise<unknown>;
  listDocsByVectorizer(key: string): Promise<Array<Record<string, unknown>>>;
  deleteVectorizer(key: string): Promise<unknown>;
  migrate(input: GenericVectorRequest): Promise<Record<string, unknown>>;
  listRerankers(): Promise<RerankerConfig[]>;
  addReranker(input: RerankerCreate): Promise<unknown>;
  getReranker(key: string): Promise<RerankerConfig | null>;
  activateReranker(key: string): Promise<unknown>;
  deleteReranker(key: string): Promise<unknown>;
  listCollections(): Promise<KnowledgeCollectionSummary[]>;
  deleteCollection(collectionName: string): Promise<Record<string, unknown>>;
  search(input: SearchVectorsRequest): Promise<KnowledgeSearchResponse>;
  indexDocument(input: GenericVectorRequest): Promise<Record<string, unknown>>;
  deleteDocument(collectionName: string, documentId: string): Promise<Record<string, unknown>>;
  listDocuments(collectionName: string): Promise<Record<string, unknown>>;
  vectorHealth(): Promise<Record<string, unknown>>;
}
