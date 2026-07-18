import path from "node:path";

import { buildApp } from "../../src/app.js";
import type { AppEnv } from "../../src/config/env.js";
import { createRuntimeContainer } from "../../src/services/runtime/runtime-container.js";
import type { AgentExecutionLogger } from "../../src/services/agent/execution/index.js";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import { HashFallbackEmbedder } from "../../src/services/integrations/embedder-registry.js";
import { makeTempRoot } from "./temp-db.js";
import { createControlStore } from "../../src/services/stores/control-store/index.js";
import { SqliteControlPlaneAdapter } from "../../src/adapters/local/sqlite-control-plane-adapter.js";
import { createWidgetCredentialStore } from "../../src/services/stores/widget-credential-store/index.js";
import { createWidgetAuthService } from "../../src/services/runtime/jwt-service.js";
import { LocalIdentityProvider } from "../../src/services/identity/index.js";
import { DefaultTenantRuntimeRegistry } from "../../src/services/runtime/tenant-runtime-registry.js";
import type { IdentityProvider } from "../../src/services/identity/index.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import type { BuildAppOptions } from "../../src/app.js";

/**
 * 当前测试 dataRoot(buildTestHarness 每次更新)。artifact 等需直接写文件的 fixture
 * 用它与 container.dataRoot 保持一致(避免 fixture 写固定 .test-data 而 container 读临时目录)。
 */
export let testDataRoot = ".test-data";

export const testEnv: AppEnv = {
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  corsOrigins: true,
  dataRoot: ".test-data",
  tenantsRoot: path.join(".test-data", "tenants"),
  systemRoot: path.join(".test-data", "system"),
  allowUnsafeLocalExecution: false,
  postgresPoolMax: 10,
  sessionTokenTtlHours: 168,
};

export async function buildTestApp() {
  const { app } = await buildTestHarness();
  return app;
}

export async function buildTestHarness(
  options: {
    startOutboxDispatcher?: boolean;
    logger?: AgentExecutionLogger;
    hooks?: (registry: HookRegistry) => void;
    widgetJwtSecret?: string;
    sessionJwtSecret?: string;
    sessionTokenTtlHours?: number;
    root?: string;
    settings?: Record<string, string>;
    autoIdentityProvider?: boolean;
    identityProvider?: IdentityProvider;
    saasMemoryRuntime?: BuildAppOptions["saasMemoryRuntime"];
    resolveMemoryApplication?: BuildAppOptions["resolveMemoryApplication"];
    env?: Partial<AppEnv>;
  } = {},
) {
  const tempRoot = options.root ?? makeTempRoot();
  testDataRoot = tempRoot;
  const container = createRuntimeContainer({
    tenantId: LOCAL_TENANT_ID,
    dbPath: path.join(tempRoot, "test.db"),
    dataRoot: tempRoot,
    modelAdapterProvidersConfigPath: "",
    mcpConfigPath: "",
    systemConfigPath: "",
    agentConfigRoot: "",
    startOutboxDispatcher: options.startOutboxDispatcher ?? false,
    logger: options.logger,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    embedderFactory: () => new HashFallbackEmbedder(),
  });
  const controlStore = createControlStore(path.join(tempRoot, "system"));
  const controlPlane = new SqliteControlPlaneAdapter(controlStore);
  for (const [key, value] of Object.entries(options.settings ?? {})) controlStore.setSetting(key, value);
  const identityProvider = options.identityProvider
    ?? (options.autoIdentityProvider ? undefined : new LocalIdentityProvider(controlPlane));
  const widgetCredentialStore = createWidgetCredentialStore(controlStore.db);
  const widgetAuth = options.widgetJwtSecret
    ? createWidgetAuthService(options.widgetJwtSecret, widgetCredentialStore.ops)
    : undefined;
  const env = {
    ...testEnv,
    dataRoot: tempRoot,
    systemRoot: path.join(tempRoot, "system"),
    tenantsRoot: path.join(tempRoot, "tenants"),
    ...(options.widgetJwtSecret ? { widgetJwtSecret: options.widgetJwtSecret } : {}),
    ...(options.sessionJwtSecret ? { sessionJwtSecret: options.sessionJwtSecret } : {}),
    ...(options.sessionTokenTtlHours ? { sessionTokenTtlHours: options.sessionTokenTtlHours } : {}),
    ...options.env,
  };
  const registry = new DefaultTenantRuntimeRegistry(env, controlPlane.tenants, options.logger, {
    runtimeFactory: () => container,
  });
  const app = await buildApp({
    env,
    registry,
    controlStore,
    controlPlane,
    ...(identityProvider ? { identityProvider } : {}),
    tenantMigrator: { migrate: () => ({ status: "skipped", reason: "no_legacy_data", directories: [] }) },
    widgetCredentialStore,
    ...(options.saasMemoryRuntime ? { saasMemoryRuntime: options.saasMemoryRuntime } : {}),
    ...(options.resolveMemoryApplication ? { resolveMemoryApplication: options.resolveMemoryApplication } : {}),
    ...(widgetAuth ? { widgetAuth } : {}),
  });
  await app.ready();
  return { app, container, registry, controlStore, controlPlane, widgetCredentialStore, widgetAuth, root: tempRoot };
}
