# -*- coding: utf-8 -*-
"""OrchestratorAgent 提示辅助与结果处理函数。"""

from __future__ import annotations

from typing import Any, Dict

from agents.core import prompting as core_prompting
from tools.refs.result_references import (
    is_ref_error,
    resolve_result_path,
    result_error_message,
    result_primary_content,
    result_success,
    result_summary,
    stringify_result_value,
)
from tools.tool_registry import get_tool_registry

_TOOL_REGISTRY = get_tool_registry()


def _format_tool_contract(func: Dict[str, Any]) -> list[str]:
    return core_prompting.format_tool_contract(func)


def get_agent_display_name(agent, agent_name: str) -> str:
    orchestrator = getattr(agent, 'orchestrator', None)
    if not orchestrator or not getattr(orchestrator, 'agents', None):
        return agent_name
    target_agent = orchestrator.agents.get(agent_name)
    if target_agent and hasattr(target_agent, 'agent_config') and target_agent.agent_config:
        display_name = target_agent.agent_config.display_name
        if display_name:
            return display_name
    return agent_name


def replace_placeholders(agent, data: Any, agent_results: Dict[int, Dict[str, Any]]) -> Any:
    import re

    placeholder_pattern = re.compile(
        r'\{result_?(\d+)(?:\.([a-zA-Z0-9_\.]+))?\}',
        re.IGNORECASE,
    )

    data_str = str(data)
    if not placeholder_pattern.search(data_str):
        return data

    if isinstance(data, str):
        def replace_func(match):
            idx = int(match.group(1))
            json_path = match.group(2)
            if idx not in agent_results:
                agent.logger.warning(f"占位符 {match.group(0)} 引用的结果不存在")
                return match.group(0)

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

    if isinstance(data, dict):
        return {key: agent._replace_placeholders(value, agent_results) for key, value in data.items()}
    if isinstance(data, list):
        return [agent._replace_placeholders(item, agent_results) for item in data]
    return data


def format_agent_result_summary(agent, result: Any) -> str:
    del agent
    if not result_success(result):
        return f"执行失败: {result_error_message(result)}"

    results = result_primary_content(result)
    if isinstance(results, str) and results:
        if len(results) <= 500:
            return results
        return results[:500] + "..."
    if isinstance(results, dict):
        return f"返回了 {len(results)} 个字段"
    if isinstance(results, list):
        return f"返回了 {len(results)} 条记录"
    summary = result_summary(result)
    return summary if summary else "执行成功"


def _build_agent_roster(agent):
    orchestrator = getattr(agent, 'orchestrator', None)
    if not orchestrator or not getattr(orchestrator, 'agents', None):
        return []
    delegation = getattr(getattr(agent, 'agent_config', None), 'delegation', None)
    enabled_agents = list(getattr(delegation, 'enabled_agents', []) or [])
    roster = []
    for agent_name in enabled_agents:
        if agent_name == getattr(agent, 'name', None):
            continue
        target_agent = agent.orchestrator.agents.get(agent_name)
        if target_agent is None:
            continue
        target_config = getattr(target_agent, 'agent_config', None)
        description = getattr(target_config, 'description', None) or getattr(target_agent, 'description', '')
        custom_params = getattr(target_config, 'custom_params', {}) or {}
        behavior = custom_params.get('behavior', {}) if isinstance(custom_params, dict) else {}
        roster.append({
            'agent_name': agent_name,
            'display_name': get_agent_display_name(agent, agent_name),
            'description': description,
            'use_cases': behavior.get('use_cases'),
            'tool_count': len(getattr(target_agent, 'available_tools', []) or []),
        })
    return roster


def get_available_agent_tools(agent):
    tools = []
    roster = _build_agent_roster(agent)
    if not roster:
        return tools
    for tool_name in ('call_agent', 'list_child_agents', 'send_message'):
        tool = _TOOL_REGISTRY.get_tool_by_name(tool_name)
        if tool:
            tools.append(tool)
    return tools


def get_orchestrator_cache_key_extra(agent) -> Any:
    """
    提供 OrchestratorAgent 独有的 system_prompt cache key 成分。
    当可委派的子 Agent 列表或其配置变化时，key 随之变化，触发重建。
    """
    roster = _build_agent_roster(agent)
    return [
        {
            'agent_name': r['agent_name'],
            'display_name': r['display_name'],
            'description': r['description'],
            'use_cases': r['use_cases'],
            'tool_count': r['tool_count'],
        }
        for r in roster
    ]


