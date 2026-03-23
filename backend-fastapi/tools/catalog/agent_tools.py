# -*- coding: utf-8 -*-
"""Agent delegation tool definitions."""

from __future__ import annotations

from tools.tool_definition_builder import ToolContract, build_function_tool


def get_agent_tools(agents_dict):
    """Build tool definitions for delegate-able agents."""
    agent_tools = []
    for agent_name, agent in agents_dict.items():
        if agent_name == "orchestrator_agent":
            continue

        agent_config = agent.agent_config if hasattr(agent, "agent_config") else None
        contract = ToolContract(
            name=f"invoke_agent_{agent_name}",
            description=_generate_agent_description(agent, agent_config),
            parameters={
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "要委托给该 Agent 的完整任务描述；子 Agent 默认看不到此前对话历史，必须在这里写入完成任务所需的关键信息"
                    },
                    "context_hint": {
                        "type": "string",
                        "description": "可选的补充背景或执行偏好；当任务依赖上文结论、用户约束或输出格式时，应显式写在这里"
                    }
                },
                "required": ["task"]
            },
            returns={
                "type": "object",
                "description": "成功时返回子 Agent 的主要结果内容",
                "shape": {
                    "content": "agent_defined",
                    "metadata": "agent_defined",
                },
            },
            usage_contract=[
                "子 Agent 没有当前对话历史，task 中必须包含足够上下文",
                "需要额外方向时可传 context_hint",
                "链式传递时优先使用 result_N.content",
            ],
            source="agent",
        )
        agent_tools.append(build_function_tool(contract))

    return agent_tools


def _generate_agent_description(agent, agent_config):
    base_desc = agent.description if hasattr(agent, "description") else f"{agent.name} 智能体"

    if agent_config:
        display_name = agent_config.display_name or agent.name
        desc_parts = [f"**{display_name}**"]

        if agent_config.description:
            desc_parts.append(f"\n**能力**: {agent_config.description}")
        else:
            desc_parts.append(f"\n**能力**: {base_desc}")

        if hasattr(agent, "available_tools") and agent.available_tools:
            tool_names = [tool["function"]["name"] for tool in agent.available_tools]
            desc_parts.append(f"\n**可用工具**: {', '.join(tool_names[:5])}")
            if len(tool_names) > 5:
                desc_parts.append(f" 等共 {len(tool_names)} 个工具")

        custom_params = agent_config.custom_params or {}
        behavior = custom_params.get("behavior", {})
        if "use_cases" in behavior:
            desc_parts.append(f"\n**适用场景**: {behavior['use_cases']}")

        return "".join(desc_parts)

    return base_desc


AGENT_TOOLS_EXAMPLE = [
    build_function_tool(
        ToolContract(
            name="invoke_agent_qa_agent",
            description="""**通用文档问答智能体**
**能力**: 处理文件读取、结构预览、数据整理、Skill 驱动的图表/地图生成等通用任务
**可用工具**: read_file, preview_data_structure, execute_skill_script, execute_code
**适用场景**:
- 读取和总结文件
- 理解数据结构
- 清洗和转换数据
- 生成图表和报告
""",
            parameters={
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "要委托给该 Agent 的完整任务描述，例如：'查询南宁市2023年的洪涝灾害数据，并按区县汇总为表格'"
                    },
                    "context_hint": {
                        "type": "string",
                        "description": "可选的补充背景，例如：'这是报告第三部分，需要沿用上文的统计口径并返回 Markdown 表格'"
                    }
                },
                "required": ["task"]
            },
            source="agent",
        )
    ),
    build_function_tool(
        ToolContract(
            name="invoke_agent_automation_agent",
            description="""**自动化执行智能体**
**能力**: 执行多步骤工具编排和数据处理任务
**适用场景**:
- 复杂的数据整理与转换
- 多步骤工具编排
- 需要代码执行辅助的分析任务
""",
            parameters={
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "要执行的完整工作流任务描述，需包含所需输入、约束和目标输出"
                    },
                    "context_hint": {
                        "type": "string",
                        "description": "可选的补充背景或执行要求"
                    }
                },
                "required": ["task"]
            },
            source="agent",
        )
    ),
]

