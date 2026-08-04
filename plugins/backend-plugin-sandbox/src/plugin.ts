import type { BackendPlugin, BackendPluginRuntimeContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";
import {
  EXECUTION_ENVIRONMENT_CAPABILITY,
  createLocalExecutionPaths,
  executionPathEnvironment,
  type ExecutionEnvironmentCapability,
} from "@ragsystem/backend-core/contracts/execution/execution-environment.js";

export const SANDBOX_PLUGIN_ID = "@ragsystem/backend-plugin-sandbox";

export function createSandboxPlugin(): BackendPlugin {
  return {
    manifest: { id: SANDBOX_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.runtimes.register((runtimeContext) => ({
        capabilities: [provideCapability(EXECUTION_ENVIRONMENT_CAPABILITY, createSandboxExecutionEnvironment(runtimeContext))],
      }));
    },
  };
}

function createSandboxExecutionEnvironment(context: BackendPluginRuntimeContext): ExecutionEnvironmentCapability {
  if (context.deploymentKind === "local") {
    return {
      deploymentKind: "local",
      paths: (pathContext) => createLocalExecutionPaths(context.dataRoot, pathContext),
      environment: (pathContext) => executionPathEnvironment(
        createLocalExecutionPaths(context.dataRoot, pathContext),
      ),
    };
  }

  // SaaS exposes the same four-directory contract inside its remote sandbox.
  return {
    deploymentKind: "saas",
    paths: () => ({
      workspace: "/work",
      uploads: "/input/uploads",
      artifacts: "/input/artifacts",
      transient: "/work/transient",
    }),
    environment: () => ({
      SESSION_WORKSPACE_DIR: "/work",
      SESSION_UPLOADS_DIR: "/input/uploads",
      SESSION_ARTIFACTS_DIR: "/input/artifacts",
      SESSION_TRANSIENT_DIR: "/work/transient",
      RAGSYSTEM_WORKSPACE_DIR: "/work",
      RAGSYSTEM_UPLOADS_DIR: "/input/uploads",
      RAGSYSTEM_ARTIFACTS_DIR: "/input/artifacts",
      RAGSYSTEM_TRANSIENT_DIR: "/work/transient",
    }),
  };
}
