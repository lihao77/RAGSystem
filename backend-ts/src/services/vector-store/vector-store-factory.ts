/**
 * 向量存储工厂:读 systemConfig.getVectorStoreConfig() → 查 DRIVER_REGISTRY → 实例化 driver。
 * 仿 Python factory.py 模式(配置面 ↔ 数据面桥接),runtime-container 不直接知道 driver 具体类型。
 *
 * driver 模块(sqlite-vec-driver)在此 import 触发自注册(registerDriver),registry 单向依赖避免循环。
 *
 * Batch 5a:工厂就绪 + service 构造支持注入 vectorStore,但 runtime-container 尚未接线
 * (driver 实际启用在 5b search 切换,届时一并处理 sqlite-vec 扩展加载失败的降级)。
 */
import path from "node:path";

import type { VectorStoreConfig } from "../../contracts/runtime/system-config.js";
import type { IKnowledgeFileStore, IVectorStore, IKnowledgeConfig } from "../../contracts/vector-store/index.js";
import { createVectorStore } from "./registry.js";
import "./sqlite-vec/sqlite-vec-driver.js";

/**
 * 按 systemConfig 的 vector_store 配置实例化 driver。
 * dataRoot 缺省 ~/​.ragsystem(与 KnowledgeBaseService 一致),driver 据此解析 knowledge.db 路径。
 *
 * 返回类型为 IVectorStore & IKnowledgeConfig & IKnowledgeFileStore——同一对象承担数据面(向量/文本) +
 * 配置面(vectorizer/reranker) + 知识库文件面(上传源文件 blob),共享 knowledge.db 单一连接,
 * 避免 runtime-container 做 `as` 类型断言。
 */
export function createVectorStoreFromConfig(config: VectorStoreConfig, dataRoot?: string): IVectorStore & IKnowledgeConfig & IKnowledgeFileStore {
  if (!dataRoot?.trim()) {
    throw new Error("createVectorStoreFromConfig 必须传入已解析的 dataRoot");
  }
  const resolvedDataRoot = path.resolve(dataRoot);
  return createVectorStore({
    backend: config.backend,
    options: {
      database_path: config.sqlite_vec.database_path,
      vector_dimension: config.sqlite_vec.vector_dimension,
      distance_metric: config.sqlite_vec.distance_metric,
    },
    dataRoot: resolvedDataRoot,
  });
}
