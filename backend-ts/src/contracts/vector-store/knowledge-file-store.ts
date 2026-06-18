/**
 * 知识库文件存储契约:知识库上传源文件(物理 blob + 元数据)的单一存储。
 *
 * 设计决策:
 * - 知识库是完全独立的体系:文件 + 向量 + 配置全部归 driver(vector_store),
 *   不再写主库 uploaded_files(uploaded_files 只留会话附件 session scope)。
 * - driver 是知识库文件唯一持久化载体:元数据落 knowledge.db.kb_files,物理 blob 落 driver 自管目录。
 *
 * 深合约:
 * - addKnowledgeFile 原子:driver 负责 storedName(sanitize + randomBytes 防冲突)、storedPath(uploads 根)、
 *   物理落盘(mkdirSync + writeFileSync)、INSERT 元数据;INSERT 失败回滚物理文件,不留孤儿 blob/行;
 * - deleteKnowledgeFile **删行 + 删物理 blob**(自包含——知识库 blob 归 driver 管,与 IFileIndexStore
 *   "delete 只删行"不同,后者 blob 删除留路由层 removeStoredFile);
 *   不存在返回 null(非抛异常);
 * - get/list 不存在返回 null/[];uploaded_at 降序;
 * - getKnowledgeUploadsRoot 返回 driver 自管 blob 根(:memory: 库用 os.tmpdir 临时目录,测试隔离)。
 */

export interface KnowledgeFile {
  id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  size: number;
  mime: string;
  uploaded_at: string;
}

export interface AddKnowledgeFileInput {
  originalName: string;
  buffer: Buffer;
  mime: string;
}

export interface IKnowledgeFileStore {
  listKnowledgeFiles(): KnowledgeFile[];
  getKnowledgeFile(fileId: string): KnowledgeFile | null;
  addKnowledgeFile(input: AddKnowledgeFileInput): KnowledgeFile;
  deleteKnowledgeFile(fileId: string): KnowledgeFile | null;
  getKnowledgeUploadsRoot(): string;
}
