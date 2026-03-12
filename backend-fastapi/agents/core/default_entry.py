# -*- coding: utf-8 -*-
"""Default entry agent resolution."""

from __future__ import annotations

from typing import Optional


class DefaultEntryAgentProvider:
    """Resolve which agent should be used as the default entry point."""

    def __init__(
        self,
        default_agent_name: Optional[str] = None,
        fallback_agent_name: Optional[str] = "orchestrator_agent",
    ):
        self._default_agent_name = default_agent_name
        self._fallback_agent_name = fallback_agent_name

    def set_default_agent_name(self, agent_name: Optional[str]) -> None:
        self._default_agent_name = agent_name

    def get_default_agent_name(self) -> Optional[str]:
        return self._default_agent_name

    def get_fallback_agent_name(self) -> Optional[str]:
        return self._fallback_agent_name

    def resolve_name(self, registry) -> Optional[str]:
        if self._default_agent_name and registry.get(self._default_agent_name):
            return self._default_agent_name
        if self._fallback_agent_name and registry.get(self._fallback_agent_name):
            return self._fallback_agent_name
        return None