def build_orchestrator_specific_sections(agent) -> list[str]:
    available_agent_tools = get_available_agent_tools(agent)
    roster = _build_agent_roster(agent)
    if not available_agent_tools:
        return []

    lines = [
        '## 子 Agent 委派',
        '',
        '你可以通过 `call_agent` 创建子 Agent，通过 `list_child_agents` 找回已有 child_agent_id，并通过 `send_message` 继续既有子 Agent。',
    ]
    for tool in available_agent_tools:
        func = tool['function']
        lines.extend([
            '',
            f"### {func.get('name', '')}",
            f"**描述**: {func.get('description', '')}",
            f"**调用能力**: {core_prompting.format_allowed_callers(func)}",
        ])
        params = func.get('parameters', {})
        if params and 'properties' in params:
            lines.append('**参数**:')
            required = params.get('required', [])
            for param_name, param_info in params['properties'].items():
                required_mark = ' (必填)' if param_name in required else ' (可选)'
                lines.append(
                    f"  - `{param_name}` ({param_info.get('type', 'any')}){required_mark}: {param_info.get('description', '')}"
                )
        lines.extend(_format_tool_contract(func))

    lines.extend([
        '',
        '## 当前可委派子 Agent 列表',
        '',
        '只能从下面名单中选择 `agent_name`：',
    ])
    for item in roster:
        lines.append('')
        lines.append(f"### {item['agent_name']}")
        lines.append(f"- display_name: {item['display_name']}")
        lines.append(f"- description: {item['description']}")
        if item.get('use_cases'):
            lines.append(f"- use_cases: {item['use_cases']}")
        lines.append(f"- tool_count: {item['tool_count']}")

    direct_tool_names = [
        tool.get('function', {}).get('name', '')
        for tool in core_prompting.get_direct_tools_for_prompt(agent)
    ]
    direct_tools_guide = ''
    if direct_tool_names:
        preview = ', '.join(direct_tool_names[:3])
        suffix = '...' if len(direct_tool_names) > 3 else ''
        direct_tools_guide = f"如果任务可由直接工具完成（{preview}{suffix}），优先直接调用，无需委派。"

    example_agent = roster[0]['agent_name'] if roster else 'qa_agent'
    orchestration_section = f"""## 委派规则

- {direct_tools_guide if direct_tools_guide else '只有在直接回答或直接工具不足时，才委派子 Agent。'}
- 委派决策顺序始终是：直答 > direct tool > 单子 Agent > 多 Agent
- `agent_name` 必须从上面的 allowlist 中选择
- 只有任务确实需要目标 Agent 的专长或独立上下文时，才使用 `call_agent`
- 若一个子 Agent 足以完成任务，就不要拆成多个子 Agent；只有自然存在前后依赖或明显并行收益时才做多 Agent 编排
- `task` 必须写完整上下文；首次创建子 Agent 用 `call_agent`
- 不确定之前的 `child_agent_id` 时，先用 `list_child_agents(agent_name?)` 找回
- 已有合适 `child_agent_id` 时，优先用 `send_message(child_agent_id, message)` 续接既有子 Agent，而不是重新创建新会话
- `context_hint` 用于补充约束、口径、输出格式或边界
- 需要链式传递时，优先使用 `{{result_N.content}}` 或 `{{result_N.metadata.child_agent_id}}`
- 子 Agent 已返回足够结果时，主编排器应直接收束并输出最终答案；不要为了“再润色一下”继续委派
- 子 Agent 失败后，下一次委派必须改变任务描述、范围、输入或目标；不要原样重发同一委派任务

创建子 Agent：
<tools>
<tool name="call_agent">
  <agent_name>{example_agent}</agent_name>
  <task>查询2023年广西洪涝灾害受灾人口，需要分市统计</task>
  <context_hint>返回 Markdown 表格，并保留统计口径说明</context_hint>
</tool>
</tools>

续接已有子 Agent 前先找回 id：
<tools>
<tool name="list_child_agents">
  <agent_name>{example_agent}</agent_name>
</tool>
</tools>

续接已有子 Agent：
<tools>
<tool name="send_message">
  <child_agent_id>{{result_1.content.items.0.child_agent_id}}</child_agent_id>
  <message>继续基于上一轮结果补充结论，并输出最终摘要</message>
</tool>
</tools>"""

    return ['\n'.join(lines), orchestration_section]
