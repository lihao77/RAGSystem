import path from "node:path";

import type { AppEnv } from "../../../config/env.js";
import type { TenantDirectory } from "../../../contracts/control-plane/index.js";
import type { RuntimeContainer } from "../../../contracts/runtime/runtime-container.js";
import type { TenantId } from "../../../identity/types.js";
import type { AgentExecutionLogger } from "../../../services/agent/execution/index.js";
import { TenantRuntimeRegistryCore } from "../../../services/runtime/tenant-runtime-registry.js";
import type { RuntimeContainerRegistry } from "../../../services/runtime/runtime-container-registry.js";
import type { SaaSConversationRuntimeHandle } from "./saas-conversation-runtime.js";
import type { SaaSMemoryRuntimeHandle } from "./saas-memory-runtime.js";
import { createSaaSRuntimeContainer, prepareSaaSRuntimeContainer } from "./saas-runtime-container.js";

export interface SaaSTenantRuntimeRegistryOptions {
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  memoryRuntime?: SaaSMemoryRuntimeHandle;
}

/** SaaS deployment adapter around the shared tenant runtime lifecycle. */
export class SaaSTenantRuntimeRegistry
  extends TenantRuntimeRegistryCore<RuntimeContainer>
  implements RuntimeContainerRegistry {
  constructor(
    env: AppEnv,
    tenantDirectory: TenantDirectory,
    conversationRuntime: SaaSConversationRuntimeHandle,
    logger?: AgentExecutionLogger,
    options: SaaSTenantRuntimeRegistryOptions = {},
  ) {
    const tenantRoot = (tenantId: TenantId) => path.join(env.tenantsRoot, tenantId);
    super(tenantDirectory, {
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
      createRuntime: async (tenantId) => {
        const dataRoot = tenantRoot(tenantId);
        const runtime = createSaaSRuntimeContainer({
          tenantId,
          dataRoot,
          dbPath: path.join(dataRoot, "db", "ragsystem.db"),
          conversationRuntime,
          ...(options.memoryRuntime ? { memoryRuntime: options.memoryRuntime } : {}),
          ...(logger ? { logger } : {}),
        });
        try {
          await runtime.backgroundTasks.initialize();
          return runtime;
        } catch (error) {
          runtime.close();
          throw error;
        }
      },
      prepareRuntime: (tenantId, runtime) => prepareSaaSRuntimeContainer(
        tenantId,
        runtime,
        conversationRuntime,
      ),
      hasSession: async (runtime, sessionId) => {
        const session = await conversationRuntime.conversation.getSession(sessionId);
        return session?.tenant_id === runtime.interactionCoordinator.runtimeStorage.tenantId;
      },
      getRunningCount: (runtime) => runtime.agentExecution.listRunningTasks().count,
      onRuntimeReady: (_tenantId, runtime) => {
        runtime.backgroundTasks.setOnTaskCompleted((sessionId) => runtime.agentExecution.triggerBgNotificationRun(sessionId));
      },
      closeRuntime: (runtime) => runtime.close(),
    });
  }
}
