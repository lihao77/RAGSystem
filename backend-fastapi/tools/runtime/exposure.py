# -*- coding: utf-8 -*-
"""Shared tool exposure resolution for loader and permissions."""

from __future__ import annotations

from typing import Any, Dict, List

from tools.runtime.models import ToolExposureDecision
from tools.runtime.mcp_gateway import build_mcp_tool_name
from tools.tool_registry import get_tool_registry

_TOOL_REGISTRY = get_tool_registry()
_MEMORY_TOOL_NAMES = {
    "list_memory_index",
    "read_memory_entry",
    "write_memory",
    "archive_memory",
}


def _safe_list(value) -> list:
    return list(value or [])


def _memory_exposure_decisions(agent_config) -> Dict[str, ToolExposureDecision]:
    memory_config = getattr(agent_config, 'memory', None)
    if not memory_config or getattr(memory_config, 'enabled', True) is False:
        return {}

    allowed_scopes = set(getattr(memory_config, 'allowed_scopes', []) or [])
    write_scopes = set(getattr(memory_config, 'write_scopes', []) or [])
    archive_scopes = set(getattr(memory_config, 'archive_scopes', []) or [])
    decisions: Dict[str, ToolExposureDecision] = {}

    if allowed_scopes:
        for tool_name in ("list_memory_index", "read_memory_entry"):
            decisions[tool_name] = ToolExposureDecision(
                tool_name=tool_name,
                visible=True,
                source="memory",
                reason="memory allowed_scopes enabled",
                derived_from=["memory.allowed_scopes"],
            )

    if write_scopes:
        decisions["write_memory"] = ToolExposureDecision(
            tool_name="write_memory",
            visible=True,
            source="memory",
            reason="memory write_scopes enabled",
            derived_from=["memory.write_scopes"],
        )

    if archive_scopes:
        decisions["archive_memory"] = ToolExposureDecision(
            tool_name="archive_memory",
            visible=True,
            source="memory",
            reason="memory archive_scopes enabled",
            derived_from=["memory.archive_scopes"],
        )

    return decisions


def resolve_effective_tool_exposure(agent_config) -> Dict[str, Any]:
    direct_enabled = set(_safe_list(getattr(getattr(agent_config, 'tools', None), 'enabled_tools', [])))
    decisions: Dict[str, ToolExposureDecision] = {}

    for tool_name in sorted(direct_enabled):
        decisions[tool_name] = ToolExposureDecision(
            tool_name=tool_name,
            visible=True,
            source=_TOOL_REGISTRY.get_tool_source(tool_name) or "direct",
            reason="tool explicitly enabled in agent tools.enabled_tools",
            derived_from=["tools.enabled_tools"],
        )

    decisions.update(_memory_exposure_decisions(agent_config))

    skills_config = getattr(agent_config, 'skills', None)
    enabled_skills = _safe_list(getattr(skills_config, 'enabled_skills', []) if skills_config else [])
    inject_skill_tools = bool(enabled_skills and (getattr(skills_config, 'auto_inject', True) if skills_config else True))
    if inject_skill_tools:
        for tool_name in _TOOL_REGISTRY.get_skill_tool_names():
            decisions.setdefault(
                tool_name,
                ToolExposureDecision(
                    tool_name=tool_name,
                    visible=True,
                    source="skill",
                    reason="skill system tools auto injected",
                    derived_from=["skills.enabled_skills", "skills.auto_inject"],
                ),
            )

    builtin_tools: List[str] = []
    request_user_input_tool = _TOOL_REGISTRY.get_tool_by_name('request_user_input')
    if request_user_input_tool:
        builtin_tools.append('request_user_input')
        decisions.setdefault(
            'request_user_input',
            ToolExposureDecision(
                tool_name='request_user_input',
                visible=True,
                source='builtin',
                reason='builtin tool always available',
                derived_from=['builtin'],
            ),
        )

    delegation_config = getattr(agent_config, 'delegation', None)
    enabled_agents = _safe_list(getattr(delegation_config, 'enabled_agents', []) if delegation_config else [])
    if enabled_agents:
        for tool in _TOOL_REGISTRY.get_agent_tools():
            tool_name = tool.get('function', {}).get('name')
            if not tool_name:
                continue
            decisions.setdefault(
                tool_name,
                ToolExposureDecision(
                    tool_name=tool_name,
                    visible=True,
                    source='agent',
                    reason='delegation agents enabled',
                    derived_from=['delegation.enabled_agents'],
                ),
            )

    mcp_config = getattr(agent_config, 'mcp', None)
    enabled_servers = _safe_list(getattr(mcp_config, 'enabled_servers', []) if mcp_config else [])
    mcp_servers: Dict[str, List[str]] = {}
    for server_name in enabled_servers:
        tool_names: List[str] = []
        try:
            manager_getter = getattr(agent_config, '_mcp_manager_getter', None)
            manager = manager_getter() if callable(manager_getter) else None
        except Exception:
            manager = None
        if manager is not None:
            try:
                for tool in manager.get_tools_openai_format(server_name) or []:
                    name = tool.get('function', {}).get('name')
                    if name:
                        tool_names.append(name)
            except Exception:
                tool_names = []
        mcp_servers[server_name] = tool_names
        for tool_name in tool_names:
            decisions.setdefault(
                tool_name,
                ToolExposureDecision(
                    tool_name=tool_name,
                    visible=True,
                    source='mcp',
                    reason='mcp server enabled for agent',
                    derived_from=['mcp.enabled_servers'],
                ),
            )

    return {
        'decisions': decisions,
        'direct_tool_names': sorted(
            name for name, decision in decisions.items()
            if decision.visible and decision.source not in {'skill', 'builtin', 'agent', 'mcp'}
        ),
        'memory_tool_names': sorted(name for name, d in decisions.items() if d.visible and d.source == 'memory'),
        'builtin_tool_names': builtin_tools,
        'delegation_tool_names': sorted(name for name, d in decisions.items() if d.visible and d.source == 'agent'),
        'inject_skill_tools': inject_skill_tools,
        'enabled_skill_names': enabled_skills,
        'enabled_servers': enabled_servers,
        'mcp_servers': mcp_servers,
        'all_visible_tool_names': sorted(name for name, d in decisions.items() if d.visible),
    }


