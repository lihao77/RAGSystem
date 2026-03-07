# -*- coding: utf-8 -*-
"""
MasterAgentV2 提示构建与工具辅助函数。
"""

import json
from typing import Any, Dict

from .function_definitions import get_agent_tools

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

    # 🎯 优化 1：预检 - 快速判断是否包含占位符
    # 避免对不包含占位符的数据进行递归遍历
    data_str = str(data)
    if '{result' not in data_str:
        return data  # 提前返回，节省递归开销

    if isinstance(data, str):
        # 字符串：查找并替换所有占位符
        # 匹配 {result_N} 或 {resultN}
        pattern = r'\{result_?(\d+)\}'

        def replace_func(match):
            idx = int(match.group(1))
            if idx not in agent_results:
                agent.logger.warning(f"占位符 {match.group(0)} 引用的结果不存在")
                return match.group(0)  # 保持原样

            result = agent_results[idx]
            if not result.get('success'):
                return f"[Agent {idx} 执行失败: {result.get('error', '未知错误')}]"

            # 提取结果内容
            data_dict = result.get('data', {})
            results = data_dict.get('results', '')

            # 如果是字符串，直接返回
            if isinstance(results, str):
                return results
            # 如果是字典或列表，转为 JSON 字符串
            elif isinstance(results, (dict, list)):
                return json.dumps(results, ensure_ascii=False, indent=2)
            else:
                return str(results)

        return re.sub(pattern, replace_func, data)

    elif isinstance(data, dict):
        # 字典：递归处理每个值
        return {key: agent._replace_placeholders(value, agent_results) for key, value in data.items()}

    elif isinstance(data, list):
        # 列表：递归处理每个元素
        return [agent._replace_placeholders(item, agent_results) for item in data]

    else:
        # 其他类型：直接返回
        return data

def format_agent_result_summary(agent, result: Dict[str, Any]) -> str:
    """
    格式化 Agent 执行结果为摘要文本

    Args:
        result: Agent 执行结果

    Returns:
        str: 结果摘要（完整内容或截断）
    """
    if not result.get('success'):
        error = result.get('error', '未知错误')
        return f"执行失败: {error}"

    # 提取结果内容
    data = result.get('data', {})
    results = data.get('results', '')

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
        summary = data.get('summary', '')
        return summary if summary else "执行成功"

def get_available_agent_tools(agent):
    """
    动态获取可用的 Agent 工具列表

    延迟到执行时获取，确保其他 Agent 已经注册
    """
    return get_agent_tools(agent.orchestrator.agents)

