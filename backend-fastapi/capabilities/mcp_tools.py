# -*- coding: utf-8 -*-
"""MCP capability facade."""

from __future__ import annotations

from typing import Optional

from runtime.dependencies import get_runtime_dependency
from services.mcp_service import MCPService, get_mcp_service

from .base import BaseCapability, CapabilityDescriptor


class MCPToolsCapability(BaseCapability):
    descriptor = CapabilityDescriptor(
        name='mcp_tools',
        category='mcp',
        description='Expose MCP registry, server lifecycle, and tool invocation capabilities.',
    )

    def __init__(self, *, service: Optional[MCPService] = None):
        self._service = service or get_mcp_service()

    def list_templates(self):
        return self._service.list_templates()

    def install_server_from_template(self, payload):
        return self._service.install_server_from_template(payload)

    def search_registry(self, **kwargs):
        return self._service.search_registry(**kwargs)

    def install_server_from_registry(self, payload):
        return self._service.install_server_from_registry(payload)

    def list_servers(self):
        return self._service.list_servers()

    def add_server(self, payload, *, request_id: Optional[str] = None):
        return self._service.add_server(payload, request_id=request_id)

    def update_server(self, server_name: str, payload, *, request_id: Optional[str] = None):
        return self._service.update_server(server_name, payload, request_id=request_id)

    def delete_server(self, server_name: str, *, request_id: Optional[str] = None):
        return self._service.delete_server(server_name, request_id=request_id)

    def connect_server(self, server_name: str, *, request_id: Optional[str] = None):
        return self._service.connect_server(server_name, request_id=request_id)

    def disconnect_server(self, server_name: str, *, request_id: Optional[str] = None):
        return self._service.disconnect_server(server_name, request_id=request_id)

    def test_server(self, server_name: str, *, request_id: Optional[str] = None):
        return self._service.test_server(server_name, request_id=request_id)

    def list_server_tools(self, server_name: str):
        return self._service.list_server_tools(server_name)

    def list_all_tools(self):
        return self._service.list_all_tools()


def get_mcp_tools_capability() -> MCPToolsCapability:
    return get_runtime_dependency(container_getter='get_mcp_tools_capability')
