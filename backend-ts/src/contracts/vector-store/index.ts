/**
 * vector-store 契约层(re-export 聚合)。适配器实现这些独立于存储的端口。
 * 消费者(KnowledgeApplicationService + Local async adapters)依赖窄接口而非具体 driver。
 */
export * from "./vector-store.js";
export * from "./knowledge-config.js";
export * from "./knowledge-file-store.js";
export * from "./embedder.js";
export * from "./driver-registry.js";
export * from "./errors.js";
