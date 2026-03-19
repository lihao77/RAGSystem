# -*- coding: utf-8 -*-
"""OrchestratorAgent 提示构建与工具辅助函数。"""

import json
from typing import Any, Dict

from tools.result_references import (
    resolve_result_path,
    result_error_message,
    result_summary,
    result_primary_content,
    result_success,
    stringify_result_value,
    is_ref_error,
)
from tools.tool_registry import get_tool_registry
from tools.catalog.agent_tools import get_agent_tools


_TOOL_REGISTRY = get_tool_registry()


def _format_tool_contract(func: Dict[str, Any]) -> list[str]:
    """Render extended direct-tool metadata into prompt lines."""
    lines: list[str] = []

    returns = func.get('returns')
    if returns:
        lines.append("**成功返回**:")
        return_desc = returns.get('description')
        if return_desc:
            lines.append(f"  - {return_desc}")
        return_shape = returns.get('shape')
        if return_shape is not None:
            lines.append(f"  ```json\n  {json.dumps(return_shape, ensure_ascii=False, indent=2)}\n  ```")

    usage_contract = func.get('usage_contract') or []
    if usage_contract:
        lines.append("**使用约束**:")
        for item in usage_contract:
            lines.append(f"  - {item}")

    examples = func.get('examples') or []
    if examples:
        lines.append("**示例**:")
        for example in examples:
            # 渲染为 XML 子标签格式
            xml_parts = []
            for k, v in example.items():
                if isinstance(v, list):
                    # 数组渲染为 <item> 子标签
                    item_parts = []
                    for item in v:
                        if isinstance(item, str) and ('\n' in item or '<' in item or '>' in item or '&' in item):
                            item_parts.append(f"    <item><![CDATA[{item}]]></item>")
                        else:
                            item_parts.append(f"    <item>{item}</item>")
                    xml_parts.append(f"  <{k}>\n" + "\n".join(item_parts) + f"\n  </{k}>")
                elif isinstance(v, str) and ('\n' in v or '<' in v or '>' in v or '&' in v):
                    xml_parts.append(f"  <{k}><![CDATA[{v}]]></{k}>")
                elif isinstance(v, str):
                    xml_parts.append(f"  <{k}>{v}</{k}>")
                else:
                    xml_parts.append(f"  <{k}>{json.dumps(v, ensure_ascii=False)}</{k}>")
            xml_block = "\n".join(xml_parts)
            lines.append(f"  ```xml\n  <tool name=\"...\">\n{xml_block}\n  </tool>\n  ```")

    return lines

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

