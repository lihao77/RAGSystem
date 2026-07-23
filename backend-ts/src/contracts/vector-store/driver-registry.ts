/**
 * driver 注册表契约(可插拔后端的核心)。
 *
 * 深合约:每个 backend 一个 VectorStoreDriverFactory。createVectorStore 按 config.backend 查表实例化;
 * 加新 driver = registerDriver(name, factory),不改分发逻辑(开闭原则)。未知 backend 抛异常(前置违反)。
 */
import type { AsyncKnowledgeConfigStore } from "../knowledge/async-knowledge-config.js";
import type { AsyncKnowledgeFileStore } from "../knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeVectorStore } from "../knowledge/async-vector-store.js";

/**
 * driver 工厂配置由运行时 composition root 生成。
 * backend 决定选哪个 driver(查 DRIVER_REGISTRY);options 是内部运行参数。
 */
export interface VectorStoreDriverConfig {
  backend: string;
  options: Record<string, unknown>;
  dataRoot: string;
}

/**
 * Local knowledge driver 工厂返回:Async 数据面 + 配置面 + 文件面联合,并保留 close/uploads root。
 */
export interface VectorStoreDriverFactory {
  create(config: VectorStoreDriverConfig): AsyncKnowledgeVectorStore & AsyncKnowledgeConfigStore & AsyncKnowledgeFileStore & {
    close(): void;
    getKnowledgeUploadsRoot(): string;
  };
}

export type DriverRegistry = Map<string, VectorStoreDriverFactory>;
