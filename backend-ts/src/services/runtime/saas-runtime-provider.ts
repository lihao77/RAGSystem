import type { TransactionalMemoryRepository } from "../../contracts/memory-store/index.js";
import type { AgentConfig } from "../../contracts/agent-config.js";
import { createTenantId, type TenantId } from "../../identity/types.js";
import {
  SaaSMemoryContextSource,
  type SaaSMemoryContextSourceOptions,
} from "../agent/memory/saas-memory-context-source.js";
import { createMemoryApplication, type MemoryApplication } from "../memory/index.js";
import {
  SaaSMemoryToolService,
} from "../../tools/MemoryTools/SaaSMemoryExecution.js";
import type { RuntimeMemorySessionPort } from "../../tools/MemoryTools/MemoryExecution.js";
import type { SessionMetadataPort } from "../agent/context/types.js";
import type { MemoryRuntimeBindings } from "../agent/memory/runtime-bindings.js";
import type { RuntimeLease, RuntimeRegistry } from "./tenant-runtime-registry.js";

/**
 * The first SaaS runtime surface is intentionally memory-only. It must not be
 * substituted for RuntimeContainer until the remaining SaaS services exist.
 */
export interface SaaSRuntime {
  readonly tenantId: TenantId;
  readonly memory: MemoryApplication;
  createMemoryTools(sessions: RuntimeMemorySessionPort): SaaSMemoryToolService;
  createMemoryContextSource(
    sessions: SessionMetadataPort,
    memoryConfig: AgentConfig["memory"],
    agentName: string,
    options?: SaaSMemoryContextSourceOptions,
  ): SaaSMemoryContextSource;
  createMemoryBindings(sessions: RuntimeMemorySessionPort & SessionMetadataPort): MemoryRuntimeBindings;
}

export type SaaSRuntimeLease = RuntimeLease<SaaSRuntime>;

/**
 * Creates tenant-bound facades over shared SaaS infrastructure. The provider
 * does not own the repository (or its connection pool), so clearing runtime
 * facades never closes shared database resources.
 */
export class SaaSRuntimeProvider implements RuntimeRegistry<SaaSRuntime> {
  private readonly runtimes = new Map<TenantId, SaaSRuntime>();

  constructor(private readonly memoryRepository: TransactionalMemoryRepository) {}

  async acquire(rawTenantId: string): Promise<SaaSRuntimeLease> {
    const tenantId = createTenantId(rawTenantId);
    const runtime = this.getOrCreateRuntime(tenantId);
    let released = false;

    return {
      tenantId,
      runtime,
      release: () => {
        if (released) return;
        released = true;
      },
    };
  }

  async closeTenant(rawTenantId: string): Promise<void> {
    this.runtimes.delete(createTenantId(rawTenantId));
  }

  async closeAll(): Promise<void> {
    this.runtimes.clear();
  }

  createMemoryBindings(
    rawTenantId: string,
    sessions: RuntimeMemorySessionPort & SessionMetadataPort,
  ): MemoryRuntimeBindings {
    return this.getOrCreateRuntime(createTenantId(rawTenantId)).createMemoryBindings(sessions);
  }

  private getOrCreateRuntime(tenantId: TenantId): SaaSRuntime {
    return this.runtimes.get(tenantId) ?? this.createRuntime(tenantId);
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
    this.runtimes.set(tenantId, runtime);
    return runtime;
  }
}
