# -*- coding: utf-8 -*-
"""
MCP 服务层。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
from typing import Any, Dict, Optional

from execution.adapters.mcp_execution import MCPExecutionAdapter
from mcp import get_mcp_manager
from mcp.config import MCPServerConfig
from mcp.config_store import get_mcp_config_store
from mcp.registry import MCPRegistryError, build_server_config_from_registry_install, search_registry_servers
from mcp.templates import build_server_config, list_templates
from tools.permissions import unregister_mcp_tool_permissions


class MCPServiceError(Exception):
    """MCP 业务异常。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class MCPService:
    """封装 MCP 模板安装、Registry 查询、配置与连接管理。"""

    def __init__(
        self,
        *,
        store=None,
        manager=None,
        template_builder=None,
        template_lister=None,
        registry_searcher=None,
        registry_installer=None,
        permission_unregistrar=None,
        execution_adapter=None,
    ):
        self._store = store or get_mcp_config_store()
        self._manager = manager or get_mcp_manager()
        self._template_builder = template_builder or build_server_config
        self._template_lister = template_lister or list_templates
        self._registry_searcher = registry_searcher or search_registry_servers
        self._registry_installer = registry_installer or build_server_config_from_registry_install
        self._permission_unregistrar = permission_unregistrar or unregister_mcp_tool_permissions
        self._execution_adapter = execution_adapter or MCPExecutionAdapter()

    def list_templates(self) -> list[Dict[str, Any]]:
        return self._template_lister()

    def install_server_from_template(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        body = payload or {}
        template_id = body.get('template_id')
        if not template_id:
            raise MCPServiceError('`template_id` is required', status_code=400)

        try:
            config = self._template_builder(template_id, body)
        except ValueError as error:
            raise MCPServiceError(str(error), status_code=400) from error
        except Exception as error:
            raise MCPServiceError(f'Failed to build template config: {error}', status_code=400) from error

        self._save_and_connect_if_needed(config)
        status = self._manager.get_server_status(config.name)
        return {**config.model_dump(), **status}

    def search_registry(self, *, search: str = '', cursor: Optional[str] = None, limit: int = 8, latest_only: bool = True) -> Dict[str, Any]:
        try:
            return self._registry_searcher(
                search=search,
                limit=limit,
                cursor=cursor,
                latest_only=latest_only,
            )
        except MCPRegistryError as error:
            raise MCPServiceError(str(error), status_code=502) from error
        except Exception as error:
            raise MCPServiceError(f'Failed to search MCP Registry: {error}', status_code=500) from error

    def install_server_from_registry(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        body = payload or {}
        install_option = body.get('install_option')
        if not install_option:
            raise MCPServiceError('`install_option` is required', status_code=400)

        try:
            config = self._registry_installer(install_option, body)
        except ValueError as error:
            raise MCPServiceError(str(error), status_code=400) from error
        except Exception as error:
            raise MCPServiceError(f'Failed to build registry config: {error}', status_code=400) from error

        self._save_and_connect_if_needed(config)
        status = self._manager.get_server_status(config.name)
        return {**config.model_dump(), **status}

    def list_servers(self) -> list[Dict[str, Any]]:
        result = []
        for config in self._store.list_servers():
            server_name = config.get('name') or config.get('server_name', '')
            status_info = self._manager.get_server_status(server_name)
            result.append({**config, **status_info})
        return result

    def add_server(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        body = payload or {}
        try:
            config = MCPServerConfig(**body)
        except Exception as error:
            raise MCPServiceError(f'配置验证失败: {error}', status_code=400) from error

        self._save_and_connect_if_needed(config)
        return {'name': config.name}

    def update_server(self, server_name: str, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        body = dict(payload or {})
        body.pop('name', None)

        existing = self._store.get_server(server_name)
        if existing is None:
            raise MCPServiceError(f'MCP Server not found: {server_name}', status_code=404)

        merged = {**existing, **body, 'name': server_name}
        try:
            config = MCPServerConfig(**merged)
        except Exception as error:
            raise MCPServiceError(f'Configuration validation failed: {error}', status_code=400) from error

        persisted = config.model_dump(exclude_none=False)
        persisted.pop('name', None)
        self._store.update_server(server_name, persisted)
        return self._execution_adapter.refresh_server(server_name, manager=self._manager)

    def delete_server(self, server_name: str) -> None:
        self._execution_adapter.disconnect_server(server_name, manager=self._manager)
        self._permission_unregistrar(server_name)
        try:
            self._store.remove_server(server_name)
        except ValueError as error:
            raise MCPServiceError(str(error), status_code=404) from error

    def connect_server(self, server_name: str) -> Dict[str, Any]:
        try:
            result = self._execution_adapter.connect_server(server_name, manager=self._manager)
            success = result.get('success', False)
        except ValueError as error:
            raise MCPServiceError(str(error), status_code=404) from error

        status = result.get('status') if 'result' in locals() else self._manager.get_server_status(server_name)
        if not success:
            raise MCPServiceError(status.get('error_message', '连接失败'), status_code=400)
        return status

    def disconnect_server(self, server_name: str) -> None:
        self._execution_adapter.disconnect_server(server_name, manager=self._manager)

    def test_server(self, server_name: str) -> Dict[str, Any]:
        result = self._execution_adapter.test_server(server_name, manager=self._manager)
        if not result.get('success'):
            raise MCPServiceError(result.get('message', '连接失败'), status_code=400)
        return result

    def call_tool(self, server_name: str, tool_name: str, arguments: dict, *, session_id: Optional[str] = None) -> dict:
        return self._execution_adapter.call_tool(
            server_name,
            tool_name,
            arguments,
            manager=self._manager,
            session_id=session_id,
        )

    def list_server_tools(self, server_name: str) -> Dict[str, Any]:
        tools = self._manager.get_tools_openai_format(server_name)
        return {
            'server_name': server_name,
            'tool_count': len(tools),
            'tools': tools,
        }

    def list_all_tools(self) -> Dict[str, Any]:
        tools = self._manager.get_tools_openai_format()
        return {
            'tool_count': len(tools),
            'tools': tools,
        }

    def _save_and_connect_if_needed(self, config: MCPServerConfig) -> None:
        try:
            self._store.add_server(config)
        except ValueError as error:
            raise MCPServiceError(str(error), status_code=400) from error

        if config.auto_connect and config.enabled:
            self._execution_adapter.connect_server(config.name, manager=self._manager)


_mcp_service: Optional[MCPService] = None


def get_mcp_service() -> MCPService:
    global _mcp_service
    return get_runtime_dependency(
        container_getter='get_mcp_service',
        fallback_name='mcp_service',
        fallback_factory=MCPService,
        require_container=True,
        legacy_getter=lambda: _mcp_service,
        legacy_setter=lambda instance: globals().__setitem__('_mcp_service', instance),
    )
