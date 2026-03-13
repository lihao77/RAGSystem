# -*- coding: utf-8 -*-
"""Unified registry for tool contracts and tool definitions."""

from __future__ import annotations

from copy import deepcopy

from tools.catalog.agent_tools import AGENT_TOOLS_EXAMPLE, get_agent_tools
from tools.catalog.builtin_tools import (
    BUILTIN_TOOL_NAMES,
    REQUEST_USER_INPUT_CONTRACT,
    REQUEST_USER_INPUT_TOOL,
    get_builtin_tools_for_orchestrator,
    get_builtin_tools_for_worker,
)
from tools.catalog.document_tools import DOCUMENT_TOOL_CONTRACTS, DOCUMENT_TOOLS
from tools.catalog.mcp_tools import (
    MCP_TOOL_PREFIX,
    is_mcp_tool,
    mcp_tool_to_openai_format,
    mcp_tools_to_openai_format,
    parse_mcp_tool_name,
)
from tools.catalog.skill_tools import SKILLS_SYSTEM_TOOLS, SKILLS_TOOL_NAMES, SKILL_TOOL_CONTRACTS
from tools.catalog.static_tools import STATIC_TOOL_CONTRACTS, STATIC_TOOLS


class ToolRegistry:
    """Canonical access layer for tool definitions grouped by source."""

    def get_static_contracts(self):
        return deepcopy(STATIC_TOOL_CONTRACTS)

    def get_static_tools(self):
        return deepcopy(STATIC_TOOLS)

    def get_document_contracts(self):
        return deepcopy(DOCUMENT_TOOL_CONTRACTS)

    def get_document_tools(self):
        return deepcopy(DOCUMENT_TOOLS)

    def get_default_tools(self):
        return deepcopy(STATIC_TOOLS + DOCUMENT_TOOLS)

    def get_all_base_tools(self):
        return self.get_default_tools()

    def get_configurable_tools(self):
        """Tools that can be listed in agent tool configuration."""
        return self.get_default_tools()

    def get_tool_names(self):
        return [tool["function"]["name"] for tool in self.get_default_tools()]

    def get_tool_by_name(self, name: str):
        for tool in self.get_default_tools():
            if tool["function"]["name"] == name:
                return tool
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
        if name in {"process_data_file", "transform_data"}:
            return "data"
        if name in {"generate_chart", "update_chart_config", "present_chart", "generate_map"}:
            return "visualization"
        if name == "execute_code":
            return "execution"
        if source == "skill":
            return "skill"
        if source == "builtin":
            return "builtin"
        if source == "agent":
            return "agent"
        if source == "mcp":
            return "mcp"
        return "other"

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

    def get_request_user_input_contract(self):
        return deepcopy(REQUEST_USER_INPUT_CONTRACT)

    def get_request_user_input_tool(self):
        return deepcopy(REQUEST_USER_INPUT_TOOL)

    def get_builtin_tool_names(self):
        return set(BUILTIN_TOOL_NAMES)

    def get_skill_contracts(self):
        return deepcopy(SKILL_TOOL_CONTRACTS)

    def get_skill_tools(self):
        return deepcopy(SKILLS_SYSTEM_TOOLS)

    def get_skill_tool_names(self):
        return set(SKILLS_TOOL_NAMES)

    def get_builtin_tools_for_worker(self, base_tools: list[dict]):
        return get_builtin_tools_for_worker(base_tools)

    def get_builtin_tools_for_orchestrator(self, base_tools: list[dict]):
        return get_builtin_tools_for_orchestrator(base_tools)

    def get_agent_tools(self, agents_dict):
        return get_agent_tools(agents_dict)

    def get_agent_tool_examples(self):
        return deepcopy(AGENT_TOOLS_EXAMPLE)

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
