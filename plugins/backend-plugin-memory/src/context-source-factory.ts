import type { BackendContextSourceFactory } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { SystemConfigPort } from "@ragsystem/backend-core/contracts/runtime/system-config.js";

import type { MemoryAgentConfigService } from "./config.js";
import { resolveMemorySystemConfig } from "./config.js";
import type { ListMemoryCandidatesInput, MemoryCandidateRecord } from "./contracts/local-candidates.js";
import type { MemoryContextRepository } from "./contracts/memory-store/context-repository.js";
import { MemoryContextSource } from "./services/agent/memory/memory-context-source.js";

export interface MemoryContextSourceFactoryDeps {
  agentConfig: MemoryAgentConfigService;
  systemConfig: SystemConfigPort;
  repository: MemoryContextRepository;
  listCandidates(input: ListMemoryCandidatesInput): Promise<MemoryCandidateRecord[]>;
  /** 索引渲染上限（缺省回落 memory 系统配置）。 */
  indexMaxLines?: number;
  indexMaxChars?: number;
}

/**
 * 记忆前缀 context source 工厂：装配进核心的前置 source 扩展点（产物排在 history 之前）。
 *
 * 与旧 round.before 尾部注入的差异（回到设计稿 §8 语义）:
 * - 只在上下文组装（run 开始 / 消息刷新 / 压缩重建）时实例化，不再每轮重建；
 * - 记忆块进入稳定前缀，provider 前缀缓存可命中（未命中不再 ~1k/请求）；
 * - 运行中记忆变更由 write_memory 等工具结果承载（增量），不通知块；
 * - 快照冻结/重建依 MemoryContextSource.build 的 request.cacheAlive（核心缓存活性：缓存活
 *   且结构指纹不变 → 复用快照；过期或结构变化 → 重建全块）；快照只在 touch=true 的 run
 *   路径持久化，monitoring 预览等只读组装不产生写副作用。
 */
export function createMemoryContextSourceFactory(
  deps: MemoryContextSourceFactoryDeps,
): BackendContextSourceFactory {
  return ({ agent, sessionIdentity, sessions, threadKey }) => {
    const teamName = sessionIdentity.teamSnapshot.team_name;
    const teamAgent = sessionIdentity.teamSnapshot.agents[agent.agent_name] ?? null;
    if (!teamAgent) return null;
    return (async () => {
      const memory = await deps.agentConfig.getEffective({
        teamName,
        agentName: teamAgent.agent_name,
      });
      if (!memory.enabled) return null;
      const systemConfig = resolveMemorySystemConfig(deps.systemConfig.getSection("memory"));
      return new MemoryContextSource(
        { ...sessions, listMemoryCandidates: deps.listCandidates },
        deps.repository,
        memory,
        teamName,
        teamAgent.agent_name,
        {
          indexMaxLines: deps.indexMaxLines ?? systemConfig.index_max_lines,
          indexMaxChars: deps.indexMaxChars ?? systemConfig.index_max_chars,
        },
      );
    })();
  };
}
