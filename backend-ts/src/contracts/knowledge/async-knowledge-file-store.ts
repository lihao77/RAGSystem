import type { KnowledgeFile } from "../vector-store/knowledge-file-store.js";

/**
 * Tenant-bound asynchronous knowledge-file application port for SaaS.
 *
 * Unlike the Local `IKnowledgeFileStore`, every operation is asynchronous:
 * metadata is persisted by a remote repository and bytes by object storage.
 * Implementations must scope all reads and writes to the tenant selected at
 * construction time.
 */
export interface AsyncKnowledgeFileStore {
  listKnowledgeFiles(): Promise<KnowledgeFile[]>;
  getKnowledgeFile(fileId: string): Promise<KnowledgeFile | null>;
  addKnowledgeFile(input: { originalName: string; buffer: Buffer; mime: string }): Promise<KnowledgeFile>;
  deleteKnowledgeFile(fileId: string): Promise<KnowledgeFile | null>;
  putKnowledgeMarkdown(fileId: string, markdown: string): Promise<{ md_blob_hash: string }>;
  readKnowledgeMarkdown(mdBlobHash: string): Promise<string>;
  getSource(fileId: string): Promise<{ body: Uint8Array; contentType: string | null } | null>;
}
