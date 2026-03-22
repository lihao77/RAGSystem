# -*- coding: utf-8 -*-
"""OrchestratorAgent 提示辅助与结果处理函数。"""

from typing import Any, Dict

from agents.core import BaseAgent
from tools.result_references import (
    resolve_result_path,
    result_error_message,
    result_summary,
    result_primary_content,
    result_success,
    stringify_result_value,
    is_ref_error,
)
from tools.catalog.agent_tools import get_agent_tools


def _format_tool_contract(func: Dict[str, Any]) -> list[str]:
    return BaseAgent._format_tool_contract(func)


def get_agent_display_name(agent, agent_name: str) -> str:
    """
    获取 Agent 的友好显示名称

    Args:
        agent_name: Agent 技术名称（如 'kgqa_agent'）

    Returns:
        str: 友好显示名称（如 '知识图谱问答智能体'）
    """
    # 尝试从 orchestrator 获取智能体实例
    target_agent = agent.orchestrator.agents.get(agent_name)

    # 如果智能体存在且有配置，从配置中获取 display_name
    if target_agent and hasattr(target_agent, 'agent_config') and target_agent.agent_config:
        display_name = target_agent.agent_config.display_name
        if display_name:
            return display_name

    # 降级：直接返回技术名称
    return agent_name

def replace_placeholders(agent, data: Any, agent_results: Dict[int, Dict[str, Any]]) -> Any:
    """
    递归替换数据中的占位符（优化版）

    支持的占位符格式:
    - {result_1}, {result_2}, ... - 引用第N个Agent的完整结果
    - {result1}, {result2}, ...   - 简化格式（兼容）
    - {result_1.content}, {result_1.content.name}, ... - 路径访问（基于标准结果结构）

    优化：
    1. 预检：快速判断是否包含占位符，避免无用递归
    2. 缓存：避免重复替换相同的字符串

    Args:
        data: 要处理的数据（可以是字符串、字典、列表等）
        agent_results: Agent结果字典 {1: result1, 2: result2, ...}

    Returns:
        替换后的数据
    """
    import re

    placeholder_pattern = re.compile(
        r'\{result_?(\d+)(?:\.([a-zA-Z0-9_\.]+))?\}',
        re.IGNORECASE,
    )

    # 优化 1：预检 - 快速判断是否包含占位符
    # 避免对不包含占位符的数据进行递归遍历
    data_str = str(data)
    if not placeholder_pattern.search(data_str):
        return data  # 提前返回，节省递归开销

    if isinstance(data, str):
        # 字符串：查找并替换所有占位符
        def replace_func(match):
            idx = int(match.group(1))
            json_path = match.group(2)
            if idx not in agent_results:
                agent.logger.warning(f"占位符 {match.group(0)} 引用的结果不存在")
                return match.group(0)  # 保持原样

            result = agent_results[idx]
            if not result_success(result):
                return f"[Agent {idx} 执行失败: {result_error_message(result)}]"

            if json_path:
                value = resolve_result_path(
                    result,
                    json_path,
                    prefer_primary_content_root=True,
                    case_insensitive=True,
                )
                if is_ref_error(value):
                    available = value.get("available_keys", [])
                    agent.logger.warning(f"占位符 {match.group(0)} 路径不存在, 可用: {available}")
                    return f'[引用错误: 路径 "{json_path}" 不存在, 可用: {available}]'
                return stringify_result_value(value)

            return stringify_result_value(result_primary_content(result))

        return placeholder_pattern.sub(replace_func, data)

    elif isinstance(data, dict):
        # 字典：递归处理每个值
        return {key: agent._replace_placeholders(value, agent_results) for key, value in data.items()}

    elif isinstance(data, list):
        # 列表：递归处理每个元素
        return [agent._replace_placeholders(item, agent_results) for item in data]

    else:
        # 其他类型：直接返回
        return data

def format_agent_result_summary(agent, result: Any) -> str:
    """
    格式化 Agent 执行结果为摘要文本

    Args:
        result: Agent 执行结果

    Returns:
        str: 结果摘要（完整内容或截断）
    """
    if not result_success(result):
        return f"执行失败: {result_error_message(result)}"

    # 提取结果内容
    results = result_primary_content(result)

    # 🎯 优先使用完整的 results（这是子 Agent 的 final_answer）
    if isinstance(results, str) and results:
        # 如果内容较短（≤500字符），返回完整内容
        if len(results) <= 500:
            return results
        # 否则截断
        return results[:500] + "..."
    elif isinstance(results, dict):
        # 字典结果：显示键数量
        return f"返回了 {len(results)} 个字段"
    elif isinstance(results, list):
        # 列表结果：显示元素数量
        return f"返回了 {len(results)} 条记录"
    else:
        # 降级：使用 summary
        summary = result_summary(result)
        return summary if summary else "执行成功"