def handle_user_input_request(
    agent,
    arguments: dict,
    event_bus,
    session_id: str,
    tool_call_id: str,
    publisher=None,
    parent_call_id: str = None,
):
    """
    处理 request_user_input 伪工具调用：发布 tool_call_start → USER_INPUT_REQUIRED 事件，
    阻塞等待用户回复，收到输入后发布 tool_call_end（result = 用户输入），让执行树可见。
    被取消时返回 None。
    """
    import uuid as _uuid
    import time as _time
    from agents.task_registry import get_task_registry
    from agents.events.bus import Event, EventType

    prompt = arguments.get('prompt', '')
    input_type = arguments.get('input_type', 'text')
    options = arguments.get('options', [])

    input_id = str(_uuid.uuid4())
    registry = get_task_registry()
    wait_evt = registry.add_pending_input(session_id, input_id) if session_id else None

    # 发布 tool_call_start，让执行树显示「等待用户输入」节点
    if publisher:
        publisher.tool_call_start(
            call_id=tool_call_id,
            tool_name='request_user_input',
            arguments=arguments,
            parent_call_id=parent_call_id,
        )

    if event_bus:
        event_bus.publish(Event(
            type=EventType.USER_INPUT_REQUIRED,
            session_id=session_id,
            agent_name=agent.name,
            data={
                "input_id": input_id,
                "tool_call_id": tool_call_id,
                "prompt": prompt,
                "input_type": input_type,
                "options": options,
            }
        ))

    agent.logger.info(
        f"[MasterV2] 等待用户输入 input_id={input_id} prompt={prompt[:60]!r}"
    )

    if wait_evt is None:
        if publisher:
            publisher.tool_call_end(
                call_id=tool_call_id,
                tool_name='request_user_input',
                result='（无 session，跳过）',
                parent_call_id=parent_call_id,
            )
        return ""

    _t0 = _time.time()
    wait_evt.wait()  # 无超时，直到 resolve_input() 或 cancel() 触发
    result = registry.get_input_result(session_id, input_id)

    # 发布 tool_call_end，result 展示用户输入内容
    if publisher:
        publisher.tool_call_end(
            call_id=tool_call_id,
            tool_name='request_user_input',
            result=result if result else '（已取消）',
            execution_time=_time.time() - _t0,
            parent_call_id=parent_call_id,
        )

    agent.logger.info(f"[MasterV2] 用户输入已接收 input_id={input_id}")
    return result if result != "" else None

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
            from agents.tools.builtin import BUILTIN_TOOL_NAMES
            direct_tool_lines = []
            for tool in agent.available_tools:
                func = tool.get('function', {})
                t_name = func.get('name', '')
                # 内置工具（如 request_user_input）不在系统提示的"可直接调用工具"段展示
                if t_name in BUILTIN_TOOL_NAMES:
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

                # 示例（如果有）
                if 'examples' in func:
                    direct_tool_lines.append("**示例**:")
                    for example in func['examples']:
                        direct_tool_lines.append(f"  ```json\n  {json.dumps(example, ensure_ascii=False)}\n  ```")

            direct_tools_section = (
                "\n\n## 可直接调用的工具\n\n"
                "除调用子 Agent 外，你还可以**直接**使用以下工具（无需委派 Agent）：\n"
                + "\n".join(direct_tool_lines)
            )

        # 决策指南：根据是否有直接工具动态调整（排除内置工具）
        from agents.tools.builtin import BUILTIN_TOOL_NAMES
        direct_tool_names = [
            t.get('function', {}).get('name', '') for t in agent.available_tools
            if t.get('function', {}).get('name', '') not in BUILTIN_TOOL_NAMES
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

## 可用的 Agent 工具

你可以调用以下 Agent 来完成不同类型的任务：

{agent_tools_desc}{direct_tools_section}{skills_section}

## 输出格式

**直接输出工具调用或答案，禁止在 <thinking> 中写分析过程。**

调用 Agent：
<tools>
<tool name="{example_tool_name}">{{"task": "查询2023年广西洪涝灾害受灾人口，需要分市统计"}}</tool>
</tools>

给出最终答案：
<answer>答案内容</answer>

如需意图备注（可选，最多10字）：
<thinking>查受灾数据</thinking>
<tools>...</tools>

**task 字段**：子Agent无对话历史，必须把所有必要信息写入 task。`context_hint`（可选）补充引导方向。

**用占位符传递上步数据**：
<tools>
<tool name="invoke_agent_chart_agent">{{"task": "生成折线图，数据：{{result_1}}，X轴=年份，Y轴=受灾人口（万人），标题='受灾人口趋势'"}}</tool>
</tools>

**规则：**
{rule1}
2. 禁止在 <thinking> 写推理、分析、解释——只允许不超过10字的动作标注，或直接省略
3. 互相独立的调用放同一 <tools> 中并行
4. 链式调用用 {{result_1}}, {{result_2}} 引用同轮前序结果
5. 数据充足时直接输出 <answer>{direct_tools_guide}
6. 调用报错时下一轮换策略

### 图表引用规则
子Agent或直接工具生成图表后系统自动全局编号。**必须**在 <answer> 按顺序插入 [CHART:N]（独占一行，前后空行）。未生成图表则不插入。
若本次回答没有生成任何图表，则不需要插入 [CHART:N] 标记。
"""
