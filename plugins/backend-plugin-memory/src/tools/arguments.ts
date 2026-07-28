import { asString } from "@ragsystem/backend-core/utils/guards.js";

import type {
  ArchiveMemoryInput,
  ListMemoryIndexInput,
  ReadMemoryEntryInput,
  WriteMemoryInput,
} from "./MemoryExecution.js";

export function readListMemoryIndexArguments(value: Record<string, unknown> | undefined): ListMemoryIndexInput {
  return {
    scope: asString(value?.scope) ?? "",
    sessionId: asString(value?.session_id) ?? asString(value?.sessionId),
    agentName: asString(value?.agent_name) ?? asString(value?.agentName),
    workspaceKey: asString(value?.workspace_key) ?? asString(value?.workspaceKey),
    currentAgentName: asString(value?.current_agent_name) ?? asString(value?.currentAgentName),
    teamName: asString(value?.team_name) ?? asString(value?.teamName),
    workspaceRoot: asString(value?.workspace_root) ?? asString(value?.workspaceRoot),
  };
}

export function readMemoryEntryArguments(value: Record<string, unknown> | undefined): ReadMemoryEntryInput {
  return {
    ...readListMemoryIndexArguments(value),
    fileName: asString(value?.file_name) ?? asString(value?.fileName) ?? "",
  };
}

export function readWriteMemoryArguments(value: Record<string, unknown> | undefined): WriteMemoryInput {
  return {
    ...readListMemoryIndexArguments(value),
    name: asString(value?.name) ?? "",
    description: asString(value?.description) ?? "",
    memoryType: asString(value?.memory_type) ?? asString(value?.memoryType) ?? "",
    content: typeof value?.content === "string" ? value.content : "",
    why: asString(value?.why),
    howToApply: asString(value?.how_to_apply) ?? asString(value?.howToApply),
    sourceRunId: asString(value?.source_run_id) ?? asString(value?.sourceRunId),
    sourceMessageId: asString(value?.source_message_id) ?? asString(value?.sourceMessageId),
  };
}

export function readArchiveMemoryArguments(value: Record<string, unknown> | undefined): ArchiveMemoryInput {
  return readMemoryEntryArguments(value);
}
