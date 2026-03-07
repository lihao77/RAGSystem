# -*- coding: utf-8 -*-
"""
Agent API 路由兼容入口。
"""

from .agent_api import agent_bp, reload_agents

__all__ = ['agent_bp', 'reload_agents']
