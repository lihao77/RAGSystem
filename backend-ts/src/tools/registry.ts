/**
 * 工具注册表工厂——per-agent 聚合所有 SDK Tool 实例。
 *
 * 各 createXxxTools 工厂接收 agent，闭包绑定 agent 配置，工厂内部按 agent 决定返回哪些工具
 * （可见性融入"是否返回"）。本函数聚合所有工厂 + 动态 MCP，返回 Tool[] 供 SDK createToolRegistry 使用。
 */
import type { Tool } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../contracts/agent-config.js";
import type { DelegationPort } from "../services/agent/delegation/port.js";
import type { KnowledgeQueryPort } from "../contracts/knowledge/query-port.js";
import type { McpService } from "../services/integrations/mcp-service.js";
import type { CodeExecutionToolService } from "./CodeExecutionTool/CodeExecution.js";
import type { LocalBashToolService } from "./BashTool/BashExecution.js";
import type { LocalDocumentToolService } from "./DocumentTools/DocumentExecution.js";
import type { LocalSearchToolService } from "./LocalSearchTools/SearchExecution.js";
import type { MemoryToolOperations } from "./MemoryTools/MemoryExecution.js";
import type { SkillToolService } from "./SkillTools/SkillExecution.js";
import type { TaskToolService } from "./TaskTools/TaskExecution.js";
import type { PendingInteractionService } from "../services/runtime/pending-interaction-service.js";
import type { PathApprovalService } from "../services/runtime/path-service.js";
import { createBashTools } from "./BashTool/BashTool.js";
import { createCodeExecutionTools } from "./CodeExecutionTool/CodeExecutionTool.js";
import { createDelegationTools, type DelegationAgentConfigLookup } from "./DelegationTools/DelegationTools.js";
import { createDocumentTools } from "./DocumentTools/DocumentTools.js";
import { createKnowledgeTools } from "./KnowledgeTools/KnowledgeTools.js";
import { createLocalSearchTools } from "./LocalSearchTools/LocalSearchTools.js";
import { createMcpTools } from "./McpTools/McpTools.js";
import { createMemoryTools } from "./MemoryTools/MemoryTools.js";
import { createRequestUserInputTools } from "./RequestUserInputTool/RequestUserInputTool.js";
import { createSkillTools } from "./SkillTools/SkillTools.js";
import { createTaskTools } from "./TaskTools/TaskTools.js";

export interface BackendToolsDeps {
  agent: AgentConfig;
  memoryTools: MemoryToolOperations;
  pendingInteractions: PendingInteractionService | null;
  documentTools: LocalDocumentToolService | null;
  bashTools: LocalBashToolService | null;
  taskTools: TaskToolService | null;
  searchTools: LocalSearchToolService | null;
  knowledge: KnowledgeQueryPort | null;
  mcp: McpService | null;
  codeExecutionTools: CodeExecutionToolService | null;
  skillTools: SkillToolService | null;
  getAgentDelegation: () => DelegationPort | null;
  /**
   * agent 配置查找（delegation 工厂解析可委派 agent 展示信息用；结构上与 agentConfig 容器 getConfig 兼容）。
   * 用于让 call_agent 等工具自描述 allowlist，不提供则 allowlist 仅含 agent_name、无展示文案。
   */
  agentConfig?: DelegationAgentConfigLookup | null;
  /** session team（delegation 工具用）。 */
  teamName?: string | null;
}

/**
 * 聚合所有工具工厂，返回 per-agent 的 SDK Tool[]。
 * 可见性由各工厂内部按 agent 配置决定（不满足条件的工具不返回）。
 */
export function createBackendTools(deps: BackendToolsDeps, pathService: PathApprovalService): Tool[] {
  const { agent } = deps;
  return [
    ...createRequestUserInputTools({ pendingInteractions: deps.pendingInteractions, agent }),
    ...createDocumentTools({ documentTools: deps.documentTools, agent, pathService }),
    ...createBashTools({ bashTools: deps.bashTools, agent, pathService }),
    ...createCodeExecutionTools({ codeExecutionTools: deps.codeExecutionTools, agent }),
    ...createLocalSearchTools({ service: deps.searchTools, agent }),
    ...createSkillTools({ skillTools: deps.skillTools, agent }),
    ...createKnowledgeTools({ knowledge: deps.knowledge, agent }),
    ...createTaskTools({ taskTools: deps.taskTools, agent }),
    ...createMemoryTools({ memoryTools: deps.memoryTools, agent }),
    ...createDelegationTools({
      getAgentDelegation: deps.getAgentDelegation,
      agent,
      teamName: deps.teamName ?? null,
      agentConfig: deps.agentConfig ?? null,
    }),
    ...createMcpTools({ mcp: deps.mcp, agent }),
  ];
}
