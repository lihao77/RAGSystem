# -*- coding: utf-8 -*-
"""
Agent Function Definitions - 将 Agent 定义为可调用的 Function

Master V2 的核心思想：
- Agent 不再是预先编排的静态组件
- Agent 是 Master V2 可以动态调用的"工具"
- Master V2 通过 ReAct 模式，根据任务需求自主决定调用哪个 Agent

这种设计的优势：
1. **动态决策**: Master 可以根据任务进展，实时决定下一步调用哪个 Agent
2. **灵活性**: 可以多次调用同一个 Agent，或跳过某些 Agent
3. **自主性**: Master 自己分析任务，不依赖预设的执行计划
4. **可观察性**: 每次 Agent 调用都有明确的输入输出
"""

def get_agent_tools(agents_dict):
    """
    动态生成 Agent 工具定义

    Args:
        agents_dict: Dict[str, BaseAgent] - 可用的 Agent 字典

    Returns:
        List[Dict] - Agent 工具定义列表
    """
    agent_tools = []

    # 遍历所有可用的 Agent（排除 Master 系列）
    for agent_name, agent in agents_dict.items():
        # 跳过 Master 类型的 Agent，避免递归调用
        if agent_name.startswith('master_agent'):
            continue

        # 获取 Agent 配置
        agent_config = agent.agent_config if hasattr(agent, 'agent_config') else None

        # 构建 Agent 工具定义
        tool_def = {
            "type": "function",
            "function": {
                "name": f"invoke_agent_{agent_name}",  # 工具名称
                "description": _generate_agent_description(agent, agent_config),  # 描述
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "要委托给该 Agent 的具体任务描述"
                        },
                        "context_hint": {
                            "type": "string",
                            "description": "可选的上下文提示，用于帮助 Agent 更好地理解任务背景"
                        }
                    },
                    "required": ["task"]
                }
            }
        }

        agent_tools.append(tool_def)

    return agent_tools


def _generate_agent_description(agent, agent_config):
    """
    生成 Agent 的工具描述

    描述应包含：
    1. Agent 的能力和专长
    2. 适用场景
    3. 可用的工具列表（如果有）

    Args:
        agent: BaseAgent 实例
        agent_config: AgentConfig 配置对象

    Returns:
        str - Agent 描述文本
    """
    # 基础描述
    base_desc = agent.description if hasattr(agent, 'description') else f"{agent.name} 智能体"

    # 如果有配置，添加更详细的信息
    if agent_config:
        display_name = agent_config.display_name or agent.name
        desc_parts = [f"**{display_name}**"]

        # 添加描述
        if agent_config.description:
            desc_parts.append(f"\n**能力**: {agent_config.description}")
        else:
            desc_parts.append(f"\n**能力**: {base_desc}")

        # 添加可用工具列表
        if hasattr(agent, 'available_tools') and agent.available_tools:
            tool_names = [tool['function']['name'] for tool in agent.available_tools]
            desc_parts.append(f"\n**可用工具**: {', '.join(tool_names[:5])}")
            if len(tool_names) > 5:
                desc_parts.append(f" 等共 {len(tool_names)} 个工具")

        # 添加适用场景
        custom_params = agent_config.custom_params or {}
        behavior = custom_params.get('behavior', {})
        if 'use_cases' in behavior:
            use_cases = behavior['use_cases']
            desc_parts.append(f"\n**适用场景**: {use_cases}")

        return "".join(desc_parts)

    return base_desc


# 静态的通用 Agent 工具定义（作为示例和文档）
AGENT_TOOLS_EXAMPLE = [
    {
        "type": "function",
        "function": {
            "name": "invoke_agent_qa_agent",
            "description": """**知识图谱问答智能体**
**能力**: 专门处理知识图谱相关的查询和分析任务，包括实体搜索、关系查询、时序分析、因果追踪等
**可用工具**: query_knowledge_graph_with_nl, search_knowledge_graph, get_entity_relations, find_causal_chain, analyze_temporal_pattern
**适用场景**:
- 查询知识图谱中的实体、关系、属性
- 分析时间序列数据和趋势
- 追踪因果关系链
- 对比多个实体
- 生成统计聚合结果
""",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "要委托给该 Agent 的具体任务描述，例如：'查询南宁市2023年的洪涝灾害数据'"
                    },
                    "context_hint": {
                        "type": "string",
                        "description": "可选的上下文提示，例如：'这是为了生成报告的一部分，需要详细的数值数据'"
                    }
                },
                "required": ["task"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "invoke_agent_workflow_agent",
            "description": """**工作流执行智能体**
**能力**: 执行预定义的工作流，支持节点化数据处理流程
**适用场景**:
- 需要执行复杂的数据处理流程
- 需要使用预设的工作流模板
- 多步骤数据转换和分析
""",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "要执行的工作流任务描述"
                    },
                    "context_hint": {
                        "type": "string",
                        "description": "可选的上下文提示"
                    }
                },
                "required": ["task"]
            }
        }
    }
]
