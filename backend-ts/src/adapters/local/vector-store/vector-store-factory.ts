/**
 * 向量存储工厂:读 systemConfig.getVectorStoreConfig() → 查 DRIVER_REGISTRY → 实例化 driver。
 * Local runtime 通过本工厂装配 sqlite-vec 实现，不直接依赖 driver 具体类型。
 *
 * driver 模块(sqlite-vec-driver)在此 import 触发自注册(registerDriver),registry 单向依赖避免循环。
 */
import path from "node:path";

import type { VectorStoreConfig } from "../../../contracts/runtime/system-config.js";
import { createVectorStore, type LocalKnowledgeDriver } from "./registry.js";
import "./sqlite-vec-driver.js";

/**
 * 按 systemConfig 的 vector_store 配置实例化 driver。
 * dataRoot 必须由调用方解析后传入,driver 据此解析 knowledge.db 路径。
 *
 * 返回类型为 Async knowledge 三端口联合——同一对象承担数据面 + 配置面 + 文件面,
 * 共享 knowledge.db 单一连接。
 */
export function createVectorStoreFromConfig(config: VectorStoreConfig, dataRoot?: string): LocalKnowledgeDriver {
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
