# -*- coding: utf-8 -*-
"""Canonical tool definition catalog grouped by source."""

from .agent_tools import AGENT_TOOLS_EXAMPLE, get_agent_tools
from .builtin_tools import (
    BUILTIN_TOOL_NAMES,
    REQUEST_USER_INPUT_CONTRACT,
    REQUEST_USER_INPUT_TOOL,
    get_builtin_tools_for_master,
    get_builtin_tools_for_react,
)
from .document_tools import DOCUMENT_TOOL_CONTRACTS, DOCUMENT_TOOLS
from .mcp_tools import (
    MCP_TOOL_PREFIX,
    is_mcp_tool,
    mcp_tool_to_openai_format,
    mcp_tools_to_openai_format,
    parse_mcp_tool_name,
)
from .skill_tools import SKILLS_SYSTEM_TOOLS, SKILLS_TOOL_NAMES, SKILL_TOOL_CONTRACTS
from .static_tools import STATIC_TOOL_CONTRACTS, STATIC_TOOLS

__all__ = [
    "AGENT_TOOLS_EXAMPLE",
    "BUILTIN_TOOL_NAMES",
    "DOCUMENT_TOOL_CONTRACTS",
    "DOCUMENT_TOOLS",
    "MCP_TOOL_PREFIX",
    "REQUEST_USER_INPUT_CONTRACT",
    "REQUEST_USER_INPUT_TOOL",
    "SKILLS_SYSTEM_TOOLS",
    "SKILLS_TOOL_NAMES",
    "SKILL_TOOL_CONTRACTS",
    "STATIC_TOOL_CONTRACTS",
    "STATIC_TOOLS",
    "get_agent_tools",
    "get_builtin_tools_for_master",
    "get_builtin_tools_for_react",
    "is_mcp_tool",
    "mcp_tool_to_openai_format",
    "mcp_tools_to_openai_format",
    "parse_mcp_tool_name",
]
