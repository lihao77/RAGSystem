# -*- coding: utf-8 -*-
"""
智能体配置管理 API

提供智能体配置的 CRUD 接口
"""

from flask import Blueprint, request
import logging
from agents.config import get_config_manager, AgentConfig, AgentLLMConfig, AgentToolConfig, AgentConfigPreset
from utils.response_helpers import success_response, error_response

logger = logging.getLogger(__name__)

agent_config_bp = Blueprint('agent_config', __name__)


def _reload_agents():
    """
    重新加载 orchestrator 中的智能体（用于配置更新后刷新）

    这个函数会：
    1. 清除旧的智能体注册
    2. 重新加载所有启用的智能体
    3. 注册到 orchestrator
    """
    try:
        # 延迟导入避免循环依赖
        from routes.agent import reload_agents

        # 调用重新加载函数
        success = reload_agents()
        if success:
            logger.info("智能体重新加载成功")
        else:
            logger.warning("智能体重新加载失败，但不影响配置保存")

    except Exception as e:
        logger.error(f"重新加载智能体异常: {e}", exc_info=True)
        # 不抛出异常，避免影响配置更新


@agent_config_bp.route('/configs', methods=['GET'])
def list_configs():
    """
    列出所有智能体配置

    Returns:
        {
            "success": true,
            "data": {
                "qa_agent": {...}
            }
        }
    """
    try:
        config_manager = get_config_manager()
        configs = config_manager.get_all_configs()

        # 转换为字典
        configs_dict = {
            name: config.model_dump()
            for name, config in configs.items()
        }

        return success_response(
            data=configs_dict,
            message=f'共有 {len(configs)} 个智能体配置'
        )

    except Exception as e:
        logger.error(f'获取配置列表失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_config_bp.route('/configs/<agent_name>', methods=['GET'])
def get_config(agent_name):
    """
    获取指定智能体配置

    Args:
        agent_name: 智能体名称

    Returns:
        {
            "success": true,
            "data": {...}
        }
    """
    try:
        config_manager = get_config_manager()
        config = config_manager.get_config(agent_name)

        if config is None:
            return error_response(
                message=f'智能体 "{agent_name}" 不存在',
                status_code=404
            )

        return success_response(
            data=config.model_dump(),
            message=f'智能体 "{agent_name}" 配置'
        )

    except Exception as e:
        logger.error(f'获取配置失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_config_bp.route('/configs/<agent_name>', methods=['PUT'])
def update_config(agent_name):
    """
    更新智能体配置（完整更新）

    Request:
        {
            "agent_name": "qa_agent",
            "display_name": "问答智能体",
            "description": "...",
            "enabled": true,
            "llm": {
                "provider": "test",
                "provider_type": "deepseek",
                "model_name": "deepseek-chat",
                "temperature": 0.3,
                "max_tokens": 4096
            },
            "tools": {
                "enabled_tools": ["query_kg"],
                "tool_settings": {}
            },
            "custom_params": {}
        }

    Returns:
        {
            "success": true,
            "data": {...}
        }
    """
    try:
        data = request.get_json()

        # 确保 agent_name 一致
        data['agent_name'] = agent_name

        # 验证并创建配置
        config = AgentConfig(**data)

        # 保存配置
        config_manager = get_config_manager()
        config_manager.set_config(config, save=True)

        # 🔧 重新加载 orchestrator 中的智能体（反映 enabled 状态变化）
        _reload_agents()

        return success_response(
            data=config.model_dump(),
            message=f'智能体 "{agent_name}" 配置已更新'
        )

    except Exception as e:
        logger.error(f'更新配置失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=400)


@agent_config_bp.route('/configs/<agent_name>', methods=['PATCH'])
def patch_config(agent_name):
    """
    更新智能体配置（部分更新）

    Request:
        {
            "llm": {
                "temperature": 0.5
            },
            "enabled": false
        }

    Returns:
        {
            "success": true,
            "data": {...}
        }
    """
    try:
        data = request.get_json()
        config_manager = get_config_manager()

        # 检查智能体是否存在
        config = config_manager.get_config(agent_name)
        if config is None:
            return error_response(
                message=f'智能体 "{agent_name}" 不存在',
                status_code=404
            )

        # 部分更新
        llm = None
        if 'llm' in data:
            # 合并现有配置
            llm_data = config.llm.model_dump()
            llm_data.update(data['llm'])
            llm = AgentLLMConfig(**llm_data)

        tools = None
        if 'tools' in data:
            # 合并现有配置
            tools_data = config.tools.model_dump()
            tools_data.update(data['tools'])
            tools = AgentToolConfig(**tools_data)

        skills = None
        if 'skills' in data:
            # 合并现有配置
            from agents.config import AgentSkillConfig
            skills_data = config.skills.model_dump()
            skills_data.update(data['skills'])
            skills = AgentSkillConfig(**skills_data)

        custom_params = data.get('custom_params')
        enabled = data.get('enabled')

        # 更新配置
        updated_config = config_manager.update_config(
            agent_name=agent_name,
            llm=llm,
            tools=tools,
            skills=skills,
            custom_params=custom_params,
            enabled=enabled,
            save=True
        )

        # 🔧 重新加载 orchestrator 中的智能体（反映 enabled 状态变化）
        _reload_agents()

        return success_response(
            data=updated_config.model_dump(),
            message=f'智能体 "{agent_name}" 配置已更新'
        )

    except Exception as e:
        logger.error(f'更新配置失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=400)


@agent_config_bp.route('/configs/<agent_name>', methods=['DELETE'])
def delete_config(agent_name):
    """
    删除智能体配置

    Args:
        agent_name: 智能体名称

    Returns:
        {
            "success": true,
            "message": "配置已删除"
        }
    """
    try:
        config_manager = get_config_manager()

        # 检查是否存在
        if config_manager.get_config(agent_name) is None:
            return error_response(
                message=f'智能体 "{agent_name}" 不存在',
                status_code=404
            )

        # 删除配置
        config_manager.delete_config(agent_name, save=True)

        return success_response(
            message=f'智能体 "{agent_name}" 配置已删除'
        )

    except Exception as e:
        logger.error(f'删除配置失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_config_bp.route('/configs/<agent_name>/preset', methods=['POST'])
def apply_preset(agent_name):
    """
    应用预设配置

    Request:
        {
            "preset": "fast" | "balanced" | "accurate" | "creative" | "cheap"
        }

    Returns:
        {
            "success": true,
            "data": {...}
        }
    """
    try:
        data = request.get_json()
        preset_name = data.get('preset')

        if not preset_name:
            return error_response(
                message='请指定预设名称',
                status_code=400
            )

        # 验证预设
        try:
            preset = AgentConfigPreset(preset_name)
        except ValueError:
            return error_response(
                message=f'无效的预设名称: {preset_name}',
                status_code=400
            )

        # 应用预设
        config_manager = get_config_manager()
        config = config_manager.apply_preset(agent_name, preset, save=True)

        if config is None:
            return error_response(
                message=f'智能体 "{agent_name}" 不存在',
                status_code=404
            )

        return success_response(
            data=config.model_dump(),
            message=f'已应用预设 "{preset_name}"'
        )

    except Exception as e:
        logger.error(f'应用预设失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_config_bp.route('/configs/<agent_name>/export', methods=['GET'])
def export_config(agent_name):
    """
    导出智能体配置

    Query params:
        format: 'yaml' | 'json' (默认 yaml)

    Returns:
        配置文本（YAML 或 JSON 格式）
    """
    try:
        format = request.args.get('format', 'yaml')

        config_manager = get_config_manager()
        config_str = config_manager.export_config(agent_name, format=format)

        if config_str is None:
            return error_response(
                message=f'智能体 "{agent_name}" 不存在',
                status_code=404
            )

        # 返回纯文本
        content_type = 'application/x-yaml' if format == 'yaml' else 'application/json'
        return config_str, 200, {'Content-Type': content_type}

    except Exception as e:
        logger.error(f'导出配置失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_config_bp.route('/configs/<agent_name>/import', methods=['POST'])
def import_config(agent_name):
    """
    导入智能体配置

    Request:
        Content-Type: application/x-yaml 或 application/json
        Body: 配置文本

    Query params:
        format: 'yaml' | 'json' (默认根据 Content-Type 判断)

    Returns:
        {
            "success": true,
            "data": {...}
        }
    """
    try:
        # 获取配置文本
        config_str = request.get_data(as_text=True)

        # 判断格式
        format = request.args.get('format')
        if not format:
            content_type = request.content_type or ''
            if 'yaml' in content_type:
                format = 'yaml'
            elif 'json' in content_type:
                format = 'json'
            else:
                format = 'yaml'  # 默认

        # 导入配置
        config_manager = get_config_manager()
        config = config_manager.import_config(config_str, format=format, save=True)

        return success_response(
            data=config.model_dump(),
            message=f'智能体 "{config.agent_name}" 配置已导入'
        )

    except Exception as e:
        logger.error(f'导入配置失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=400)


@agent_config_bp.route('/configs/<agent_name>/validate', methods=['GET'])
def validate_config(agent_name):
    """
    验证智能体配置

    Args:
        agent_name: 智能体名称

    Returns:
        {
            "success": true,
            "data": {
                "valid": true,
                "error": null
            }
        }
    """
    try:
        config_manager = get_config_manager()
        valid, error = config_manager.validate_config(agent_name)

        return success_response(
            data={
                'valid': valid,
                'error': error
            },
            message='验证完成'
        )

    except Exception as e:
        logger.error(f'验证配置失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_config_bp.route('/presets', methods=['GET'])
def list_presets():
    """
    列出所有可用的预设配置

    Returns:
        {
            "success": true,
            "data": {
                "fast": {...},
                "balanced": {...},
                ...
            }
        }
    """
    try:
        from agents.config import PRESET_CONFIGS

        return success_response(
            data=PRESET_CONFIGS,
            message=f'共有 {len(PRESET_CONFIGS)} 个预设'
        )

    except Exception as e:
        logger.error(f'获取预设列表失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_config_bp.route('/tools', methods=['GET'])
def list_available_tools():
    """
    列出所有可用的工具

    Returns:
        {
            "success": true,
            "data": [
                {
                    "name": "query_kg",
                    "display_name": "知识图谱查询",
                    "description": "使用自然语言查询知识图谱",
                    "category": "search"
                },
                ...
            ]
        }
    """
    try:
        from tools.function_definitions import get_tool_definitions

        # 获取所有工具定义
        tools = get_tool_definitions()

        # 转换为前端需要的格式
        tool_list = []
        for tool in tools:
            function_def = tool.get('function', {})
            tool_list.append({
                'name': function_def.get('name', ''),
                'display_name': function_def.get('name', '').replace('_', ' ').title(),
                'description': function_def.get('description', ''),
                'category': _get_tool_category(function_def.get('name', ''))
            })

        return success_response(
            data=tool_list,
            message=f'共有 {len(tool_list)} 个可用工具'
        )

    except Exception as e:
        logger.error(f'获取工具列表失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


def _get_tool_category(tool_name: str) -> str:
    """
    根据工具名称判断分类

    Args:
        tool_name: 工具名称

    Returns:
        工具分类
    """
    # 基础检索工具
    if tool_name in [
        'query_knowledge_graph_with_nl',
        'search_knowledge_graph',
        'get_entity_relations',
        'execute_cypher_query',
        'get_graph_schema'
    ]:
        return 'search'

    # 高级分析工具
    if tool_name in [
        'analyze_temporal_pattern',
        'find_causal_chain',
        'compare_entities',
        'aggregate_statistics'
    ]:
        return 'analysis'

    # 默认分类
    return 'other'


@agent_config_bp.route('/skills', methods=['GET'])
def list_available_skills():
    """
    列出所有可用的 Skills

    Returns:
        {
            "success": true,
            "data": [
                {
                    "name": "disaster-report-example",
                    "display_name": "灾害报告示例",
                    "description": "演示如何撰写灾害报告的示例 Skill"
                },
                ...
            ]
        }
    """
    try:
        from agents.skills.skill_loader import get_skill_loader

        # 加载所有 Skills
        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills()

        # 转换为前端需要的格式
        skill_list = []
        for skill in all_skills:
            skill_list.append({
                'name': skill.name,
                'display_name': skill.name.replace('-', ' ').title(),  # 默认显示名称
                'description': skill.description
            })

        return success_response(
            data=skill_list,
            message=f'共有 {len(skill_list)} 个可用 Skill'
        )

    except Exception as e:
        logger.error(f'获取 Skills 列表失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)
