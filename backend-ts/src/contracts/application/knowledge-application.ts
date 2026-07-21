import type {
  GenericVectorRequest,
  IndexFileRequest,
  RerankerConfig,
  RerankerCreate,
  SearchVectorsRequest,
  VectorFileStatusResponse,
  VectorizerConfig,
  VectorizerCreate,
} from "../knowledge/knowledge-base.js";
import type { KnowledgeFile } from "../vector-store/knowledge-file-store.js";

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
  listChunks(fileId: string): Promise<Array<{ id: number; content: string; metadata: Record<string, unknown>; chunk_index: number }>>;
  updateChunk(fileId: string, chunkId: number, content: string): Promise<unknown>;
  deleteFile(fileId: string): Promise<{ deleted_chunks: number } | null>;
  download(fileId: string): Promise<KnowledgeDownload | null>;
  fileStatus(): Promise<VectorFileStatusResponse>;
  indexFile(input: IndexFileRequest): Promise<Record<string, unknown>>;
  listVectorizers(): Promise<VectorizerConfig[]>;
  addVectorizer(input: VectorizerCreate): Promise<unknown> | unknown;
  activateVectorizer(key: string): Promise<unknown> | unknown;
  listDocsByVectorizer(key: string): Promise<Array<Record<string, unknown>>>;
  deleteVectorizer(key: string): Promise<unknown>;
  migrate(input: GenericVectorRequest): Promise<Record<string, unknown>>;
  listRerankers(): Promise<RerankerConfig[]> | RerankerConfig[];
  addReranker(input: RerankerCreate): unknown;
  getReranker(key: string): Promise<RerankerConfig | null> | RerankerConfig | null;
  activateReranker(key: string): unknown;
  deleteReranker(key: string): unknown;
  listCollections(): Promise<unknown>;
  deleteCollection(collectionName: string): Promise<Record<string, unknown>>;
  search(input: SearchVectorsRequest): Promise<Record<string, unknown>>;
  indexDocument(input: GenericVectorRequest): Promise<Record<string, unknown>>;
  deleteDocument(collectionName: string, documentId: string): Promise<Record<string, unknown>>;
  listDocuments(collectionName: string): Promise<Record<string, unknown>>;
  vectorHealth(): Promise<Record<string, unknown>>;
}
