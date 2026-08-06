import path from "node:path";

import { createCapability } from "../../plugins/capability-registry.js";

export interface ExecutionPathContext {
  sessionId?: string | null | undefined;
  runId?: string | null | undefined;
  workspaceRoot?: string | null | undefined;
}

/** The four user-visible directories shared by every execution tool. */
export interface ExecutionPaths {
  workspace: string;
  uploads: string;
  artifacts: string;
  transient: string;
}

/**
 * Deployment-provided execution environment. It owns path materialization and
 * child-process environment setup; it does not define tool-specific behavior.
 */
export interface ExecutionEnvironmentCapability {
  readonly deploymentKind: "local" | "saas";
  paths(context: ExecutionPathContext): ExecutionPaths;
  environment(context: ExecutionPathContext): Readonly<Record<string, string>>;
}

export const EXECUTION_ENVIRONMENT_CAPABILITY = createCapability<ExecutionEnvironmentCapability>(
  "@ragsystem/backend-core/execution-environment",
);

/**
 * Local's host execution environment. The Local deployment provides this
 * explicitly when it selects direct host execution.
 */
export function createLocalExecutionEnvironment(dataRoot: string): ExecutionEnvironmentCapability {
  return {
    deploymentKind: "local",
    paths: (context) => createLocalExecutionPaths(dataRoot, context),
    environment: (context) => executionPathEnvironment(createLocalExecutionPaths(dataRoot, context)),
  };
}

/** Remote sandbox directory layout owned by SaaS deployment composition. */
export function createSaaSExecutionEnvironment(): ExecutionEnvironmentCapability {
  const paths: ExecutionPaths = {
    workspace: "/work",
    uploads: "/input/uploads",
    artifacts: "/input/artifacts",
    transient: "/work/transient",
  };
  return {
    deploymentKind: "saas",
    paths: () => paths,
    environment: () => executionPathEnvironment(paths),
  };
}

/**
 * Local's deterministic directory layout. This is a path layout helper, not a
 * security boundary: Local phase one intentionally runs processes on the host.
 */
export function createLocalExecutionPaths(dataRoot: string, context: ExecutionPathContext): ExecutionPaths {
  const sessionId = normalizeId(context.sessionId) ?? "anonymous";
  const sessionRoot = absolutePath(path.join(dataRoot, "sessions", sessionId));
  return {
    workspace: absolutePath(normalizeId(context.workspaceRoot) ?? path.join(sessionRoot, "workspace")),
    uploads: path.join(sessionRoot, "uploads"),
    artifacts: path.join(sessionRoot, "artifacts"),
    transient: path.join(sessionRoot, "transient"),
  };
}

export function executionPathEnvironment(paths: ExecutionPaths): Record<string, string> {
  return {
    SESSION_WORKSPACE_DIR: paths.workspace,
    SESSION_UPLOADS_DIR: paths.uploads,
    SESSION_ARTIFACTS_DIR: paths.artifacts,
    SESSION_TRANSIENT_DIR: paths.transient,
    RAGSYSTEM_WORKSPACE_DIR: paths.workspace,
    RAGSYSTEM_UPLOADS_DIR: paths.uploads,
    RAGSYSTEM_ARTIFACTS_DIR: paths.artifacts,
    RAGSYSTEM_TRANSIENT_DIR: paths.transient,
  };
}

function normalizeId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function absolutePath(value: string): string {
  // The only host-path normalization boundary. This does not map aliases or
  // search candidate roots.
  return path.resolve(value);
}
