# -*- coding: utf-8 -*-
"""
Agent 配置服务层。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from runtime.dependencies import get_runtime_dependency
from agents.config import (
    PRESET_CONFIGS,
    AgentConfig,
    AgentConfigPreset,
    AgentLLMConfig,
    AgentMCPConfig,
    AgentSkillConfig,
    AgentToolConfig,
    get_config_manager,
)

from .agent_api_runtime_service import get_agent_api_runtime_service
from tools.tool_registry import get_tool_registry

logger = logging.getLogger(__name__)


class AgentConfigServiceError(Exception):
    """Agent 配置业务异常。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class AgentConfigService:
    """封装 Agent 配置管理相关业务逻辑。"""

    def __init__(self):
        self._config_manager = get_config_manager()
        self._runtime_service = get_agent_api_runtime_service()
        self._tool_registry = get_tool_registry()

    def list_configs(self) -> Dict[str, Dict[str, Any]]:
        configs = self._config_manager.get_all_configs()
        return {
            name: config.model_dump()
            for name, config in configs.items()
        }

    def get_config(self, agent_name: str) -> Dict[str, Any]:
        config = self._config_manager.get_config(agent_name)
        if config is None:
            raise AgentConfigServiceError(f'智能体 "{agent_name}" 不存在', status_code=404)
        return config.model_dump()

    def replace_config(self, agent_name: str, data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        payload = dict(data or {})
        payload['agent_name'] = agent_name

        try:
            config = AgentConfig(**payload)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error

        self._config_manager.set_config(config, save=True)
        self._reload_agents_safely()
        return config.model_dump()

    def patch_config(self, agent_name: str, data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        payload = data or {}
        config = self._config_manager.get_config(agent_name)
        if config is None:
            raise AgentConfigServiceError(f'智能体 "{agent_name}" 不存在', status_code=404)

        try:
            llm = self._merge_model_config(config.llm, payload.get('llm'), AgentLLMConfig)
            tools = self._merge_model_config(config.tools, payload.get('tools'), AgentToolConfig)
            skills = self._merge_model_config(config.skills, payload.get('skills'), AgentSkillConfig)
            mcp = self._merge_model_config(config.mcp, payload.get('mcp'), AgentMCPConfig)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error

        updated_config = self._config_manager.update_config(
            agent_name=agent_name,
            llm=llm,
            tools=tools,
            skills=skills,
            mcp=mcp,
            custom_params=payload.get('custom_params'),
            enabled=payload.get('enabled'),
            save=True,
        )
        if updated_config is None:
            raise AgentConfigServiceError(f'智能体 "{agent_name}" 不存在', status_code=404)

        self._reload_agents_safely()
        return updated_config.model_dump()

    def delete_config(self, agent_name: str) -> None:
        if self._config_manager.get_config(agent_name) is None:
            raise AgentConfigServiceError(f'智能体 "{agent_name}" 不存在', status_code=404)

        self._config_manager.delete_config(agent_name, save=True)
        self._reload_agents_safely()

    def apply_preset(self, agent_name: str, preset_name: Optional[str]) -> Dict[str, Any]:
        if not preset_name:
            raise AgentConfigServiceError('请指定预设名称', status_code=400)

        try:
            preset = AgentConfigPreset(preset_name)
        except ValueError as error:
            raise AgentConfigServiceError(f'无效的预设名称: {preset_name}', status_code=400) from error

        config = self._config_manager.apply_preset(agent_name, preset, save=True)
        if config is None:
            raise AgentConfigServiceError(f'智能体 "{agent_name}" 不存在', status_code=404)

        self._reload_agents_safely()
        return config.model_dump()

    def export_config(self, agent_name: str, format_name: str = 'yaml') -> Dict[str, str]:
        config_str = self._config_manager.export_config(agent_name, format=format_name)
        if config_str is None:
            raise AgentConfigServiceError(f'智能体 "{agent_name}" 不存在', status_code=404)

        content_type = 'application/x-yaml' if format_name == 'yaml' else 'application/json'
        return {
            'content': config_str,
            'content_type': content_type,
        }

    def import_config(self, config_str: str, format_name: Optional[str], content_type: str = '') -> Dict[str, Any]:
        resolved_format = format_name or self._detect_format(content_type)
        try:
            config = self._config_manager.import_config(config_str, format=resolved_format, save=True)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error

        self._reload_agents_safely()
        return config.model_dump()

    def validate_config(self, agent_name: str) -> Dict[str, Any]:
        valid, error = self._config_manager.validate_config(agent_name)
        return {
            'valid': valid,
            'error': error,
        }

    def list_presets(self):
        return PRESET_CONFIGS

    def list_available_tools(self):
        return self._tool_registry.list_configurable_tool_summaries()

    def list_available_mcp_servers(self):
        from services.mcp_service import get_mcp_service

        return get_mcp_service().list_servers()

    def list_available_skills(self):
        from agents.skills.skill_loader import get_skill_loader

        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills()
        return [
            {
                'name': skill.name,
                'display_name': skill.name.replace('-', ' ').title(),
                'description': skill.description,
            }
            for skill in all_skills
        ]

    @staticmethod
    def _merge_model_config(current_config, patch_data: Optional[Dict[str, Any]], model_cls):
        if patch_data is None:
            return None
        merged = current_config.model_dump()
        merged.update(patch_data)
        return model_cls(**merged)

    @staticmethod
    def _detect_format(content_type: str) -> str:
        if 'yaml' in (content_type or ''):
            return 'yaml'
        if 'json' in (content_type or ''):
            return 'json'
        return 'yaml'

    def _reload_agents_safely(self) -> None:
        try:
            success = self._runtime_service.reload_agents()
            if success:
                logger.info('智能体重新加载成功')
            else:
                logger.warning('智能体重新加载失败，但不影响配置保存')
        except Exception as error:
            logger.error('重新加载智能体异常: %s', error, exc_info=True)


def get_agent_config_service() -> AgentConfigService:
    return get_runtime_dependency(container_getter='get_agent_config_service')
