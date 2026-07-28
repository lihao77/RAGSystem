import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import type { McpPluginRuntimeFactory } from "../../dependencies.js";
import { McpAgentConfigService } from "../../agent-config.js";
import { McpService } from "../../mcp-service.js";
import { LocalMcpApplication } from "./application.js";
import { SqliteMcpAgentConfigStore } from "./agent-config-store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface LocalMcpRuntimeFactoryOptions {
  configPath?: string;
}

export function createLocalMcpRuntimeFactory(
  options: LocalMcpRuntimeFactoryOptions = {},
): McpPluginRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "local") {
      throw new Error("Local MCP runtime factory requires a Local deployment");
    }
    const dbPath = path.join(context.dataRoot, "db", "mcp.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const service = new McpService({
      dataRoot: context.dataRoot,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
    const ready = service.autoConnectEnabledServers().catch(() => undefined);
    return {
      service,
      application: new LocalMcpApplication(service),
      agentConfig: new McpAgentConfigService(
        new SqliteMcpAgentConfigStore(db, context.tenantId),
      ),
      ready,
      dispose: () => {
        service.close();
        db.close();
      },
    };
  };
}
