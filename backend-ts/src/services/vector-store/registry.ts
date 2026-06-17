/**
 * driver 运行时注册表(契约层 contracts/vector-store 只放类型,实例 Map 在此)。
 * 仿 Python `_PROVIDER_CLASSES`(dict + 工厂),避开 if/else。
 *
 * 深合约:createVectorStore 按 config.backend 查表实例化;未知 backend 抛 VectorStoreError。
 * sqlite-vec driver 在 ./sqlite-vec/sqlite-vec-driver.ts 模块加载时自注册(单向依赖,避免循环)。
 */
import type {
  DriverRegistry,
  IVectorStore,
  VectorStoreDriverConfig,
  VectorStoreDriverFactory,
} from "../../contracts/vector-store/index.js";
import { VectorStoreError } from "../../contracts/vector-store/index.js";

export const DRIVER_REGISTRY: DriverRegistry = new Map();

export function registerDriver(name: string, factory: VectorStoreDriverFactory): void {
  DRIVER_REGISTRY.set(name, factory);
}

/**
 * 按 config.backend 查注册表实例化 driver。未知 backend 抛 VectorStoreError(前置违反)。
 * 调用前须确保 driver 模块已 import(触发自注册),否则注册表为空。
 */
export function createVectorStore(config: VectorStoreDriverConfig): IVectorStore {
  const factory = DRIVER_REGISTRY.get(config.backend);
  if (!factory) {
    throw new VectorStoreError(`不支持的向量存储后端: ${config.backend}`, 400);
  }
  return factory.create(config);
}
