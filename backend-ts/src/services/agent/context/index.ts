import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import { resolveContextBudget } from "../context-compression/index.js";

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
 * 上下文预算门面 —— 仅供 monitoring 调试快照的预算估算。
 *
 * 上下文组装（memory + recent）由 backend AgentContextBuilder 承接（memory 归 services/agent/memory/，
 * recent 归本目录），产 conversation 经 RunInput.conversation 注入 SDK；压缩由 SDK 承担（A3 待外移）。本门面不再组装 context——
 * 旧 snapshotContext 是 run/preview 收敛前的平行组装残留，随 memory 迁出一并删除。
 */
export class AgentContextService {
  constructor(private readonly systemConfig: SystemConfigService) {}

  resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig | null, modelName: string | null): number {
    return resolveContextBudget(agent, provider, this.systemConfig.getConfig(), modelName);
  }
}
