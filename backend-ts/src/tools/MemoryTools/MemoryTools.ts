import { z } from "zod";

import type { AgentConfig } from "../../contracts/agent-config.js";
import type { MemoryToolService } from "./MemoryExecution.js";
import {
  readArchiveMemoryArguments,
  readListMemoryIndexArguments,
  readMemoryEntryArguments,
  readWriteMemoryArguments,
} from "../../services/runtime/runtime-tool-bridge/arguments.js";
import {
  ARCHIVE_MEMORY_TOOL_NAME,
  WRITE_MEMORY_TOOL_NAME,
} from "../../services/runtime/runtime-tool-bridge/registry.js";
import {
  buildTool,
  type RuntimeToolDefinition,
  type Tool,
  type ToolAccessDecision,
  type ToolExecContext,
} from "@ragsystem/agent-sdk";
import { metadataFrom, optionalString } from "../schema-helpers.js";

interface MemoryToolDeps {
  memoryTools: MemoryToolService;
  agent: AgentConfig;
}

const memoryScopeSchema = z.object({
  scope: z.enum(["team", "session", "agent", "workspace"]),
  session_id: optionalString,
  sessionId: optionalString,
  agent_name: optionalString,
  agentName: optionalString,
  current_agent_name: optionalString,
  currentAgentName: optionalString,
  workspace_key: optionalString,
  workspaceKey: optionalString,
  team_name: optionalString,
  teamName: optionalString,
  workspace_root: optionalString,
  workspaceRoot: optionalString,
});

const listMemoryIndexSchema = memoryScopeSchema.strict();
const readMemoryEntrySchema = memoryScopeSchema.extend({
  file_name: z.string(),
  fileName: z.string().optional(),
}).strict();
const writeMemorySchema = memoryScopeSchema.extend({
  name: z.string(),
  description: z.string(),
  memory_type: z.enum(["preference", "constraint", "goal", "fact", "profile"]),
  memoryType: z.string().optional(),
  content: z.string(),
  why: optionalString,
  how_to_apply: optionalString,
  howToApply: optionalString,
  source_run_id: optionalString,
  sourceRunId: optionalString,
  source_message_id: optionalString,
  sourceMessageId: optionalString,
}).strict();
const archiveMemorySchema = readMemoryEntrySchema;

const READ_ONLY_MEMORY_TOOLS: RuntimeToolDefinition[] = [
  {
    name: "list_memory_index",
    source: "memory",
    category: "memory",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "List the MEMORY.md index for an allowed memory scope before selecting an entry file to read.",
    returns: {
      description: "返回 MEMORY.md 索引头部和索引文件路径。",
      shape: {
        content: "string",
        metadata: {
          scope: "string",
          index_file_path: "string",
        },
      },
    },
    usage_contract: [
      "先调用 list_memory_index 再决定是否读取具体记忆文件。",
      "team、session、agent、workspace 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
      "该工具只返回 MEMORY.md 头部，不返回所有记忆正文。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["scope"],
      properties: {
        scope: {
          type: "string",
          enum: ["team", "session", "agent", "workspace"],
          description: "Memory scope to inspect.",
        },
        session_id: {
          type: "string",
          description: "Optional session id. Omit it when the current session context should be used.",
        },
        agent_name: {
          type: "string",
          description: "Optional agent name for agent-scoped memory.",
        },
        workspace_key: {
          type: "string",
          description: "Optional normalized workspace memory key.",
        },
        team_name: {
          type: "string",
          description: "Optional team name for team-scoped or agent-scoped memory.",
        },
        workspace_root: {
          type: "string",
          description: "Optional workspace root path used to derive workspace memory.",
        },
      },
    },
  },
  {
    name: "read_memory_entry",
    source: "memory",
    category: "memory",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Read one memory entry file from an allowed memory scope after checking the index.",
    returns: {
      description: "返回单条记忆正文和文件路径。",
      shape: {
        content: "string",
        metadata: {
          file_path: "string",
          scope: "string",
        },
      },
    },
    usage_contract: [
      "通常先通过 list_memory_index 或 prompt 中给出的 memory 文件路径定位 file_name，再调用本工具。",
      "team、session、agent、workspace 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
      "该工具只读取一条具体记忆，不做全文检索。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["scope", "file_name"],
      properties: {
        scope: {
          type: "string",
          enum: ["team", "session", "agent", "workspace"],
          description: "Memory scope containing the entry file.",
        },
        file_name: {
          type: "string",
          description: "Memory entry file name from the index, for example fact_alpha.md.",
        },
        session_id: {
          type: "string",
          description: "Optional session id. Omit it when the current session context should be used.",
        },
        agent_name: {
          type: "string",
          description: "Optional agent name for agent-scoped memory.",
        },
        workspace_key: {
          type: "string",
          description: "Optional normalized workspace memory key.",
        },
        team_name: {
          type: "string",
          description: "Optional team name for team-scoped or agent-scoped memory.",
        },
        workspace_root: {
          type: "string",
          description: "Optional workspace root path used to derive workspace memory.",
        },
      },
    },
  },
];

