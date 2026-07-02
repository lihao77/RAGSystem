/**
 * frame-bridge 内置 DOM 工具集 = dom-tools 的薄包装（闭包 iframe 自己的 document）。
 *
 * 工具逻辑（click/get_text/set_value/...）归 dom-tools（document-agnostic 纯函数），
 * 此处仅把 DomToolSpec 包装成 FrameTool（execute 绑定 iframe 内的 document）。
 * inspect 不在 builtins（走 frame-bridge 的 __inspect__ action → inspectDoc）。
 */
import type { FrameTool } from "./protocol.js";
import { DOM_TOOLS } from "./dom-tools.js";

export const BUILTIN_TOOLS: FrameTool[] = DOM_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  ...(t.riskLevel ? { riskLevel: t.riskLevel } : {}),
  execute: (input) => t.run(document, input),
}));
