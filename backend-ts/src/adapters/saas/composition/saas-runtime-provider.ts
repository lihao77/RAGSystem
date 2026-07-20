import type { TransactionalMemoryRepository } from "../../../contracts/memory-store/index.js";
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import { createTenantId, type TenantId } from "../../../identity/types.js";
import {
  SaaSMemoryContextSource,
  type SaaSMemoryContextSourceOptions,
} from "../../../services/agent/memory/saas-memory-context-source.js";
import { createMemoryApplication, type MemoryApplication } from "../../../services/memory/index.js";
import {
  SaaSMemoryToolService,
  type SaaSMemorySessionPort,
} from "../../../tools/MemoryTools/SaaSMemoryExecution.js";
import type { SessionMetadataPort } from "../../../services/agent/context/types.js";
import type { MemoryRuntimeBindings } from "../../../services/agent/memory/runtime-bindings.js";

/**
 * The first SaaS runtime surface is intentionally memory-only. It must not be
 * substituted for RuntimeContainer until the remaining SaaS services exist.
 */
export interface SaaSRuntime {
  readonly tenantId: TenantId;
  readonly memory: MemoryApplication;
  createMemoryTools(sessions: SaaSMemorySessionPort): SaaSMemoryToolService;
  createMemoryContextSource(
    sessions: SessionMetadataPort,
    memoryConfig: AgentConfig["memory"],
    agentName: string,
    options?: SaaSMemoryContextSourceOptions,
  ): SaaSMemoryContextSource;
  createMemoryBindings(sessions: SaaSMemorySessionPort): MemoryRuntimeBindings;
}

export interface SaaSMemoryApplicationProvider {
  memoryForTenant(tenantId: string): MemoryApplication;
}

/**
 * Creates tenant-bound facades over shared SaaS infrastructure. Facades are
 * deliberately not cached: they own no resources and naturally follow the
 * lifetime of the route or runtime bindings that consume them.
 */
export class SaaSRuntimeProvider implements SaaSMemoryApplicationProvider {
  constructor(private readonly memoryRepository: TransactionalMemoryRepository) {}

  memoryForTenant(rawTenantId: string): MemoryApplication {
    return this.createRuntime(createTenantId(rawTenantId)).memory;
  }

  createMemoryBindings(
    rawTenantId: string,
    sessions: SaaSMemorySessionPort,
  ): MemoryRuntimeBindings {
    return this.createRuntime(createTenantId(rawTenantId)).createMemoryBindings(sessions);
  }

  private createRuntime(tenantId: TenantId): SaaSRuntime {
    const memory = createMemoryApplication(tenantId, this.memoryRepository);
    const createMemoryContextSource: SaaSRuntime["createMemoryContextSource"] = (
      sessions,
      memoryConfig,
      agentName,
      options,
    ) => new SaaSMemoryContextSource(sessions, memory.query, memoryConfig, agentName, options);
    const runtime: SaaSRuntime = {
      tenantId,
      memory,
      createMemoryTools: (sessions) => new SaaSMemoryToolService(memory, sessions),
      createMemoryContextSource,
      createMemoryBindings: (sessions) => ({
        tools: new SaaSMemoryToolService(memory, sessions),
        createContextSource: (input) => createMemoryContextSource(
          input.sessions,
          input.memory,
          input.agentName,
          {
            indexMaxLines: input.memoryConfig.index_max_lines,
            indexMaxChars: input.memoryConfig.index_max_chars,
          },
        ),
      }),
    };
    return runtime;
  }
}
