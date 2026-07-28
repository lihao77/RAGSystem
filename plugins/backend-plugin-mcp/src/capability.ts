import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import type { McpAgentConfigService } from "./agent-config.js";
import type { McpApplication } from "./contracts/mcp-application.js";
import type { McpService } from "./mcp-service.js";

export interface McpRuntimeCapability {
  readonly service: McpService;
  readonly application: McpApplication;
  readonly agentConfig: McpAgentConfigService;
  readonly ready: Promise<void>;
}

export const MCP_RUNTIME_CAPABILITY = createCapability<McpRuntimeCapability>(
  "@ragsystem/backend-plugin-mcp/runtime",
);
