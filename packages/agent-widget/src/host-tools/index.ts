/**
 * 前端工具生态统一出口（独立 UMD：ragsystem-host-tools.umd.cjs，全局 RagHostTools）。
 *
 * 平铺 dom/map 两个命名空间，宿主按需引：
 *   RagHostTools.dom.bind(el) / RagHostTools.dom.DOM_TOOLS / RagHostTools.dom.builtins
 *   RagHostTools.map.createMapTools(adapter)
 *
 * 工具集产出 HostToolDeclaration[]：
 * - dom：内置实现（document 标准契约），bind 注册主页面 DOM 工具；builtins 供 iframe serve
 * - map：契约+工厂（宿主实现 MapAdapter），createMapTools 生成地图工具
 *
 * 同一份工具定义两用：主网页直接注册 / 嵌入网页经 iframe bridge 传递（serve 声明）。
 * 主包 widget UMD 不带工具生态（减重）；本 UMD 按需引入。
 */
export * as dom from "./dom/index.js";
export * as map from "./map/index.js";
export type { HostToolDeclaration, HostToolRegistrar } from "@ragsystem/agent-protocol";
