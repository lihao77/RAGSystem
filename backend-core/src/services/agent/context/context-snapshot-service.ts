import { createRuntime, type AgentProfile, type PreviewResult, type ToolRegistry } from "@ragsystem/agent-sdk";

import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
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
