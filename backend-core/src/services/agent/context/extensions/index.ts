/**
 * Message Extension 范式——内容扩展的三视图(持久化/投影/渲染)统一载体。
 *
 * 投影子系统(backend,本目录):registry 按 kind 查 projector,projectConversationExtensions
 * 在 recent-source 组装 conversation 时把 extensions 注入 LLM content。
 * 渲染子系统(frontend,独立):前端 RENDERERS registry 按 kind 选组件、按 slot 展示。
 *
 * 写入侧(launchers)直接构造 metadata.extensions[];读侧 normalizeExtensions 透传。
 */
export type { ExtensionKind, MessageExtension, RenderSlot } from "./kinds.js";
export type { ExtensionProjector, ProjectContext } from "./types.js";
export { ProjectionRegistry } from "./registry.js";
export { projectConversationExtensions } from "./project.js";
export { normalizeExtensions } from "./normalize.js";
export { uiContextProjector, renderUiContextText } from "./ui-context-projector.js";
export { createDefaultProjectionRegistry } from "./default-registry.js";
