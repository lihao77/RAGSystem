# -*- coding: utf-8 -*-
"""Agent delegation 兼容辅助。"""

from __future__ import annotations


def _generate_agent_description(agent, agent_config):
    base_desc = agent.description if hasattr(agent, 'description') else f"{agent.name} 智能体"

    if agent_config:
        display_name = agent_config.display_name or agent.name
        desc_parts = [f"**{display_name}**"]
        desc_parts.append(f"\n**能力**: {agent_config.description or base_desc}")
        if hasattr(agent, 'available_tools') and agent.available_tools:
            tool_names = [tool['function']['name'] for tool in agent.available_tools]
            desc_parts.append(f"\n**可用工具**: {', '.join(tool_names[:5])}")
            if len(tool_names) > 5:
                desc_parts.append(f" 等共 {len(tool_names)} 个工具")
        custom_params = agent_config.custom_params or {}
        behavior = custom_params.get('behavior', {}) if isinstance(custom_params, dict) else {}
        if 'use_cases' in behavior:
            desc_parts.append(f"\n**适用场景**: {behavior['use_cases']}")
        return ''.join(desc_parts)

    return base_desc


__all__ = ['_generate_agent_description']