def build_system_prompt(agent) -> str:
        """构建系统提示词"""
        # 动态获取 Agent 工具列表（延迟获取，确保其他 Agent 已注册）
        available_agent_tools = agent._get_available_agent_tools()

        # 构建 Agent 工具说明
        agent_tools_desc_lines = []
        for tool in available_agent_tools:
            func = tool['function']
            name = func['name']
            desc = func['description']

            agent_tools_desc_lines.append(f"\n### {name}")
            agent_tools_desc_lines.append(f"{desc}")

        agent_tools_desc = "\n".join(agent_tools_desc_lines)

        # 构造示例
        example_tool_name = available_agent_tools[0]['function']['name'] if available_agent_tools else "invoke_agent_qa_agent"

        # 构建直接工具描述段（仅在有直接工具时追加）
        direct_tools_section = ""
        if agent.available_tools:
            direct_tool_lines = []
            for tool in agent.available_tools:
                func = tool.get('function', {})
                t_name = func.get('name', '')
                # 内置工具（如 request_user_input）不在系统提示的"可直接调用工具"段展示
                if t_name in _TOOL_REGISTRY.get_builtin_tool_names():
                    continue
                t_desc = func.get('description', '')
                params = func.get('parameters', {})

                direct_tool_lines.append(f"\n### {t_name}")
                direct_tool_lines.append(f"**描述**: {t_desc}")

                # 参数说明
                if params and 'properties' in params:
                    direct_tool_lines.append("**参数**:")
                    required = params.get('required', [])
                    for param_name, param_info in params['properties'].items():
                        param_type = param_info.get('type', 'any')
                        param_desc = param_info.get('description', '')
                        required_mark = " (必填)" if param_name in required else " (可选)"
                        direct_tool_lines.append(f"  - `{param_name}` ({param_type}){required_mark}: {param_desc}")

                direct_tool_lines.extend(_format_tool_contract(func))

            direct_tools_section = (
                "\n\n## 可直接调用的工具\n\n"
                "除调用子 Agent 外，你还可以**直接**使用以下工具（无需委派 Agent）：\n"
                + "\n".join(direct_tool_lines)
            )

        # 决策指南：根据是否有直接工具动态调整（排除内置工具）
        direct_tool_names = [
            t.get('function', {}).get('name', '') for t in agent.available_tools
            if t.get('function', {}).get('name', '') not in _TOOL_REGISTRY.get_builtin_tool_names()
        ]
        direct_tools_guide = ""
        if direct_tool_names:
            direct_tools_guide = f"\n- 如果任务可以通过直接工具完成（{', '.join(direct_tool_names[:3])}{'...' if len(direct_tool_names) > 3 else ''}），优先直接调用，无需委派 Agent"

        # 规则第1条：说明可用工具类型（有非内置直接工具时才说明两类）
        if direct_tool_names:
            rule1 = '1. **可用工具分为两类**：`invoke_agent_xxx`（委派子 Agent）和直接工具（见"可直接调用的工具"段）'
        else:
            rule1 = '1. **只能使用上面"可用的 Agent 工具"部分列出的工具**'

        # 构建 Skills 描述段
        skills_section = ""
        if agent.available_skills:
            skills_section = "\n\n" + agent._format_skills_description()
        return f"""{agent.base_prompt}

## 工作目标

你是主编排器。你的职责不是展示思考，而是把任务可靠地完成。优先级如下：
1. 准确理解用户需求
2. 选择成本最低且成功率最高的执行路径
3. 只有在必要时才委派子 Agent 或调用直接工具
4. 信息足够时直接输出 `<final_answer>`
5. 信息不足且无法通过现有工具补齐时，调用 `request_user_input`

## 编排原则

- 先判断能否直接回答，或由一个直接工具完成；不要机械委派
- 需要专业能力时，优先委派一个最匹配的子 Agent；只有确实存在依赖关系时才做多 Agent 链式调用
- 子 Agent 返回数据文件时只返回文件路径（格式 `[data:路径]`），不返回文件内容；收到路径后直接传给下游 Agent 或工具
- 委派子 Agent 时，task 中明确要求："返回数据文件路径，不要返回文件内容"
- 多个相互独立的任务可放在同一 `<tools>` 中并行
- 如果上一轮结果已经足够，不要重复调用相同 Agent 或工具
- 工具/Agent 报错后，下一轮应换策略、补参数或缩小任务，不要机械重试
- 最终答案使用用户语言，先给结论，再给必要细节；不确定处要明确说明边界

## 可用的 Agent 工具

你可以调用以下 Agent 来完成不同类型的任务：

{agent_tools_desc}{direct_tools_section}{skills_section}

## 输出格式

**严禁使用 `<thinking>` 标签。直接输出工具调用或答案，不写任何推理、分析、解释。**

调用 Agent：
<tools>
<tool name="{example_tool_name}">
  <task>查询2023年广西洪涝灾害受灾人口，需要分市统计</task>
</tool>
</tools>

向用户追问缺失信息：
<tools>
<tool name="request_user_input">
  <prompt>请补充缺少的关键信息</prompt>
</tool>
</tools>

给出最终答案：
<final_answer>答案内容</final_answer>

如需补充简短意图（可选，建议 1-2 句自然语言，像人在心里判断下一步，不要展开冗长推理）：
<intent>我先把问题拆成查数和展示两步，先确认数据是否足够再决定是否委派。</intent>
<tools>...</tools>

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

**规则：**
{rule1}
2. 禁止输出 `<thinking>` 标签；`<intent>` 应使用 1-2 句自然语言概括当前判断或下一步计划，像人类的简短思考摘要；不要写成长篇推理，也可直接省略
   不要写成“查数据”“调工具”“生成图表”“调用 chart_agent”这类命令式标签；应写成“我先确认数据是否完整，再决定是直接回答还是委派”这种内心独白
3. 互相独立的调用放同一 `<tools>` 中并行
4. 链式调用用 {{result_1}}, {{result_2}} 引用同轮前序结果
5. 数据充足时直接输出 `<final_answer>`{direct_tools_guide}
6. 缺少关键输入且无法自行补齐时，用 `request_user_input`
7. 调用报错时下一轮换策略，不要原样重复

### 可视化规则
- 使用 `create_chart` 生成图表，`create_map` 生成地图，一步完成
- 点图层可传 `marker_style` 自定义图标样式，例如 `icon`、`color`、`glyph`、`size`，用于区分不同 agent 或业务图层
- 工具返回 artifact_id 和预览摘要，据此判断是否满意
- 不满意时用 `revise_visualization(artifact_id, config_patch)` 修改
- 可视化 artifact 默认持久化在 `./static/temp_data`
- `artifact_id` 与磁盘文件路径的索引文件是 `./static/temp_data/viz_index.jsonl`
- 如需基于已有 artifact 继续编辑、复制思路或恢复当前配置，可先在上述目录中按 `artifact_id` 反查对应 `file_path`，再读取 JSON 内容
- 图表/地图 artifact 的持久化文件通常是 `./static/temp_data` 下的 JSON；其中 `config` 字段就是当前可编辑配置
- `revise_visualization` 默认做深度合并；若要按你读到的完整配置整体覆盖，使用 `replace=true`
- 在 `<final_answer>` 中用 `[viz:artifact_id]` 展示可视化（独占一行，前后空行），如：

[viz:viz_abc123]

- 不要编造 artifact_id，必须使用工具返回的真实 ID
- 若本次回答没有生成任何可视化，则不需要插入 `[viz:...]` 标记

### 数据文件传递规则
- 子 Agent 返回的 `[data:路径]` 引用，在 `<final_answer>` 中原样保留，让前端/用户可以访问
- 不要把 `[data:路径]` 指向的文件内容读出来塞进最终答案
- 需要把数据传给下游 Agent 时，直接在 task 中写明文件路径，不要读取内容再传递
"""

