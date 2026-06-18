/**
 * vector-store 契约层(re-export 聚合)。实现(SqliteVecDriver)implements IVectorStore + IKnowledgeConfig,
 * 消费者(VectorLibraryService 编排层)依赖窄接口而非具体 driver。
 */
export * from "./vector-store.js";
export * from "./knowledge-config.js";
export * from "./embedder.js";
export * from "./driver-registry.js";
export * from "./errors.js";