def get_tool_exposure_decision(tool_name: str, agent_config) -> ToolExposureDecision:
    """
    单工具快速暴露查询——不走全量 resolve，直接按来源做针对性检查。

    调用频率高（每次 execute_tool 权限检查都调），避免全量遍历所有工具。
    全量 resolve 仅在 loader 阶段（_resolve_tools_and_skills）调用。
    """
    if not agent_config:
        return ToolExposureDecision(
            tool_name=tool_name,
            visible=False,
            source=_TOOL_REGISTRY.get_tool_source(tool_name) or 'unknown',
            reason='missing agent_config',
            derived_from=[],
        )

    # builtin：始终可见
    if tool_name == 'request_user_input' and _TOOL_REGISTRY.get_tool_by_name('request_user_input'):
        return ToolExposureDecision(
            tool_name=tool_name, visible=True, source='builtin',
            reason='builtin tool always available', derived_from=['builtin'],
        )

    # skill system tools：有任意 enabled_skills 时自动注入
    if tool_name in _TOOL_REGISTRY.get_skill_tool_names():
        skills_config = getattr(agent_config, 'skills', None)
        enabled_skills = _safe_list(getattr(skills_config, 'enabled_skills', []) if skills_config else [])
        auto_inject = getattr(skills_config, 'auto_inject', True) if skills_config else True
        visible = bool(enabled_skills and auto_inject)
        return ToolExposureDecision(
            tool_name=tool_name, visible=visible, source='skill',
            reason='skill system tools auto injected' if visible else 'no enabled skills',
            derived_from=['skills.enabled_skills', 'skills.auto_inject'],
        )

    # memory 派生工具
    if tool_name in _MEMORY_TOOL_NAMES:
        memory_decisions = _memory_exposure_decisions(agent_config)
        if tool_name in memory_decisions:
            return memory_decisions[tool_name]
        return ToolExposureDecision(
            tool_name=tool_name, visible=False, source='memory',
            reason='memory scope not configured', derived_from=[],
        )

    # agent delegation 工具
    source = _TOOL_REGISTRY.get_tool_source(tool_name)
    if source == 'agent':
        delegation_config = getattr(agent_config, 'delegation', None)
        enabled_agents = _safe_list(getattr(delegation_config, 'enabled_agents', []) if delegation_config else [])
        visible = bool(enabled_agents)
        return ToolExposureDecision(
            tool_name=tool_name, visible=visible, source='agent',
            reason='delegation agents enabled' if visible else 'no enabled agents',
            derived_from=['delegation.enabled_agents'],
        )

    # MCP 工具：只检查 server 是否启用
    from tools.runtime.mcp_gateway import parse_mcp_tool_name
    parsed_mcp = parse_mcp_tool_name(tool_name)
    if parsed_mcp:
        server_name, _ = parsed_mcp
        enabled_servers = set(_safe_list(getattr(getattr(agent_config, 'mcp', None), 'enabled_servers', [])))
        visible = server_name in enabled_servers
        return ToolExposureDecision(
            tool_name=tool_name, visible=visible, source='mcp',
            reason='mcp server enabled for agent' if visible else 'mcp server not enabled for agent',
            derived_from=['mcp.enabled_servers'],
        )

    # direct 工具：检查 enabled_tools 列表
    direct_enabled = set(_safe_list(getattr(getattr(agent_config, 'tools', None), 'enabled_tools', [])))
    visible = tool_name in direct_enabled
    return ToolExposureDecision(
        tool_name=tool_name,
        visible=visible,
        source=_TOOL_REGISTRY.get_tool_source(tool_name) or 'direct',
        reason='tool explicitly enabled' if visible else 'tool not in enabled_tools',
        derived_from=['tools.enabled_tools'],
    )


__all__ = [
    'get_tool_exposure_decision',
    'resolve_effective_tool_exposure',
]
