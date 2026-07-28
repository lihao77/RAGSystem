/**
 * 知识库文件 DTO:知识库上传源文件(物理 blob + 元数据)的形状。
 *
 * 行为端口见 contracts/knowledge/async-knowledge-file-store.ts(AsyncKnowledgeFileStore)。
 */

export interface KnowledgeFile {
  id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  size: number;
  mime: string;
  uploaded_at: string;
  md_blob_hash: string | null;
}

export interface AddKnowledgeFileInput {
  originalName: string;
  buffer: Buffer;
  mime: string;
}
