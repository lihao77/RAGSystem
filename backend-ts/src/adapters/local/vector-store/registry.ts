/**
 * driver 运行时注册表(契约层 contracts/vector-store 只放类型,实例 Map 在此)。
 * Local knowledge driver 直接实现 Async knowledge ports。
 */
import type { AsyncKnowledgeConfigStore } from "../../../contracts/knowledge/async-knowledge-config.js";
import type { AsyncKnowledgeFileStore } from "../../../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeVectorStore } from "../../../contracts/knowledge/async-vector-store.js";
import type {
  DriverRegistry,
  VectorStoreDriverConfig,
  VectorStoreDriverFactory,
} from "../../../contracts/vector-store/index.js";
import { VectorStoreError } from "../../../contracts/vector-store/errors.js";

export type LocalKnowledgeDriver = AsyncKnowledgeVectorStore & AsyncKnowledgeConfigStore & AsyncKnowledgeFileStore & {
  close(): void;
  getKnowledgeUploadsRoot(): string;
};

export const DRIVER_REGISTRY: DriverRegistry = new Map();

export function registerDriver(name: string, factory: VectorStoreDriverFactory): void {
  DRIVER_REGISTRY.set(name, factory);
}

/**
 * 按 config.backend 查注册表实例化 driver。未知 backend 抛 VectorStoreError(前置违反)。
 * 调用前须确保 driver 模块已 import(触发自注册),否则注册表为空。
 */
export function createVectorStore(config: VectorStoreDriverConfig): LocalKnowledgeDriver {
  const factory = DRIVER_REGISTRY.get(config.backend);
  if (!factory) {
    throw new VectorStoreError(`不支持的向量存储后端: ${config.backend}`, 400);
  }
  return factory.create(config);
}
