export * from "./types.js";
// 输出 DTO 复用通用 file 契约；re-export 便于消费者从共享 DTO 入口统一导入。
export { type UploadedFileRecord } from "../storage/files.js";
