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

  // SaaS currently keeps its existing remote sandbox layout. The provider is
  // intentionally exposed through the same capability so tools can migrate
  // without knowing the deployment kind.
  return {
    deploymentKind: "saas",
    paths: () => ({
      workspace: "/work",
      uploads: "/input/uploads",
      artifacts: "/input/artifacts",
      transient: "/work/transient",
      exports: "/output",
    }),
    environment: () => ({
      SESSION_WORKSPACE_DIR: "/work",
      SESSION_UPLOADS_DIR: "/input/uploads",
      SESSION_ARTIFACTS_DIR: "/input/artifacts",
      SESSION_TRANSIENT_DIR: "/work/transient",
      SESSION_EXPORTS_DIR: "/output",
      RAGSYSTEM_WORKSPACE_DIR: "/work",
      RAGSYSTEM_UPLOADS_DIR: "/input/uploads",
      RAGSYSTEM_ARTIFACTS_DIR: "/input/artifacts",
      RAGSYSTEM_TRANSIENT_DIR: "/work/transient",
      RAGSYSTEM_EXPORTS_DIR: "/output",
    }),
  };
}
