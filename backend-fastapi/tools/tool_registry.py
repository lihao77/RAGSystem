# -*- coding: utf-8 -*-
"""Unified registry for tool contracts and tool definitions."""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Iterable

from tools.catalog.mcp_tools import (
    MCP_TOOL_PREFIX,
    is_mcp_tool,
    mcp_tool_to_openai_format,
    mcp_tools_to_openai_format,
    parse_mcp_tool_name,
)
from tools.catalog.static_tools import STATIC_TOOL_CONTRACTS
from tools.tool_definition_builder import build_function_tools

logger = logging.getLogger(__name__)


class ToolRegistry:
    """Canonical access layer for tool definitions grouped by source."""

    def __init__(self):
        self._extra_contracts: list = []
        self._static_tools_cache: list | None = None

    def register_extra_contracts(self, contracts: list) -> None:
        """注册扩展/装饰器工具契约。"""
        if not contracts:
            return
        merged = {contract.name: contract for contract in self._extra_contracts}
        merged.update({contract.name: contract for contract in contracts})
        self._extra_contracts = list(merged.values())
        self._static_tools_cache = None
        logger.info("注册额外工具契约: %s", [c.name for c in contracts])

    def get_static_contracts(self):
        return deepcopy(STATIC_TOOL_CONTRACTS) + deepcopy(self._extra_contracts)

    def get_static_tools(self):
        if self._static_tools_cache is not None:
            return deepcopy(self._static_tools_cache)
        self._static_tools_cache = build_function_tools(self.get_static_contracts())
        return deepcopy(self._static_tools_cache)

    def get_default_tools(self):
        """返回所有非 MCP 的基础工具定义。"""
        return self.get_static_tools()

    def get_all_base_tools(self):
        return self.get_default_tools()

    def get_tools_by_source(self, sources: str | Iterable[str]):
        if isinstance(sources, str):
            source_set = {sources}
        else:
            source_set = set(sources)
        return [
            tool for tool in self.get_default_tools()
            if tool.get("function", {}).get("source") in source_set
        ]

    def get_document_tools(self):
        return self.get_tools_by_source("document")

    def get_skill_tools(self):
        return self.get_tools_by_source("skill")

    def get_builtin_tools(self):
        return self.get_tools_by_source("builtin")

    def get_agent_tools(self):
        return self.get_tools_by_source("agent")

    def get_configurable_tools(self):
        """只返回由 tools.enabled_tools 显式配置的本地 direct 工具。"""
        return [
            tool for tool in self.get_default_tools()
            if tool.get("function", {}).get("source") not in {"builtin", "agent", "skill", "mcp"}
        ]

    def get_tool_names(self):
        return [tool["function"]["name"] for tool in self.get_default_tools()]

    def get_tool_by_name(self, name: str):
        for tool in self.get_default_tools():
            if tool["function"]["name"] == name:
                return deepcopy(tool)
        return None

    def get_tool_source(self, name: str) -> str | None:
        tool = self.get_tool_by_name(name)
        if not tool:
            return None
        return tool.get("function", {}).get("source")

    def get_tool_category(self, name: str) -> str:
        source = self.get_tool_source(name)
        if source == "document":
            return "document"
        if name in {"execute_code", "execute_bash"}:
            return "execution"
        if source == "skill":
            return "skill"
        if source == "builtin":
            return "builtin"
        if source == "agent":
            return "agent"
        if source == "mcp":
            return "mcp"
        return "local"

    def list_configurable_tool_summaries(self):
        summaries = []
        for tool in self.get_configurable_tools():
            function_def = tool.get("function", {})
            tool_name = function_def.get("name", "")
            summaries.append({
                "name": tool_name,
                "display_name": tool_name.replace("_", " ").title(),
                "description": function_def.get("description", ""),
                "category": self.get_tool_category(tool_name),
                "source": function_def.get("source", "static"),
            })
        return summaries

    def get_code_callable_tools(self):
        return [
            tool["function"]["name"]
            for tool in self.get_default_tools()
            if "code_execution" in tool["function"].get("allowed_callers", ["direct"])
        ]

    def get_builtin_tool_names(self):
        return {tool["function"]["name"] for tool in self.get_builtin_tools()}

    def get_skill_tool_names(self):
        return {tool["function"]["name"] for tool in self.get_skill_tools()}

    def get_mcp_tool_prefix(self):
        return MCP_TOOL_PREFIX

    def mcp_tool_to_openai_format(self, server_name: str, mcp_tool):
        return mcp_tool_to_openai_format(server_name, mcp_tool)

    def mcp_tools_to_openai_format(self, server_name: str, mcp_tools: list):
        return mcp_tools_to_openai_format(server_name, mcp_tools)

    def parse_mcp_tool_name(self, tool_name: str):
        return parse_mcp_tool_name(tool_name)

    def is_mcp_tool(self, tool_name: str) -> bool:
        return is_mcp_tool(tool_name)


_TOOL_REGISTRY = ToolRegistry()


def get_tool_registry() -> ToolRegistry:
    return _TOOL_REGISTRY
