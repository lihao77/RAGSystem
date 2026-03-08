# -*- coding: utf-8 -*-
"""
MCP Server 管理 API

提供 MCP Server 的 CRUD、连接管理和工具查询接口。
"""

import logging
from flask import Blueprint, jsonify, request

from execution.observability import ensure_request_id
from services.mcp_service import MCPServiceError, get_mcp_service

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
    return _ok(get_mcp_service().list_templates())


@mcp_bp.route('/templates/install', methods=['POST'])
def install_server_from_template():
    """Install an MCP server config from a predefined template."""
    try:
        data = get_mcp_service().install_server_from_template(request.get_json(silent=True) or {})
        return _ok(data, message="MCP Server installed from template")
    except MCPServiceError as error:
        return _err(error.message, error.status_code)


@mcp_bp.route('/registry/servers', methods=['GET'])
def search_registry():
    """Search the official MCP Registry for installable servers."""
    search = request.args.get("search", "")
    cursor = request.args.get("cursor")
    limit = request.args.get("limit", default=8, type=int)
    latest_only = request.args.get("latest_only", default="true")
    latest_only = str(latest_only).strip().lower() not in {"0", "false", "no", "off"}

    try:
        result = get_mcp_service().search_registry(
            search=search,
            cursor=cursor,
            limit=limit,
            latest_only=latest_only,
        )
    except MCPServiceError as error:
        return _err(error.message, error.status_code)

    return _ok(result, message=f"Found {result.get('count', 0)} MCP Registry servers")


@mcp_bp.route('/registry/install', methods=['POST'])
def install_server_from_registry():
    """Install an MCP server config from a Registry search result."""
    try:
        data = get_mcp_service().install_server_from_registry(request.get_json(silent=True) or {})
        return _ok(data, message="MCP Server installed from Registry")
    except MCPServiceError as error:
        return _err(error.message, error.status_code)


# ─── Server 列表与配置 CRUD ────────────────────────────────────────────────────

@mcp_bp.route('/servers', methods=['GET'])
def list_servers():
    """列出所有 MCP Server 及连接状态"""
    return _ok(get_mcp_service().list_servers())


@mcp_bp.route('/servers', methods=['POST'])
def add_server():
    """添加 MCP Server 配置"""
    try:
        data = get_mcp_service().add_server(
            request.get_json(silent=True) or {},
            request_id=ensure_request_id(request.headers.get('X-Request-ID')),
        )
        return _ok(data, message="MCP Server 添加成功")
    except MCPServiceError as error:
        return _err(error.message, error.status_code)


@mcp_bp.route('/servers/<server_name>', methods=['PUT'])
def update_server(server_name: str):
    """Update MCP server config and refresh runtime state."""
    try:
        status = get_mcp_service().update_server(
            server_name,
            request.get_json(silent=True) or {},
            request_id=ensure_request_id(request.headers.get('X-Request-ID')),
        )
    except MCPServiceError as error:
        return _err(error.message, error.status_code)

    message = "MCP Server configuration updated and applied"
    if status.get("status") == "error":
        message = "MCP Server configuration updated, but reconnect failed"

    return _ok(status, message=message)


@mcp_bp.route('/servers/<server_name>', methods=['DELETE'])
def delete_server(server_name: str):
    """删除 MCP Server 配置（先断开连接）"""
    try:
        get_mcp_service().delete_server(server_name, request_id=ensure_request_id(request.headers.get('X-Request-ID')))
    except MCPServiceError as error:
        return _err(error.message, error.status_code)
    return _ok(message="MCP Server 已删除")


# ─── 连接管理 ─────────────────────────────────────────────────────────────────

@mcp_bp.route('/servers/<server_name>/connect', methods=['POST'])
def connect_server(server_name: str):
    """连接到指定 MCP Server"""
    try:
        status = get_mcp_service().connect_server(server_name, request_id=ensure_request_id(request.headers.get('X-Request-ID')))
        return _ok(status, message="连接成功")
    except MCPServiceError as error:
        return _err(error.message, error.status_code)


@mcp_bp.route('/servers/<server_name>/disconnect', methods=['POST'])
def disconnect_server(server_name: str):
    """断开指定 MCP Server"""
    get_mcp_service().disconnect_server(server_name, request_id=ensure_request_id(request.headers.get('X-Request-ID')))
    return _ok(message="已断开连接")


@mcp_bp.route('/servers/<server_name>/test', methods=['POST'])
def test_server(server_name: str):
    """测试连接（断开并重连）"""
    try:
        result = get_mcp_service().test_server(server_name, request_id=ensure_request_id(request.headers.get('X-Request-ID')))
        return _ok(result, message=result["message"])
    except MCPServiceError as error:
        return _err(error.message, error.status_code)


# ─── 工具查询 ─────────────────────────────────────────────────────────────────

@mcp_bp.route('/servers/<server_name>/tools', methods=['GET'])
def list_server_tools(server_name: str):
    """列出指定 MCP Server 提供的工具（OpenAI 格式）"""
    return _ok(get_mcp_service().list_server_tools(server_name))


@mcp_bp.route('/tools', methods=['GET'])
def list_all_tools():
    """列出所有已连接 MCP Server 的工具"""
    return _ok(get_mcp_service().list_all_tools())
