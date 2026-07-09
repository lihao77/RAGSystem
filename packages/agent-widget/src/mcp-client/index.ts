/**
 * 前端工具 MCP 执行端统一出口（独立 UMD：ragsystem-mcp-client.umd.cjs，全局 RagMcpClient）。
 *
 * 连独立的 host-tool-mcp-server（/ws），上报工具清单 + 收 invoke 执行回传，作为 delegate 之外的第二条
 * 前端工具调用路径。工具声明复用 HostToolDeclaration（与 host-tools 同源）。
 */
export { RagMcpClient } from "./client.js";
export type { RagMcpClientOptions } from "./client.js";
