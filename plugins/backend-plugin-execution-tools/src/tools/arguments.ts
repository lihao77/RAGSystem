import { asString } from "@ragsystem/backend-core/utils/guards.js";
import type { BashExecutionInput } from "./BashTool/BashExecution.js";
import type { CodeExecutionInput } from "./CodeExecutionTool/CodeExecution.js";

export function readBashArguments(value: Record<string, unknown> | undefined): BashExecutionInput {
  return {
    command: asString(value?.command) ?? "",
    workingDir: asString(value?.working_dir) ?? asString(value?.workingDir),
    workingDirSpace: asString(value?.working_dir_space) ?? asString(value?.workingDirSpace),
    timeout: asInteger(value?.timeout),
    runInBackground: typeof value?.run_in_background === "boolean"
      ? value.run_in_background
      : typeof value?.runInBackground === "boolean" ? value.runInBackground : null,
    description: asString(value?.description),
  };
}

export function readCodeExecutionArguments(value: Record<string, unknown> | undefined): CodeExecutionInput {
  return {
    code: asString(value?.code) ?? "",
    description: asString(value?.description),
    timeout: asInteger(value?.timeout),
  };
}

export function readGlobArguments(value: Record<string, unknown> | undefined) {
  return {
    pattern: asString(value?.pattern) ?? "",
    path: asString(value?.path),
    recursive: typeof value?.recursive === "boolean" ? value.recursive : null,
    maxResults: asInteger(value?.max_results) ?? asInteger(value?.maxResults),
  };
}

export function readGrepArguments(value: Record<string, unknown> | undefined) {
  return {
    pattern: asString(value?.pattern) ?? "",
    path: asString(value?.path),
    glob: asString(value?.glob),
    caseSensitive: typeof value?.case_sensitive === "boolean"
      ? value.case_sensitive
      : typeof value?.caseSensitive === "boolean" ? value.caseSensitive : null,
    maxResults: asInteger(value?.max_results) ?? asInteger(value?.maxResults),
    contextLines: asInteger(value?.context_lines) ?? asInteger(value?.contextLines),
  };
}

export function readWebFetchArguments(value: Record<string, unknown> | undefined) {
  return {
    url: asString(value?.url) ?? "",
    timeoutMs: asInteger(value?.timeout_ms) ?? asInteger(value?.timeoutMs),
    maxChars: asInteger(value?.max_chars) ?? asInteger(value?.maxChars),
  };
}

export function readTodoWriteArguments(value: Record<string, unknown> | undefined) {
  return { todos: value?.todos ?? [] };
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
