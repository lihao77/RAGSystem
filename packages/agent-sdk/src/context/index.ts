/** 历史视图纯函数（组装原语 recent-source/context-builder/attachment-image + 端口已外移 backend；本目录仅留 history-view/types/helpers 供 SDK compression 用，A3/B 阶段清整个 context/）。 */
export { filterHistoryMessages, resolveCompressionView, resolveHistoryView, messagesToConversation } from "./history-view.js";
export type { MicrocompactResult } from "./history-view.js";
