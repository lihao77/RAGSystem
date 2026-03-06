# -*- coding: utf-8 -*-
"""
MCP Server 管理 API

提供 MCP Server 的 CRUD、连接管理和工具查询接口。
"""

import logging
from flask import Blueprint, jsonify, request

from mcp.config import MCPServerConfig
from mcp.config_store import get_mcp_config_store
from mcp import get_mcp_manager
from mcp.registry import MCPRegistryError, build_server_config_from_registry_install, search_registry_servers
from mcp.templates import build_server_config, list_templates

logger = logging.getLogger(__name__)

mcp_bp = Blueprint('mcp', __name__)


def _ok(data=None, message="success"):
    resp = {"success": True, "message": message}
    if data is not None:
        resp["data"] = data
    return jsonify(resp)


def _err(message: str, status: int = 400):
    return jsonify({"success": False, "message": message}), status


@mcp_bp.route('/templates', methods=['GET'])
def list_server_templates():
    """List installable MCP server templates for the frontend."""
    return _ok(list_templates())


@mcp_bp.route('/templates/install', methods=['POST'])
def install_server_from_template():
    """Install an MCP server config from a predefined template."""
    body = request.get_json(silent=True) or {}
    template_id = body.get("template_id")
    if not template_id:
        return _err("`template_id` is required")

    try:
        config = build_server_config(template_id, body)
    except ValueError as e:
        return _err(str(e))
    except Exception as e:
        return _err(f"Failed to build template config: {e}")

    store = get_mcp_config_store()
    try:
        store.add_server(config)
    except ValueError as e:
        return _err(str(e))

    manager = get_mcp_manager()
    if config.auto_connect and config.enabled:
        manager.connect_server(config.name)

    status = manager.get_server_status(config.name)
    return _ok({**config.model_dump(), **status}, message="MCP Server installed from template")


@mcp_bp.route('/registry/servers', methods=['GET'])
def search_registry():
    """Search the official MCP Registry for installable servers."""
    search = request.args.get("search", "")
    cursor = request.args.get("cursor")
    limit = request.args.get("limit", default=8, type=int)
    latest_only = request.args.get("latest_only", default="true")
    latest_only = str(latest_only).strip().lower() not in {"0", "false", "no", "off"}

    try:
        result = search_registry_servers(search=search, limit=limit, cursor=cursor, latest_only=latest_only)
    except MCPRegistryError as e:
        return _err(str(e), 502)
    except Exception as e:
        return _err(f"Failed to search MCP Registry: {e}", 500)

    return _ok(result, message=f"Found {result.get('count', 0)} MCP Registry servers")


@mcp_bp.route('/registry/install', methods=['POST'])
def install_server_from_registry():
    """Install an MCP server config from a Registry search result."""
    body = request.get_json(silent=True) or {}
    install_option = body.get("install_option")
    if not install_option:
        return _err("`install_option` is required")

    try:
        config = build_server_config_from_registry_install(install_option, body)
    except ValueError as e:
        return _err(str(e))
    except Exception as e:
        return _err(f"Failed to build registry config: {e}")

    store = get_mcp_config_store()
    try:
        store.add_server(config)
    except ValueError as e:
        return _err(str(e))

    manager = get_mcp_manager()
    if config.auto_connect and config.enabled:
        manager.connect_server(config.name)

    status = manager.get_server_status(config.name)
    return _ok({**config.model_dump(), **status}, message="MCP Server installed from Registry")


# ─── Server 列表与配置 CRUD ────────────────────────────────────────────────────

@mcp_bp.route('/servers', methods=['GET'])
def list_servers():
    """列出所有 MCP Server 及连接状态"""
    store = get_mcp_config_store()
    manager = get_mcp_manager()
    servers = store.list_servers()
    result = []
    for cfg in servers:
        name = cfg.get("name") or cfg.get("server_name", "")
        status_info = manager.get_server_status(name)
        result.append({**cfg, **status_info})
    return _ok(result)


