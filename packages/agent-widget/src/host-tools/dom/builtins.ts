/**
 * iframe 侧 DOM 工具集 = domToolsToHostSpecs(document)。
 *
 * 复用 dom-tools 的 DomToolSpec→HostToolDeclaration 转换（与主网页 bind 同源），
 * 不另造 FrameTool 接口。经 frame-bridge UMD 全局 RagFrameBridge.builtins 暴露
 *（`...RagFrameBridge.builtins` 引入），serve 上报元数据后 execute 留 iframe 本地。
 */
import { domToolsToHostSpecs } from "./dom-tools.js";

/** 内置 DOM 工具集（HostToolDeclaration[]，闭包 iframe 自己的 document）。 */
export const BUILTIN_TOOLS = domToolsToHostSpecs(
  typeof document !== "undefined" ? document : ({} as Document),
);
