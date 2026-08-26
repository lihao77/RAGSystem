import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import type { MemoryApplication } from "./services/memory/memory-application.js";
import type { MemoryToolOperations } from "./tools/MemoryExecution.js";
import type { MemoryAgentConfigService } from "./config.js";

/** 级联清理目标：session/agent/team 三种可删除实体对应的记忆范围。 */
export type MemoryPurgeInput =
  | { scope: "session"; sessionId: string }
  | { scope: "agent"; teamName: string; agentName: string }
  | { scope: "team"; teamName: string };

export interface MemoryRuntimeCapability {
  readonly tools: MemoryToolOperations;
  readonly agentConfig: MemoryAgentConfigService;
  createApplication(input: {
    viewerUserId: string;
    viewerSessionIds: readonly string[] | (() => Promise<readonly string[]>);
  }): MemoryApplication;
  /**
   * 删除实体对应的全部记忆（条目、索引、待审候选、记忆配置）。
   * 由实体生命周期事件（session/agent/team deleted）触发；返回是否存在被清理的存储。
   */
  purge(input: MemoryPurgeInput): Promise<boolean>;
  /** team 重命名时把记忆目录与关联记录迁移到新 team 名（保留记忆，不删除）。 */
  migrateTeam(previousTeamName: string, teamName: string): Promise<void>;
}

export const MEMORY_RUNTIME_CAPABILITY = createCapability<MemoryRuntimeCapability>(
  "@ragsystem/backend-plugin-memory/runtime",
);
