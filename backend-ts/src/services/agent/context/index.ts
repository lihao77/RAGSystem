import type { SystemConfigService } from "../../config/system-config-service.js";

// context 组装原语（自 SDK context/ 迁入）：recent 组装归 backend，端口 + 纯函数 + builder。
// memory source（services/agent/memory/）亦 implements 这些端口，与 recent source 共用 AgentContextSource。
export type {
  AgentContext,
  AgentContextBuilderOptions,
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
  DEFAULT_MICROCOMPACT_TTL_SECONDS,
} from "./types.js";
export { AgentContextBuilder } from "./context-builder.js";
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
export { enrichConversationImages, enrichUserMessageImages, extractImageAttachments } from "./attachment-image.js";
export type { ImageReader, StoredImageAttachment } from "./attachment-image.js";

/**
 * AgentContextService —— 预算门面已退役(budget 改用 SDK resolveContextBudget: window×0.9 − systemPromptTokens,
 * monitoring 直接调)。本空壳类留待 B 阶段连同 sdkStore 一起清。
 */
export class AgentContextService {
  constructor(private readonly systemConfig: SystemConfigService) {}
}
