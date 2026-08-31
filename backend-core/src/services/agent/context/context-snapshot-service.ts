import { createRuntime, type AgentProfile, type PreviewResult, type ToolExecutionPaths, type ToolRegistry } from "@ragsystem/agent-sdk";

import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { SessionIdentity } from "../../../contracts/session/session.js";
import type { BackendContextSourceFactory } from "../../../plugins/backend-plugin.js";
import { buildBackendAgentContext } from "./backend-context-builder.js";
import type { ConversationHistoryPort, SessionMetadataPort } from "./types.js";
import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";

export async function previewBackendAgentContext(
  agent: AgentConfig,
  profile: AgentProfile,
  historyPort: ConversationHistoryPort & SessionMetadataPort,
  registry: ToolRegistry,
  options: {
    dataRoot: string;
    sessionId: string;
    threadKey?: string | null;
    sessionFiles?: SessionFileLookupPort | null;
    executionPaths?: ToolExecutionPaths | undefined;
    /** 会话身份快照（组装前置插件 source 用；缺失时跳过前置贡献）。 */
    sessionIdentity?: SessionIdentity | null;
    /** 插件贡献的前置 source 工厂（与 run 同一份；预览 touch=false，source 不得产生写副作用）。 */
    frontContextSources?: readonly BackendContextSourceFactory[];
  },
): Promise<Awaited<ReturnType<typeof buildBackendAgentContext>> & { preview: PreviewResult }> {
  const context = await buildBackendAgentContext(agent, profile, historyPort, {
    ...options,
    touch: false,
  });
  const runtime = createRuntime({
    profile,
    tools: registry,
    dataRoot: options.dataRoot,
    ...(options.executionPaths ? { execContext: { executionPaths: options.executionPaths } } : {}),
  });
  try {
    const preview = runtime.preview({
      sessionId: options.sessionId,
      ...(options.threadKey ? { threadKey: options.threadKey } : {}),
      conversation: context.built.conversation,
    });
    return { ...context, preview };
  } finally {
    runtime.close();
  }
}
