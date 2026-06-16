import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { AgentDelegationService } from "../../agent/agent-delegation-service.js";
import type { VectorLibraryService } from "../../knowledge/vector-library-service.js";
import type { McpService } from "../../integrations/mcp-service.js";
import type { CodeExecutionToolService } from "../../tools/code-execution-tool-service.js";
import type { LocalBashToolService } from "../../tools/local-bash-tool-service.js";
import type { LocalDocumentToolService } from "../../tools/local-document-tool-service.js";
import type { LocalSearchToolService } from "../../tools/local-search-tool-service.js";
import type { MemoryToolService } from "../../tools/memory-tool-service.js";
import type { SkillToolService } from "../../tools/skill-tool-service.js";
import type { TaskToolService } from "../../tools/task-tool-service.js";
import type { PendingInteractionService } from "../pending-interaction-service.js";
import type { RuntimeToolCall, RuntimeToolDefinition, RuntimeToolExecutionContext } from "../runtime-tool-types.js";
import { toolToDefinition, type RuntimeTool } from "./tool.js";
import { validateToolInput } from "./validation.js";
import { createBashTools } from "./defs/bash.tool.js";
import { createCodeExecutionTools } from "./defs/code-execution.tool.js";
import { createDelegationTools } from "./defs/delegation.tool.js";
import { createDocumentTools } from "./defs/document.tool.js";
import { createKnowledgeTools } from "./defs/knowledge.tool.js";
import { createLocalSearchTools } from "./defs/local-search.tool.js";
import { createMcpTools } from "./defs/mcp.tool.js";
import { createMemoryTools } from "./defs/memory.tool.js";
import { createRequestUserInputTools } from "./defs/request-user-input.tool.js";
import { createSkillTools } from "./defs/skill.tool.js";
import { createTaskTools } from "./defs/task.tool.js";

export interface RuntimeToolRegistryDeps {
  memoryTools: MemoryToolService;
  pendingInteractions?: PendingInteractionService | null | undefined;
  documentTools?: LocalDocumentToolService | null | undefined;
  bashTools?: LocalBashToolService | null | undefined;
  taskTools?: TaskToolService | null | undefined;
  searchTools?: LocalSearchToolService | null | undefined;
  vectorLibrary?: VectorLibraryService | null | undefined;
  mcp?: McpService | null | undefined;
  codeExecutionTools?: CodeExecutionToolService | null | undefined;
  skillTools?: SkillToolService | null | undefined;
  getAgentDelegation?: (() => AgentDelegationService | null) | undefined;
}

export interface RuntimeToolRegistry {
  listTools(agent: AgentConfig | null): RuntimeTool[];
  listDefinitions(agent: AgentConfig | null): RuntimeToolDefinition[];
  getVisibleTool(toolName: string, agent: AgentConfig | null): RuntimeTool | null;
  classifyConcurrency(call: RuntimeToolCall, context: RuntimeToolExecutionContext): boolean;
}

export function createToolRegistry(deps: RuntimeToolRegistryDeps): RuntimeToolRegistry {
  const staticTools = [
    ...createRequestUserInputTools({ pendingInteractions: deps.pendingInteractions ?? null }),
    ...createDocumentTools({ documentTools: deps.documentTools ?? null }),
    ...createBashTools({ bashTools: deps.bashTools ?? null }),
    ...createCodeExecutionTools({ codeExecutionTools: deps.codeExecutionTools ?? null }),
    ...createLocalSearchTools({ searchTools: deps.searchTools ?? null }),
    ...createSkillTools({ skillTools: deps.skillTools ?? null }),
    ...createKnowledgeTools({ vectorLibrary: deps.vectorLibrary ?? null }),
    ...createTaskTools({ taskTools: deps.taskTools ?? null }),
    ...createMemoryTools({ memoryTools: deps.memoryTools }),
    ...createDelegationTools({ getAgentDelegation: deps.getAgentDelegation ?? (() => null) }),
  ];

  return {
    listTools(agent) {
      return [
        ...staticTools.filter((tool) => tool.isVisible(agent)),
        ...createMcpTools({ mcp: deps.mcp ?? null, agent }),
      ];
    },
    listDefinitions(agent) {
      return this.listTools(agent).map(toolToDefinition);
    },
    getVisibleTool(toolName, agent) {
      return this.listTools(agent).find((tool) => tool.name === toolName) ?? null;
    },
    classifyConcurrency(call, context) {
      const tool = this.getVisibleTool(call.toolName.trim(), context.agent);
      if (!tool) {
        return false;
      }
      const validation = validateToolInput(tool as RuntimeTool<Record<string, unknown>>, call);
      if (!validation.ok) {
        return false;
      }
      return tool.isReadOnly(validation.input) && tool.isConcurrencySafe(validation.input);
    },
  };
}
