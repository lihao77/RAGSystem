/**
 * driver 注册表契约(可插拔后端的核心)——仿 Python `_PROVIDER_CLASSES`(dict + 工厂),避开 if/else 分发。
 *
 * 深合约:每个 backend 一个 VectorStoreDriverFactory。createVectorStore 按 config.backend 查表实例化;
 * 加新 driver = registerDriver(name, factory),不改分发逻辑(开闭原则)。未知 backend 抛异常(前置违反)。
 */
import type { IVectorStore } from "./vector-store.js";

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

export interface VectorStoreDriverFactory {
  create(config: VectorStoreDriverConfig): IVectorStore;
}

export type DriverRegistry = Map<string, VectorStoreDriverFactory>;
