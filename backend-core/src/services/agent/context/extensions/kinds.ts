/**
 * Message Extension 契约——挂在消息 metadata.extensions 上的结构化内容扩展。
 *
 * 消息正文、附件和文件引用由 Message.content_parts 承载；这里仅定义正文之外的上下文扩展。
 *
 * 边界:只有"内容扩展"进 extensions[];"执行追溯字段"(agent/run_id/task_id/
 * request_id/execution_kind/source)留 metadata 顶层,不投影不渲染。event-persister
 * 的 assistant final 消息 metadata 是 SDK 落库产物,整体不范式化。
 */

/**
 * 内容扩展种类(挂在消息上的内容伴随/修饰)。投影/渲染 registry 按 kind 查找。
 *
 * command_ref / command_result 属于规范正文；background_notification 走 metadata.source。
 * 它们都不属于正文之外的伴随内容。
 */
export type ExtensionKind =
  | "ui_context"
  | "tool_result_media";

/** 渲染插槽:扩展相对 message content 的渲染位置(前端 renderer 用;投影不读)。 */
export type RenderSlot = "above" | "below" | "replace";

/** 内容扩展统一载体。 */
export interface MessageExtension {
  kind: ExtensionKind;
  version?: number;
  data: Record<string, unknown>;
  /** 渲染插槽(可被 renderer 默认值覆盖);投影不读此字段。 */
  slot?: RenderSlot;
}
