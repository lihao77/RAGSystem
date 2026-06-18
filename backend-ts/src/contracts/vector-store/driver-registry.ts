/**
 * driver 注册表契约(可插拔后端的核心)——仿 Python `_PROVIDER_CLASSES`(dict + 工厂),避开 if/else 分发。
 *
 * 深合约:每个 backend 一个 VectorStoreDriverFactory。createVectorStore 按 config.backend 查表实例化;
 * 加新 driver = registerDriver(name, factory),不改分发逻辑(开闭原则)。未知 backend 抛异常(前置违反)。
 */
import type { IVectorStore } from "./vector-store.js";
import type { IKnowledgeConfig } from "./knowledge-config.js";
import type { IKnowledgeFileStore } from "./knowledge-file-store.js";

/**
 * driver 工厂配置:由 config.vector_store 解析后传给 factory.create。
 * backend 决定选哪个 driver(查 DRIVER_REGISTRY);options 是该 driver 的连接参数
 * (sqlite_vec: {database_path, vector_dimension, distance_metric};未来 qdrant: {url, collection, api_key})。
 */
export interface VectorStoreDriverConfig {
  backend: string;
  options: Record<string, unknown>;
  dataRoot: string;
}

/**
 * driver 工厂返回:数据面(IVectorStore) + 配置面(IKnowledgeConfig) + 知识库文件面(IKnowledgeFileStore)联合。
 * 方向 A(driver 扩责下沉):知识库向量/配置/上传文件全部在 driver,knowledge.db 单一 owner——
 * 因此 driver 注册时必须同时实现三契约,factory.create 返回联合类型,避免 runtime-container 做 `as` 断言。
 */
export interface VectorStoreDriverFactory {
  create(config: VectorStoreDriverConfig): IVectorStore & IKnowledgeConfig & IKnowledgeFileStore;
}

export type DriverRegistry = Map<string, VectorStoreDriverFactory>;
