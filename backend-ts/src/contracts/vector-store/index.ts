/**
 * vector-store 契约层(re-export 聚合)。
 *
 * 编排层应优先使用 contracts/knowledge 的 Async* 端口。
 * 本包保留 DTO、embedder、driver 注册表与错误类型;同步 IVectorStore 三端口已退场。
 */
export * from "./knowledge-config.js";
export * from "./knowledge-file-store.js";
export * from "./embedder.js";
export * from "./driver-registry.js";
export * from "./errors.js";
