import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { AgentConfigPort } from "@ragsystem/backend-core/contracts/agent/agent-config.js";

/**
 * SaaS 产品形态的 default team 模板与启动补齐。
 *
 * 与 agent-builder 插件维护其保留 team、Oceanx 产品端补齐 Team 模板是同一模式：
 * 产品层在组装时 ensure——default team 不存在则按模板创建落盘，存在（含用户
 * 改过）则一律不动。配置服务（core）只提供存取机制，不持有任何出厂 team 内容。
 * 模板中的工具名与实际注册工具取交集生效，未安装对应插件的部署中静默不存在。
 */

export async function ensureDefaultTeam(agentConfig: AgentConfigPort): Promise<boolean> {
  const summary = await agentConfig.listTeams();
  if (summary.teams.some((team) => team.team_name === "default")) {
    return false;
  }
  await agentConfig.applyTeamPayload("default", buildDefaultTeamTemplate());
  return true;
}

export function buildDefaultTeamTemplate(): Record<string, AgentConfig> {
  const specialistAgents = ["research_agent", "query_agent"];
  return {
    general_agent: systemAgent({
      agent_name: "general_agent",
      display_name: "General Agent",
      description: "系统默认全能入口智能体，直接解决各类问题，必要时委派调查与查询。",
      system_prompt:
        "你是系统的全能入口智能体：能自己解决的优先自己完成；需要深入调查或知识库检索时，再委派给 team 内的调查与查询智能体，并整合他们的结论作答。",
      default_entry: true,
      tools: ["read_file", "write_file", "edit_file", "preview_data_structure", "execute_shell", "execute_code", "glob", "grep", "web_fetch", "todo_write"],
      delegation: specialistAgents,
      goals: true,
      background: true,
    }),
    research_agent: systemAgent({
      agent_name: "research_agent",
      display_name: "Research Agent",
      description: "系统默认调查智能体，负责在工作区、代码库与网络上定位事实并归纳结论。",
      system_prompt:
        "你负责调查与研究：在工作区与代码库中定位相关文件、现有实现与可复用模式，必要时抓取网络资料；以只读方式收集证据并归纳结论，不修改文件。",
      tools: ["read_file", "preview_data_structure", "glob", "grep", "web_fetch"],
    }),
    query_agent: systemAgent({
      agent_name: "query_agent",
      display_name: "Query Agent",
      description: "系统默认查询智能体，负责知识库检索与结构化数据查询。",
      system_prompt:
        "你负责查询：检索知识库集合，从资料中抽取与问题直接相关的答案并标注来源；查看结构化数据时先预览其结构再下结论。",
      tools: ["search_knowledge_base", "list_knowledge_collections", "preview_data_structure", "read_file"],
    }),
  };
}

function systemAgent(input: {
  agent_name: string;
  display_name: string;
  description: string;
  system_prompt: string;
  default_entry?: boolean;
  tools?: string[];
  delegation?: string[];
  goals?: boolean;
  background?: boolean;
}): AgentConfig {
  return {
    agent_name: input.agent_name,
    display_name: input.display_name,
    description: input.description,
    enabled: true,
    default_entry: input.default_entry ?? false,
    // 系统约定：不写死示例 tier，无 tier 的 Agent 继承系统 LLM。
    llm_tiers: null,
    tools: { enabled_tools: input.tools ?? ["read_file", "preview_data_structure"] },
    goals: { enabled: input.goals ?? false },
    tasks: { background: input.background ?? false },
    delegation: { enabled_agents: input.delegation ?? [], parallel_children: false },
    custom_params: {
      type: "orchestrator",
      behavior: {
        system_prompt: input.system_prompt,
        compression_trigger_ratio: 0.85,
        preserve_recent_turns: 3,
      },
    },
  };
}
