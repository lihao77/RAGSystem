# -*- coding: utf-8 -*-
"""Predefined MCP server templates for frontend installation flows."""

from pathlib import Path
from typing import Any, Dict, List

from .config import MCPServerConfig


MCP_SERVER_TEMPLATES: List[Dict[str, Any]] = [
    {
        "id": "filesystem",
        "display_name": "Filesystem",
        "description": "Read and write files inside an allowed local directory.",
        "transport": "stdio",
        "recommended_server_name": "filesystem",
        "install_hint": "Uses `npx -y @anthropic-ai/mcp-server-filesystem`.",
        "fields": [
            {
                "name": "root_path",
                "label": "Root Path",
                "type": "path",
                "required": False,
                "default": str(Path.cwd()),
                "placeholder": str(Path.cwd()),
                "help": "Only files under this directory will be accessible.",
            }
        ],
        "defaults": {
            "display_name": "Filesystem",
            "enabled": True,
            "auto_connect": True,
            "timeout": 30,
            "risk_level": "medium",
            "requires_approval": False,
        },
    },
    {
        "id": "brave_search",
        "display_name": "Brave Search",
        "description": "Search the web through Brave Search API.",
        "transport": "stdio",
        "recommended_server_name": "brave_search",
        "install_hint": "Uses `npx -y @anthropic-ai/mcp-server-brave-search`.",
        "fields": [
            {
                "name": "brave_api_key",
                "label": "Brave API Key",
                "type": "password",
                "required": True,
                "default": "",
                "placeholder": "Enter BRAVE_API_KEY",
                "help": "Required for Brave Search MCP server.",
            }
        ],
        "defaults": {
            "display_name": "Brave Search",
            "enabled": True,
            "auto_connect": True,
            "timeout": 30,
            "risk_level": "low",
            "requires_approval": False,
        },
    },
    {
        "id": "remote_sse",
        "display_name": "Remote SSE",
        "description": "Connect to a remote MCP server over SSE.",
        "transport": "sse",
        "recommended_server_name": "remote_sse",
        "install_hint": "Connects to an already deployed remote MCP server.",
        "fields": [
            {
                "name": "url",
                "label": "SSE URL",
                "type": "url",
                "required": True,
                "default": "http://localhost:8080/sse",
                "placeholder": "http://localhost:8080/sse",
                "help": "Remote MCP SSE endpoint.",
            }
        ],
        "defaults": {
            "display_name": "Remote SSE",
            "enabled": True,
            "auto_connect": True,
            "timeout": 60,
            "risk_level": "medium",
            "requires_approval": False,
        },
    },
]


def list_templates() -> List[Dict[str, Any]]:
    return MCP_SERVER_TEMPLATES


def get_template(template_id: str) -> Dict[str, Any] | None:
    return next((template for template in MCP_SERVER_TEMPLATES if template["id"] == template_id), None)


def build_server_config(template_id: str, payload: Dict[str, Any]) -> MCPServerConfig:
    template = get_template(template_id)
    if template is None:
        raise ValueError(f"Unknown MCP template: {template_id}")

    options = payload.get("options") or {}
    defaults = template.get("defaults", {})
    server_name = payload.get("server_name") or template.get("recommended_server_name") or template_id
    display_name = payload.get("display_name") or defaults.get("display_name") or template["display_name"]

    config_data: Dict[str, Any] = {
        "name": server_name,
        "display_name": display_name,
        "transport": template["transport"],
        "enabled": payload.get("enabled", defaults.get("enabled", True)),
        "auto_connect": payload.get("auto_connect", defaults.get("auto_connect", True)),
        "timeout": payload.get("timeout", defaults.get("timeout", 30)),
        "risk_level": payload.get("risk_level", defaults.get("risk_level", "medium")),
        "requires_approval": payload.get("requires_approval", defaults.get("requires_approval", False)),
    }

    if template_id == "filesystem":
        root_path = options.get("root_path") or str(Path.cwd())
        config_data.update(
            {
                "command": "npx",
                "args": ["-y", "@anthropic-ai/mcp-server-filesystem", root_path],
                "env": {},
            }
        )
    elif template_id == "brave_search":
        brave_api_key = (options.get("brave_api_key") or "").strip()
        if not brave_api_key:
            raise ValueError("`brave_api_key` is required for the Brave Search template")
        config_data.update(
            {
                "command": "npx",
                "args": ["-y", "@anthropic-ai/mcp-server-brave-search"],
                "env": {"BRAVE_API_KEY": brave_api_key},
            }
        )
    elif template_id == "remote_sse":
        url = (options.get("url") or "").strip()
        if not url:
            raise ValueError("`url` is required for the Remote SSE template")
        config_data["url"] = url
    else:
        raise ValueError(f"Unsupported MCP template: {template_id}")

    return MCPServerConfig(**config_data)
