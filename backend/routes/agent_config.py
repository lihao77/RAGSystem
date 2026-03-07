# -*- coding: utf-8 -*-
"""
智能体配置管理 API。
"""

from flask import Blueprint, request
import logging

from services.agent_config_service import (
    AgentConfigServiceError,
    get_agent_config_service,
)
from utils.response_helpers import error_response, success_response

logger = logging.getLogger(__name__)

agent_config_bp = Blueprint('agent_config', __name__)


@agent_config_bp.route('/configs', methods=['GET'])
def list_configs():
    """列出所有智能体配置。"""
    try:
        configs = get_agent_config_service().list_configs()
        return success_response(data=configs, message=f'共有 {len(configs)} 个智能体配置')
    except Exception as error:
        logger.error('获取配置列表失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)


@agent_config_bp.route('/configs/<agent_name>', methods=['GET'])
def get_config(agent_name):
    """获取指定智能体配置。"""
    try:
        config = get_agent_config_service().get_config(agent_name)
        return success_response(data=config, message=f'智能体 "{agent_name}" 配置')
    except AgentConfigServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('获取配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)


@agent_config_bp.route('/configs/<agent_name>', methods=['PUT'])
def update_config(agent_name):
    """更新智能体配置（完整更新）。"""
    try:
        config = get_agent_config_service().replace_config(agent_name, request.get_json(silent=True))
        return success_response(data=config, message=f'智能体 "{agent_name}" 配置已更新')
    except AgentConfigServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('更新配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=400)


@agent_config_bp.route('/configs/<agent_name>', methods=['PATCH'])
def patch_config(agent_name):
    """更新智能体配置（部分更新）。"""
    try:
        config = get_agent_config_service().patch_config(agent_name, request.get_json(silent=True))
        return success_response(data=config, message=f'智能体 "{agent_name}" 配置已更新')
    except AgentConfigServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('更新配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=400)


@agent_config_bp.route('/configs/<agent_name>', methods=['DELETE'])
def delete_config(agent_name):
    """删除智能体配置。"""
    try:
        get_agent_config_service().delete_config(agent_name)
        return success_response(message=f'智能体 "{agent_name}" 配置已删除')
    except AgentConfigServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('删除配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)


@agent_config_bp.route('/configs/<agent_name>/preset', methods=['POST'])
def apply_preset(agent_name):
    """应用预设配置。"""
    try:
        payload = request.get_json(silent=True) or {}
        config = get_agent_config_service().apply_preset(agent_name, payload.get('preset'))
        return success_response(data=config, message=f'已应用预设 "{payload.get("preset")}"')
    except AgentConfigServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('应用预设失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)


@agent_config_bp.route('/configs/<agent_name>/export', methods=['GET'])
def export_config(agent_name):
    """导出智能体配置。"""
    try:
        format_name = request.args.get('format', 'yaml')
        result = get_agent_config_service().export_config(agent_name, format_name=format_name)
        return result['content'], 200, {'Content-Type': result['content_type']}
    except AgentConfigServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('导出配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)


@agent_config_bp.route('/configs/<agent_name>/import', methods=['POST'])
def import_config(agent_name):
    """导入智能体配置。"""
    try:
        config = get_agent_config_service().import_config(
            request.get_data(as_text=True),
            format_name=request.args.get('format'),
            content_type=request.content_type or '',
        )
        return success_response(data=config, message=f'智能体 "{config["agent_name"]}" 配置已导入')
    except AgentConfigServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('导入配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=400)


@agent_config_bp.route('/configs/<agent_name>/validate', methods=['GET'])
def validate_config(agent_name):
    """验证智能体配置。"""
    try:
        result = get_agent_config_service().validate_config(agent_name)
        return success_response(data=result, message='验证完成')
    except Exception as error:
        logger.error('验证配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)


@agent_config_bp.route('/presets', methods=['GET'])
def list_presets():
    """列出所有可用预设。"""
    try:
        presets = get_agent_config_service().list_presets()
        return success_response(data=presets, message=f'共有 {len(presets)} 个预设')
    except Exception as error:
        logger.error('获取预设列表失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)


@agent_config_bp.route('/tools', methods=['GET'])
def list_available_tools():
    """列出所有可用工具。"""
    try:
        tools = get_agent_config_service().list_available_tools()
        return success_response(data=tools, message=f'共有 {len(tools)} 个可用工具')
    except Exception as error:
        logger.error('获取工具列表失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)


@agent_config_bp.route('/mcp-servers', methods=['GET'])
def list_available_mcp_servers():
    """列出可分配给智能体的 MCP Server。"""
    try:
        servers = get_agent_config_service().list_available_mcp_servers()
        return success_response(data=servers, message=f'Found {len(servers)} MCP servers')
    except Exception as error:
        logger.error('Failed to load MCP servers: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)


@agent_config_bp.route('/skills', methods=['GET'])
def list_available_skills():
    """列出所有可用 Skills。"""
    try:
        skills = get_agent_config_service().list_available_skills()
        return success_response(data=skills, message=f'共有 {len(skills)} 个可用 Skill')
    except Exception as error:
        logger.error('获取 Skills 列表失败: %s', error, exc_info=True)
        return error_response(message=str(error), status_code=500)
