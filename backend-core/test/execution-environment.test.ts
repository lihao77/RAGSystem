import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  EXECUTION_ENVIRONMENT_CAPABILITY,
  createLocalExecutionEnvironment,
} from "../src/contracts/execution/execution-environment.js";
import type { LocalCoreRuntimeDependencies } from "../src/contracts/runtime/runtime-container.js";
import { CapabilityRegistry } from "../src/plugins/capability-registry.js";
import { createTenantId } from "../src/identity/types.js";
import { createCoreRuntimeContainer } from "../src/services/runtime/core-runtime-container.js";

describe("Local execution environment", () => {
  it("materializes one stable four-directory view and its environment variables", () => {
    const dataRoot = path.resolve("test-data-root");
    const environment = createLocalExecutionEnvironment(dataRoot);

    const paths = environment.paths({ sessionId: "session-1" });

    expect(environment.deploymentKind).toBe("local");
    expect(paths).toEqual({
      workspace: path.join(dataRoot, "sessions", "session-1", "workspace"),
      uploads: path.join(dataRoot, "sessions", "session-1", "uploads"),
      artifacts: path.join(dataRoot, "sessions", "session-1", "artifacts"),
      transient: path.join(dataRoot, "sessions", "session-1", "transient"),
    });
    expect(environment.environment({ sessionId: "session-1" })).toEqual({
      SESSION_WORKSPACE_DIR: paths.workspace,
      SESSION_UPLOADS_DIR: paths.uploads,
      SESSION_ARTIFACTS_DIR: paths.artifacts,
      SESSION_TRANSIENT_DIR: paths.transient,
      RAGSYSTEM_WORKSPACE_DIR: paths.workspace,
      RAGSYSTEM_UPLOADS_DIR: paths.uploads,
      RAGSYSTEM_ARTIFACTS_DIR: paths.artifacts,
      RAGSYSTEM_TRANSIENT_DIR: paths.transient,
    });
  });

  it("registers the host environment when Local has no sandbox plugin", () => {
    const pluginCapabilities = new CapabilityRegistry();
    const closeInfrastructure = vi.fn();
    const backgroundTasks = { setOnTaskCompleted: vi.fn() };
    const dependencies = {
      deploymentKind: "local",
      tenantId: createTenantId("tnt_test"),
      dataRoot: path.resolve("test-data-root"),
      pluginCapabilities,
      backgroundTasks,
      clientEvents: {},
      eventDispatcher: {},
      closeInfrastructure,
    } as unknown as LocalCoreRuntimeDependencies;

    const runtime = createCoreRuntimeContainer(dependencies);
    const environment = runtime.pluginCapabilities.get(EXECUTION_ENVIRONMENT_CAPABILITY);

    expect(environment).toBeDefined();
    expect(environment?.deploymentKind).toBe("local");
    expect(environment?.paths({ sessionId: "session-1" }).workspace).toBe(
      path.resolve("test-data-root", "sessions", "session-1", "workspace"),
    );

    runtime.close();
    expect(closeInfrastructure).toHaveBeenCalledOnce();
  });
});
