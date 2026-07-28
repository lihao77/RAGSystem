import type { SecretResolver } from "@ragsystem/backend-core/contracts/integrations/secret-resolver.js";

import { McpAgentConfigService } from "../../agent-config.js";
import type { McpPluginRuntimeFactory } from "../../dependencies.js";
import { SaaSMcpApplication } from "./application.js";
import { PostgresMcpAgentConfigStore } from "./agent-config-store.js";
import { toMcpServerConfig } from "./config-mapping.js";
import { PostgresMcpRepository, type PostgresMcpExecutor } from "./repository.js";
import { SaaSMcpRuntime } from "./runtime-service.js";

export interface PostgresMcpRuntimeFactoryOptions {
  executor: PostgresMcpExecutor;
  secrets?: SecretResolver;
}

export function createPostgresMcpRuntimeFactory(
  options: PostgresMcpRuntimeFactoryOptions,
): McpPluginRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "saas") {
      throw new Error("Postgres MCP runtime factory requires a SaaS deployment");
    }
    const repository = new PostgresMcpRepository(options.executor, options.secrets);
    const source = {
      listMcpServers: async () => (await repository.listMcpServers(context.tenantId)).map(toMcpServerConfig),
    };
    const runtime = new SaaSMcpRuntime(context.tenantId, source);
    const ready = runtime.refresh({ connect: true }).then(() => undefined).catch(() => undefined);
    return {
      service: runtime.serviceInstance(),
      application: new SaaSMcpApplication(context.tenantId, runtime, repository),
      agentConfig: new McpAgentConfigService(
        new PostgresMcpAgentConfigStore(options.executor, context.tenantId),
      ),
      ready,
      dispose: () => runtime.close(),
    };
  };
}