const WRITE_MEMORY_TOOL: RuntimeToolDefinition = {
  name: WRITE_MEMORY_TOOL_NAME,
  source: "memory",
  category: "memory",
  riskLevel: "low",
  allowed_callers: ["direct"],
  description: "Create or update one memory entry in an allowed writable scope and rebuild that scope's MEMORY.md index.",
  returns: {
    description: "返回写入后的记忆文件路径和摘要。",
    shape: {
      content: "string",
      metadata: {
        file_path: "string",
        scope: "string",
      },
    },
  },
  usage_contract: [
    "写入记忆前应确保 scope 允许写入。",
    "team、session、agent、workspace 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
    "后续如需查看结果，优先复用返回的 file_path。",
  ],
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "name", "description", "memory_type", "content"],
    properties: {
      scope: {
        type: "string",
        enum: ["team", "session", "agent", "workspace"],
        description: "Memory scope to write.",
      },
      name: {
        type: "string",
        description: "Memory name.",
      },
      description: {
        type: "string",
        description: "Short memory summary used in MEMORY.md.",
      },
      memory_type: {
        type: "string",
        enum: ["preference", "constraint", "goal", "fact", "profile"],
        description: "Memory type.",
      },
      content: {
        type: "string",
        description: "Memory body.",
      },
      why: {
        type: "string",
        description: "Optional Why section.",
      },
      how_to_apply: {
        type: "string",
        description: "Optional How to apply section.",
      },
      source_run_id: {
        type: "string",
        description: "Optional source run id.",
      },
      source_message_id: {
        type: "string",
        description: "Optional source message id.",
      },
      session_id: {
        type: "string",
        description: "Optional session id. Omit it when the current session context should be used.",
      },
      agent_name: {
        type: "string",
        description: "Optional agent name for agent-scoped memory.",
      },
      workspace_key: {
        type: "string",
        description: "Optional normalized workspace memory key.",
      },
      team_name: {
        type: "string",
        description: "Optional team name for team-scoped or agent-scoped memory.",
      },
      workspace_root: {
        type: "string",
        description: "Optional workspace root path used to derive workspace memory.",
      },
    },
  },
};

const ARCHIVE_MEMORY_TOOL: RuntimeToolDefinition = {
  name: ARCHIVE_MEMORY_TOOL_NAME,
  source: "memory",
  category: "memory",
  riskLevel: "low",
  allowed_callers: ["direct"],
  description: "Archive one memory entry in an allowed archive scope and rebuild that scope's MEMORY.md index.",
  returns: {
    description: "返回归档后的记忆文件路径和状态。",
    shape: {
      content: "string",
      metadata: {
        file_path: "string",
        scope: "string",
      },
    },
  },
  usage_contract: [
    "归档前应确保 scope 允许归档。",
    "team、session、agent、workspace 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
    "该工具只处理单条记忆，不做批量操作。",
  ],
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "file_name"],
    properties: {
      scope: {
        type: "string",
        enum: ["team", "session", "agent", "workspace"],
        description: "Memory scope containing the entry file.",
      },
      file_name: {
        type: "string",
        description: "Memory entry file name to archive.",
      },
      session_id: {
        type: "string",
        description: "Optional session id. Omit it when the current session context should be used.",
      },
      agent_name: {
        type: "string",
        description: "Optional agent name for agent-scoped memory.",
      },
      workspace_key: {
        type: "string",
        description: "Optional normalized workspace memory key.",
      },
      team_name: {
        type: "string",
        description: "Optional team name for team-scoped or agent-scoped memory.",
      },
      workspace_root: {
        type: "string",
        description: "Optional workspace root path used to derive workspace memory.",
      },
    },
  },
};

export function createMemoryTools(deps: MemoryToolDeps): Tool[] {
  const { memoryTools, agent } = deps;
  const readOnlyDefinitions = new Map(READ_ONLY_MEMORY_TOOLS.map((definition) => [definition.name, definition]));
  const tools: Tool[] = [];

  if (agent.memory.allowed_scopes?.length) {
    tools.push(
      buildTool({
        ...metadataFrom(readOnlyDefinitions.get("list_memory_index")!),
        inputSchema: listMemoryIndexSchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision =>
          memoryTools.checkMemoryScopeAccess(readListMemoryIndexArguments(input), toMemoryRuntimeContext(agent, ctx), "read"),
        call: (input, ctx: ToolExecContext) =>
          memoryTools.listMemoryIndex(readListMemoryIndexArguments(input), toMemoryRuntimeContext(agent, ctx)),
      }),
      buildTool({
        ...metadataFrom(readOnlyDefinitions.get("read_memory_entry")!),
        inputSchema: readMemoryEntrySchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision =>
          memoryTools.checkMemoryScopeAccess(readMemoryEntryArguments(input), toMemoryRuntimeContext(agent, ctx), "read"),
        call: (input, ctx: ToolExecContext) =>
          memoryTools.readMemoryEntry(readMemoryEntryArguments(input), toMemoryRuntimeContext(agent, ctx)),
      }),
    );
  }

  if (agent.memory.write_scopes?.length) {
    tools.push(
      buildTool({
        ...metadataFrom(WRITE_MEMORY_TOOL),
        inputSchema: writeMemorySchema,
        checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision =>
          memoryTools.checkMemoryScopeAccess(readWriteMemoryArguments(input), toMemoryRuntimeContext(agent, ctx), "write"),
        call: (input, ctx: ToolExecContext) =>
          memoryTools.writeMemory(readWriteMemoryArguments(input), toMemoryRuntimeContext(agent, ctx)),
      }),
    );
  }

  if (agent.memory.archive_scopes?.length) {
    tools.push(
      buildTool({
        ...metadataFrom(ARCHIVE_MEMORY_TOOL),
        inputSchema: archiveMemorySchema,
        checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision =>
          memoryTools.checkMemoryScopeAccess(readArchiveMemoryArguments(input), toMemoryRuntimeContext(agent, ctx), "archive"),
        call: (input, ctx: ToolExecContext) =>
          memoryTools.archiveMemory(readArchiveMemoryArguments(input), toMemoryRuntimeContext(agent, ctx)),
      }),
    );
  }

  return tools;
}

function toMemoryRuntimeContext(agent: AgentConfig, ctx: ToolExecContext) {
  return {
    agent,
    sessionId: ctx.sessionId,
    currentAgentName: ctx.currentAgentName,
    workspaceRoot: ctx.workspaceRoot,
  };
}
