/**
 * iframe 跨源控制桥统一出口（包内/类型消费用）。
 *
 * 注意：UMD 产物按入口分别打——frame-bridge 入口暴露 { serve, builtins }（全局 RagFrameBridge），
 * host-bridge 入口暴露 { connect }（全局 RagHostBridge）。此 index 仅供包内聚合引用，非 UMD 入口。
 */
export * from "./protocol.js";
export { BUILTIN_TOOLS } from "./builtins.js";
export { serve } from "./frame-bridge.js";
export type { ServeOptions, ServeHandle } from "./frame-bridge.js";
export { builtins } from "./frame-bridge.js";
export { connect } from "./host-bridge.js";
export type { ConnectOptions, ConnectHandle } from "./host-bridge.js";
