// context 组装原语（自 SDK context/ 迁入）：recent 组装归 backend，端口 + 纯函数 + builder。
// memory source（services/agent/memory/）亦 implements 这些端口，与 recent source 共用 AgentContextSource。
export type {
  AgentContext,
  AgentContextContribution,
  AgentContextRequest,
  AgentContextSource,
  ConversationHistoryPort,
  ResolvedAgentContextRequest,
  SessionMetadataPort,
} from "./types.js";
export {
  HISTORY_SCAN_LIMIT,
  DEFAULT_THREAD_KEY,
  DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS,
} from "./types.js";
export { AgentContextBuilder } from "./context-builder.js";
export { buildBackendAgentContext, type BuildBackendAgentContextOptions } from "./backend-context-builder.js";
export { previewBackendAgentContext } from "./context-snapshot-service.js";
export { ProviderCacheTracker, DEFAULT_PROVIDER_CACHE_TTL_SECONDS } from "./provider-cache-tracker.js";
export { RecentMessagesContextSource } from "./recent-messages-source.js";
export {
  countObservationMessages,
  filterHistoryMessages,
  messagesToConversation,
  microcompactHistoryMessages,
  resolveCompressionView,
  resolveCompressionViewDetailed,
  resolveHistoryView,
} from "./history-view.js";
export type { MicrocompactResult } from "./history-view.js";
export { extractImageAttachments } from "./attachment-image.js";
export type { ImageReader, StoredImageAttachment } from "./attachment-image.js";
// Message Extension 范式(内容扩展三视图:持久化/投影/渲染)
export {
  createDefaultProjectionRegistry,
  normalizeExtensions,
  projectConversationExtensions,
  renderUiContextText,
} from "./extensions/index.js";
export type {
  ExtensionKind,
  ExtensionProjector,
  MessageExtension,
  ProjectContext,
  RenderSlot,
} from "./extensions/index.js";
