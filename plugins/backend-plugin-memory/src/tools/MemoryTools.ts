import { z } from "zod";

import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import { resolveMemoryAgentConfig, type MemoryAgentConfig } from "../config.js";
import type { MemoryToolOperations } from "./MemoryExecution.js";
import {
  readArchiveMemoryArguments,
  readListMemoryIndexArguments,
  readMemoryEntryArguments,
  readWriteMemoryArguments,
} from "./arguments.js";
import {
  buildTool,
  type RuntimeToolDefinition,
  type Tool,
  type ToolAccessDecision,
  type ToolExecContext,
} from "@ragsystem/agent-sdk";
import { metadataFrom, optionalString } from "@ragsystem/backend-core/tools/schema-helpers.js";

interface MemoryToolDeps {
  memoryTools: MemoryToolOperations;
  agent: AgentConfig;
}

const WRITE_MEMORY_TOOL_NAME = "write_memory";
const ARCHIVE_MEMORY_TOOL_NAME = "archive_memory";

const memoryScopeSchema = z.object({
  scope: z.enum(["team", "session", "agent", "workspace", "user"]),
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
      "team、session、agent、workspace、user 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
      "该工具只返回 MEMORY.md 头部，不返回所有记忆正文。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["scope"],
      properties: {
        scope: {
          type: "string",
          enum: ["team", "session", "agent", "workspace", "user"],
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
      "team、session、agent、workspace、user 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
      "该工具只读取一条具体记忆，不做全文检索。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["scope", "file_name"],
      properties: {
        scope: {
          type: "string",
          enum: ["team", "session", "agent", "workspace", "user"],
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
  description: "Save one memory entry in an allowed scope. Session, user, and workspace memories publish immediately; team and agent memories remain private to the current user until approved for sharing.",
  returns: {
    description: "返回保存状态和目标 scope；个人 scope 直接发布，team/agent 保存为等待共享审核的私人候选。",
    shape: {
      content: "object",
      metadata: {
        scope: "string",
      },
    },
  },
  usage_contract: [
    "写入记忆前应确保 scope 允许写入。",
    "team、session、agent、workspace、user 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
    "team 和 agent scope 的保存结果仅对当前用户生效，不代表已经发布为租户共享记忆。",
    "session、user 和 workspace scope 直接发布，不需要租户管理员审核。",
    "不要根据保存结果声称 team/agent memory 已对其他用户生效。",
  ],
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "name", "description", "memory_type", "content"],
    properties: {
      scope: {
        type: "string",
        enum: ["team", "session", "agent", "workspace", "user"],
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
  description: "Archive one personal memory entry, or submit a private administrator-reviewed archive request for team and agent memory.",
  returns: {
    description: "个人 scope 返回归档状态；team/agent 返回已保存归档申请，不会立即影响共享记忆。",
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
    "team、session、agent、workspace、user 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
    "team 和 agent scope 只提交当前用户的归档申请，管理员批准前共享记忆保持不变。",
    "该工具只处理单条记忆，不做批量操作。",
  ],
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "file_name"],
    properties: {
      scope: {
        type: "string",
        enum: ["team", "session", "agent", "workspace", "user"],
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
  const memory = resolveMemoryAgentConfig(agent);
  const readOnlyDefinitions = new Map(READ_ONLY_MEMORY_TOOLS.map((definition) => [definition.name, definition]));
  const tools: Tool[] = [];

  if (memory.allowed_scopes.length) {
    tools.push(
      buildTool({
        ...metadataFrom(readOnlyDefinitions.get("list_memory_index")!),
        inputSchema: listMemoryIndexSchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision =>
          memoryTools.checkMemoryScopeAccess(readListMemoryIndexArguments(input), toMemoryRuntimeContext(agent, memory, ctx), "read"),
        call: (input, ctx: ToolExecContext) =>
          memoryTools.listMemoryIndex(readListMemoryIndexArguments(input), toMemoryRuntimeContext(agent, memory, ctx)),
      }),
      buildTool({
        ...metadataFrom(readOnlyDefinitions.get("read_memory_entry")!),
        inputSchema: readMemoryEntrySchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision =>
          memoryTools.checkMemoryScopeAccess(readMemoryEntryArguments(input), toMemoryRuntimeContext(agent, memory, ctx), "read"),
        call: (input, ctx: ToolExecContext) =>
          memoryTools.readMemoryEntry(readMemoryEntryArguments(input), toMemoryRuntimeContext(agent, memory, ctx)),
      }),
    );
  }

  if (memory.write_scopes.length) {
    tools.push(
      buildTool({
        ...metadataFrom(WRITE_MEMORY_TOOL),
        inputSchema: writeMemorySchema,
        checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision =>
          memoryTools.checkMemoryScopeAccess(readWriteMemoryArguments(input), toMemoryRuntimeContext(agent, memory, ctx), "write"),
        call: (input, ctx: ToolExecContext) =>
          memoryTools.writeMemory(readWriteMemoryArguments(input), toMemoryRuntimeContext(agent, memory, ctx)),
      }),
    );
  }

  const actionableArchiveScopes = memory.archive_scopes;
  if (actionableArchiveScopes.length) {
    const configuredArchiveSchema = archiveMemorySchema.refine(
      (input) => actionableArchiveScopes.includes(input.scope),
      "当前 Agent 不允许归档该 memory scope",
    );
    tools.push(
      buildTool({
        ...metadataFrom(ARCHIVE_MEMORY_TOOL),
        inputSchema: configuredArchiveSchema,
        checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision =>
          memoryTools.checkMemoryScopeAccess(readArchiveMemoryArguments(input), toMemoryRuntimeContext(agent, memory, ctx), "archive"),
        call: (input, ctx: ToolExecContext) =>
          memoryTools.archiveMemory(readArchiveMemoryArguments(input), toMemoryRuntimeContext(agent, memory, ctx)),
      }),
    );
  }

  return tools;
}

function toMemoryRuntimeContext(agent: AgentConfig, memory: MemoryAgentConfig, ctx: ToolExecContext) {
  return {
    agent,
    memory,
    sessionId: ctx.sessionId,
    currentAgentName: ctx.currentAgentName,
    workspaceRoot: ctx.workspaceRoot,
    userId: ctx.userId,
    runId: ctx.runId,
  };
}
