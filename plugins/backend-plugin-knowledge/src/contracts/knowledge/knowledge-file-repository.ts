/** SaaS knowledge-file metadata port. Blob bytes are managed by the runtime's object store. */
export interface KnowledgeFileMetadata {
  tenant_id: string;
  id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  size: number;
  mime: string;
  uploaded_at: string;
  md_blob_hash: string | null;
}

export interface AddKnowledgeFileMetadataInput {
  tenant_id: string;
  id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  size: number;
  mime: string;
  uploaded_at?: string;
  md_blob_hash?: string | null;
}

export interface KnowledgeFileMetadataRepository {
  list(tenantId: string): Promise<KnowledgeFileMetadata[]>;
  get(tenantId: string, fileId: string): Promise<KnowledgeFileMetadata | null>;
  create(input: AddKnowledgeFileMetadataInput): Promise<KnowledgeFileMetadata>;
  setMarkdownHash(tenantId: string, fileId: string, mdBlobHash: string | null): Promise<boolean>;
  delete(tenantId: string, fileId: string): Promise<boolean>;
}
