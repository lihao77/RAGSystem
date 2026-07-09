/**
 * DOM 工具集出口：纯函数库 + 主页面注册 + iframe 载体形态。
 */
export { DOM_TOOLS, inspectDoc, domToolsToHostSpecs } from "./dom-tools.js";
export type { DomToolSpec } from "./dom-tools.js";
export { BUILTIN_TOOLS } from "./builtins.js";
export { bindDomTools as bind } from "./bind.js";
