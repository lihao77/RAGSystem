/**
 * Local 向量存储工厂:使用固定 sqlite-vec 后端，不暴露为系统配置。
 * Local runtime 通过本工厂装配 sqlite-vec 实现，不直接依赖 driver 具体类型。
 *
 * driver 模块(sqlite-vec-driver)在此 import 触发自注册(registerDriver),registry 单向依赖避免循环。
 */
import path from "node:path";

import { createVectorStore, type LocalKnowledgeDriver } from "./registry.js";
import "./sqlite-vec-driver.js";

/**
 * dataRoot 必须由调用方解析后传入，driver 固定使用 <dataRoot>/db/knowledge.db。
 * 测试运行时可显式使用内存数据库；向量维度由 embedding 首次写入自动确定，距离固定 cosine。
 *
 * 返回类型为 Async knowledge 三端口联合——同一对象承担数据面 + 配置面 + 文件面,
 * 共享 knowledge.db 单一连接。
 */
export function createLocalVectorStore(
  dataRoot?: string,
  options: { inMemory?: boolean } = {},
): LocalKnowledgeDriver {
  if (!dataRoot?.trim()) {
    throw new Error("createLocalVectorStore 必须传入已解析的 dataRoot");
  }
  const resolvedDataRoot = path.resolve(dataRoot);
  return createVectorStore({
    backend: "sqlite_vec",
    options: options.inMemory ? { database_path: ":memory:" } : {},
    dataRoot: resolvedDataRoot,
  });
}
