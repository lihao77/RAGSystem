import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { BackendPluginRuntimeContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { SessionInfo } from "@ragsystem/backend-core/contracts/session/session.js";

import type { MemoryCandidateRecord, ListMemoryCandidatesInput } from "./contracts/local-candidates.js";
import type { MemoryContextRepository } from "./contracts/memory-store/context-repository.js";
import { MemoryContextSource } from "./services/agent/memory/memory-context-source.js";
import { resolveMemorySystemConfig, type MemoryAgentConfigService } from "./config.js";

export interface MemoryHookDependencies {
  context: BackendPluginRuntimeContext;
  agentConfig: MemoryAgentConfigService;
  repository: MemoryContextRepository;
  listCandidates(input: ListMemoryCandidatesInput): Promise<MemoryCandidateRecord[]>;
}

export function configureMemoryHooks(registry: HookRegistry, dependencies: MemoryHookDependencies): void {
  registry.on("round.before", async ({ ctx }) => {
    const session = await dependencies.context.sessions.getSession(ctx.session.sessionId);
    if (!session) return;
    const teamName = stringValue(session.metadata.team)
      ?? (await dependencies.context.agentConfig.listTeams()).active_team;
    const agent = dependencies.context.agentConfig.getConfig(ctx.session.profile.agentName, {
      ...(teamName ? { teamName } : {}),
    });
    if (!agent) return;
    const memory = await dependencies.agentConfig.getEffective({
      teamName,
      agentName: agent.agent_name,
    });
    if (!memory.enabled) return;
    const systemConfig = resolveMemorySystemConfig(dependencies.context.systemConfig.getSection("memory"));

    let metadata = { ...session.metadata };
    let metadataPatch: Record<string, unknown> | null = null;
    const source = new MemoryContextSource({
      getSession: () => sessionView(session, metadata),
      updateSessionMetadata: (_sessionId, patch) => {
        metadataPatch = patch;
        metadata = mergeMetadata(metadata, patch);
        return metadata;
      },
      listMemoryCandidates: (input) => dependencies.listCandidates(input),
    }, dependencies.repository, memory, agent.agent_name, {
      indexMaxLines: systemConfig.index_max_lines,
      indexMaxChars: systemConfig.index_max_chars,
    });
    const contribution = await source.build({
      sessionId: ctx.session.sessionId,
      threadKey: ctx.session.threadKey,
      microcompact: true,
      microcompactKeepRecentTools: 5,
      cacheAlive: false,
      touch: true,
    });
    if (metadataPatch) {
      await dependencies.context.sessions.updateSessionMetadata(ctx.session.sessionId, metadataPatch);
    }
    const additionalContext = (contribution.conversation ?? [])
      .map((message) => typeof message.content === "string" ? message.content : "")
      .filter(Boolean)
      .join("\n\n");
    return additionalContext ? { additionalContext } : undefined;
  });
}

function sessionView(session: SessionInfo, metadata: Record<string, unknown>) {
  return {
    metadata,
    owner_user_id: session.owner_user_id,
    workspace_id: session.workspace_id,
  };
}

function mergeMetadata(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(next[key])) next[key] = { ...next[key], ...value };
    else next[key] = value;
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