@mcp_bp.route('/servers', methods=['POST'])
def add_server():
    """添加 MCP Server 配置"""
    body = request.get_json(silent=True) or {}
    try:
        config = MCPServerConfig(**body)
    except Exception as e:
        return _err(f"配置验证失败: {e}")

    store = get_mcp_config_store()
    try:
        store.add_server(config)
    except ValueError as e:
        return _err(str(e))

    # 如果 auto_connect=True，立即尝试连接
    if config.auto_connect and config.enabled:
        manager = get_mcp_manager()
        manager.connect_server(config.name)

    return _ok({"name": config.name}, message="MCP Server 添加成功")


@mcp_bp.route('/servers/<server_name>', methods=['PUT'])
def update_server(server_name: str):
    """Update MCP server config and refresh runtime state."""
    body = request.get_json(silent=True) or {}
    body.pop("name", None)

    store = get_mcp_config_store()
    existing = store.get_server(server_name)
    if existing is None:
        return _err(f"MCP Server not found: {server_name}", 404)

    merged = {**existing, **body, "name": server_name}
    try:
        config = MCPServerConfig(**merged)
    except Exception as e:
        return _err(f"Configuration validation failed: {e}")

    persisted = config.model_dump(exclude_none=False)
    persisted.pop("name", None)
    store.update_server(server_name, persisted)

    status = get_mcp_manager().refresh_server(server_name)
    message = "MCP Server configuration updated and applied"
    if status.get("status") == "error":
        message = "MCP Server configuration updated, but reconnect failed"

    return _ok(status, message=message)


@mcp_bp.route('/servers/<server_name>', methods=['DELETE'])
def delete_server(server_name: str):
    """删除 MCP Server 配置（先断开连接）"""
    manager = get_mcp_manager()
    manager.disconnect_server(server_name)

    # 移除权限注册
    from tools.permissions import unregister_mcp_tool_permissions
    unregister_mcp_tool_permissions(server_name)

    store = get_mcp_config_store()
    try:
        store.remove_server(server_name)
    except ValueError as e:
        return _err(str(e), 404)
    return _ok(message="MCP Server 已删除")


# ─── 连接管理 ─────────────────────────────────────────────────────────────────

@mcp_bp.route('/servers/<server_name>/connect', methods=['POST'])
def connect_server(server_name: str):
    """连接到指定 MCP Server"""
    manager = get_mcp_manager()
    try:
        success = manager.connect_server(server_name)
    except ValueError as e:
        return _err(str(e), 404)

    status = manager.get_server_status(server_name)
    if success:
        return _ok(status, message="连接成功")
    else:
        return _err(status.get("error_message", "连接失败"))


@mcp_bp.route('/servers/<server_name>/disconnect', methods=['POST'])
def disconnect_server(server_name: str):
    """断开指定 MCP Server"""
    manager = get_mcp_manager()
    manager.disconnect_server(server_name)
    return _ok(message="已断开连接")


@mcp_bp.route('/servers/<server_name>/test', methods=['POST'])
def test_server(server_name: str):
    """测试连接（断开并重连）"""
    manager = get_mcp_manager()
    result = manager.test_connection(server_name)
    if result["success"]:
        return _ok(result, message=result["message"])
    else:
        return _err(result["message"])


# ─── 工具查询 ─────────────────────────────────────────────────────────────────

@mcp_bp.route('/servers/<server_name>/tools', methods=['GET'])
def list_server_tools(server_name: str):
    """列出指定 MCP Server 提供的工具（OpenAI 格式）"""
    manager = get_mcp_manager()
    tools = manager.get_tools_openai_format(server_name)
    return _ok({
        "server_name": server_name,
        "tool_count": len(tools),
        "tools": tools
    })


@mcp_bp.route('/tools', methods=['GET'])
def list_all_tools():
    """列出所有已连接 MCP Server 的工具"""
    manager = get_mcp_manager()
    tools = manager.get_tools_openai_format()
    return _ok({
        "tool_count": len(tools),
        "tools": tools
    })
