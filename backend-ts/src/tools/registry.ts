import type { AgentConfig } from "../contracts/agent-config.js";
import type { AgentDelegationService } from "../services/agent/agent-delegation-service.js";
import type { VectorLibraryService } from "../services/knowledge/vector-library-service.js";
import type { McpService } from "../services/integrations/mcp-service.js";
import type { CodeExecutionToolService } from "./CodeExecutionTool/CodeExecution.js";
import type { LocalBashToolService } from "./BashTool/BashExecution.js";
import type { LocalDocumentToolService } from "./DocumentTools/DocumentExecution.js";
import type { LocalSearchToolService } from "./LocalSearchTools/SearchExecution.js";
import type { MemoryToolService } from "./MemoryTools/MemoryExecution.js";
import type { SkillToolService } from "./SkillTools/SkillExecution.js";
import type { TaskToolService } from "./TaskTools/TaskExecution.js";
import type { PendingInteractionService } from "../services/runtime/pending-interaction-service.js";
import type { RuntimeToolCall, RuntimeToolDefinition, RuntimeToolExecutionContext } from "../services/runtime/runtime-tool-types.js";
import { toolToDefinition, type RuntimeTool } from "./Tool.js";
import { validateToolInput } from "./validation.js";
import { createBashTools } from "./BashTool/BashTool.js";
import { createCodeExecutionTools } from "./CodeExecutionTool/CodeExecutionTool.js";
import { createDelegationTools } from "./DelegationTools/DelegationTools.js";
import { createDocumentTools } from "./DocumentTools/DocumentTools.js";
import { createKnowledgeTools } from "./KnowledgeTools/KnowledgeTools.js";
import { createLocalSearchTools } from "./LocalSearchTools/LocalSearchTools.js";
import { createMcpTools } from "./McpTools/McpTools.js";
import { createMemoryTools } from "./MemoryTools/MemoryTools.js";
import { createRequestUserInputTools } from "./RequestUserInputTool/RequestUserInputTool.js";
import { createSkillTools } from "./SkillTools/SkillTools.js";
import { createTaskTools } from "./TaskTools/TaskTools.js";

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
