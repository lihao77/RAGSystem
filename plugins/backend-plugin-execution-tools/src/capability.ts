import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";
import type {
  CodeExecutionPort,
  CommandExecutionPort,
  WorkspaceSearchPort,
} from "./contracts.js";

export interface ExecutionToolsRuntimeCapability {
  readonly bash: CommandExecutionPort | null;
  readonly code: CodeExecutionPort | null;
  readonly search: WorkspaceSearchPort | null;
}

export const EXECUTION_TOOLS_RUNTIME_CAPABILITY = createCapability<ExecutionToolsRuntimeCapability>(
  "@ragsystem/backend-plugin-execution-tools/runtime",
);