def get_available_agent_tools(agent):
    """
    动态获取可用的 Agent 工具列表

    延迟到执行时获取，确保其他 Agent 已经注册
    """
    return get_agent_tools(agent.orchestrator.agents)

def build_orchestrator_specific_sections(agent) -> list[str]:
    """构建 Orchestrator 专属提示词段落。"""
    available_agent_tools = agent._get_available_agent_tools()

    agent_tools_desc_lines = [
        "## 可用的 Agent 工具",
        "",
        "你可以调用以下 Agent 来完成不同类型的任务：",
    ]
    for tool in available_agent_tools:
        func = tool['function']
        name = func['name']
        desc = func['description']
        agent_tools_desc_lines.append("")
        agent_tools_desc_lines.append(f"### {name}")
        agent_tools_desc_lines.append(desc)

    example_tool_name = available_agent_tools[0]['function']['name'] if available_agent_tools else "invoke_agent_qa_agent"
    direct_tool_names = [
        tool.get('function', {}).get('name', '')
        for tool in agent._get_direct_tools_for_prompt()
    ]
    direct_tools_guide = ""
    if direct_tool_names:
        preview = ', '.join(direct_tool_names[:3])
        suffix = '...' if len(direct_tool_names) > 3 else ''
        direct_tools_guide = f"\n9. 如果任务可以通过直接工具完成（{preview}{suffix}），优先直接调用，无需委派 Agent"

    orchestration_section = f"""## 编排与委派规则

- 先判断能否直接回答，或由一个直接工具完成；不要机械委派
- 需要专业能力时，优先委派一个最匹配的子 Agent；只有确实存在依赖关系时才做多 Agent 链式调用
- 子 Agent 返回数据文件时只返回文件路径（格式 `[data:路径]`），不返回文件内容；收到路径后直接传给下游 Agent 或工具
- 委派子 Agent 时，task 中明确要求：“返回数据文件路径，不要返回文件内容”
- 多个相互独立的任务可放在同一 `<tools>` 中并行
- 如果上一轮结果已经足够，不要重复调用相同 Agent 或工具
- 工具或 Agent 报错后，下一轮应换策略、补参数或缩小任务，不要机械重试
- 最终答案使用用户语言，先给结论，再给必要细节；不确定处要明确说明边界

调用 Agent：
<tools>
<tool name="{example_tool_name}">
  <task>查询2023年广西洪涝灾害受灾人口，需要分市统计</task>
</tool>
</tools>

**task/context_hint 约束**：子 Agent 默认不继承此前对话历史。不要写“继续上一步”这类依赖隐式上下文的任务；必须把目标、输入数据、已有结论、用户约束和期望输出格式显式写入 `task` 或 `context_hint`。

**推荐的子 Agent 任务写法**：
- `task` 至少写清：目标、地区/时间/对象、关键约束、期望输出
- 需要传递已有结果时，显式写入结果摘要或使用占位符

**用占位符传递上步数据**：
<tools>
<tool name="invoke_agent_chart_agent">
  <task>生成折线图，数据：{{result_1}}，X轴=年份，Y轴=受灾人口（万人），标题='受灾人口趋势'</task>
</tool>
</tools>

## 编排专用规则

1. 可同时使用两类能力：`invoke_agent_xxx`（委派子 Agent）和“可直接调用的工具”段中的 direct 工具
2. 缺少关键输入且无法自行补齐时，用 `request_user_input`
3. 互相独立的调用放同一 `<tools>` 中并行
4. 链式调用用 {{result_1}}, {{result_2}} 引用同轮前序结果
5. 数据充足时直接输出 `<final_answer>`
6. 禁止输出 `<thinking>` 标签；`<intent>` 应使用 1-2 句自然语言概括当前判断或下一步计划，像人类的简短思考摘要；不要写成长篇推理，也可直接省略
7. 不要写成“查数据”“调工具”“生成图表”“调用 chart_agent”这类命令式标签；应写成“我先确认数据是否完整，再决定是直接回答还是委派”这种内心独白
8. 调用报错时下一轮换策略，不要原样重复{direct_tools_guide}"""

    return ["\n".join(agent_tools_desc_lines), orchestration_section]

