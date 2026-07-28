import path from "node:path";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { BackendRuntimeContributions } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import type { AppEnv } from "@ragsystem/backend-core/config/env.js";
import type { TenantDirectory } from "@ragsystem/backend-core/contracts/control-plane/index.js";
import type { RuntimeContainer } from "@ragsystem/backend-core/contracts/runtime/runtime-container.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { AgentExecutionLogger } from "@ragsystem/backend-core/services/agent/execution/index.js";
import { TenantRuntimeRegistryCore } from "@ragsystem/backend-core/services/runtime/tenant-runtime-registry.js";
import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";
import type { SaaSConversationRuntimeHandle } from "./saas-conversation-runtime.js";
import type { SaaSMemoryRuntimeHandle } from "./saas-memory-runtime.js";
import { createSaaSRuntimeContainer, prepareSaaSRuntimeContainer } from "./saas-runtime-container.js";
import type { SandboxProvider } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import { RemoteHttpSandboxProvider } from "../sandbox/http-sandbox-provider.js";

export interface SaaSTenantRuntimeRegistryOptions {
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  memoryRuntime?: SaaSMemoryRuntimeHandle;
  sandboxProvider?: SandboxProvider;
  hooks?: (registry: HookRegistry) => void;
  plugins?: BackendRuntimeContributions;
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
    const sandboxProvider = options.sandboxProvider ?? (env.sandboxRemoteUrl && env.sandboxRemoteToken
      ? new RemoteHttpSandboxProvider({
          baseUrl: env.sandboxRemoteUrl,
          token: env.sandboxRemoteToken,
          requestTimeoutMs: env.sandboxRequestTimeoutMs ?? 30_000,
          allowInsecureHttp: env.sandboxAllowInsecureHttp,
        })
      : undefined);
    const tenantRoot = (tenantId: TenantId) => path.join(env.tenantsRoot, tenantId);
    super(tenantDirectory, {
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
      createRuntime: async (tenantId) => {
        const dataRoot = tenantRoot(tenantId);
        const runtime = await createSaaSRuntimeContainer({
          tenantId,
          dataRoot,
          conversationRuntime,
          memoryRuntime: requireMemoryRuntime(options.memoryRuntime),
          ...(sandboxProvider ? { sandboxProvider, sandboxLeaseTimeoutSeconds: env.sandboxLeaseTimeoutSeconds ?? 900 } : {}),
          ...(logger ? { logger } : {}),
          ...(options.hooks ? { hooks: options.hooks } : {}),
          ...(options.plugins ? { plugins: options.plugins } : {}),
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

function requireMemoryRuntime(runtime: SaaSMemoryRuntimeHandle | undefined): SaaSMemoryRuntimeHandle {
  if (!runtime) throw new Error("SaaS tenant runtime requires PostgreSQL memory runtime");
  return runtime;
}
