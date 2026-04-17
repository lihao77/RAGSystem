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
    AgentMCPConfig,
    AgentSkillConfig,
    AgentTaskConfig,
    AgentToolConfig,
    AgentMemoryConfig,
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
            name: self._normalize_config_dump(config)
            for name, config in configs.items()
        }

    def list_teams(self) -> Dict[str, Any]:
        return self._config_manager.get_team_summary()

    def create_team(self, team_name: str, source_team: Optional[str] = None) -> Dict[str, Any]:
        try:
            self._config_manager.create_team(team_name, source_team=source_team)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error
        self._reload_agents_safely()
        return self.list_teams()

    def activate_team(self, team_name: str) -> Dict[str, Any]:
        try:
            self._config_manager.set_active_team(team_name)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error
        self._reload_agents_safely()
        return self.list_teams()

    def delete_team(self, team_name: str) -> Dict[str, Any]:
        try:
            self._config_manager.delete_team(team_name)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error
        self._reload_agents_safely()
        return self.list_teams()

    def rename_team(self, team_name: str, new_team_name: str) -> Dict[str, Any]:
        try:
            self._config_manager.rename_team(team_name, new_team_name)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error
        self._reload_agents_safely()
        return self.list_teams()

    def copy_agents_to_team(self, team_name: str, source_team: str, agent_names: list[str]) -> Dict[str, Any]:
        try:
            self._config_manager.copy_agents_between_teams(source_team, team_name, agent_names)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error
        self._reload_agents_safely()
        return self.list_teams()

    def reset_default_team(self) -> Dict[str, Any]:
        result = self._config_manager.reset_default_team()
        self._reload_agents_safely()
        return result

    def get_config(self, agent_name: str) -> Dict[str, Any]:
        config = self._config_manager.get_config(agent_name)
        if config is None:
            raise AgentConfigServiceError(f'智能体 "{agent_name}" 不存在', status_code=404)
        return self._normalize_config_dump(config)

    def replace_config(self, agent_name: str, data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        payload = dict(data or {})
        payload['agent_name'] = agent_name

        try:
            config = AgentConfig(**payload)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error

        self._config_manager.set_config(config, save=True)
        self._reload_agents_safely()
        return self._normalize_config_dump(config)

    def patch_config(self, agent_name: str, data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        payload = data or {}
        config = self._config_manager.get_config(agent_name)
        if config is None:
            raise AgentConfigServiceError(f'智能体 "{agent_name}" 不存在', status_code=404)

        try:
            tools = self._merge_model_config(config.tools, payload.get('tools'), AgentToolConfig)
            skills = self._merge_model_config(config.skills, payload.get('skills'), AgentSkillConfig)
            mcp = self._merge_model_config(config.mcp, payload.get('mcp'), AgentMCPConfig)
            memory = self._merge_model_config(config.memory, payload.get('memory'), AgentMemoryConfig)
            tasks = self._merge_model_config(config.tasks, payload.get('tasks'), AgentTaskConfig)
        except Exception as error:
            raise AgentConfigServiceError(str(error), status_code=400) from error

        llm_tiers_patch = payload.get('llm_tiers')
        if llm_tiers_patch is not None and config.llm_tiers is not None:
            from agents.config.models import AgentLLMConfig
            merged_tiers = dict(config.llm_tiers)
            for tier_name, tier_data in llm_tiers_patch.items():
                existing = merged_tiers.get(tier_name)
                if existing:
                    merged = existing.model_dump()
                    merged.update(tier_data)
                    merged_tiers[tier_name] = AgentLLMConfig(**merged)
                else:
                    merged_tiers[tier_name] = AgentLLMConfig(**tier_data)
            config.llm_tiers = merged_tiers
        elif llm_tiers_patch is not None:
            from agents.config.models import AgentLLMConfig
            config.llm_tiers = {
                k: AgentLLMConfig(**v) for k, v in llm_tiers_patch.items()
            }

        updated_config = self._config_manager.update_config(
            agent_name=agent_name,
            tools=tools,
            skills=skills,
            mcp=mcp,
            memory=memory,
            tasks=tasks,
            custom_params=payload.get('custom_params'),
            enabled=payload.get('enabled'),
            save=True,
        )
        if updated_config is None:
            raise AgentConfigServiceError(f'智能体 "{agent_name}" 不存在', status_code=404)

        self._reload_agents_safely()
        return self._normalize_config_dump(updated_config)

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
        return self._normalize_config_dump(config)

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
        return self._normalize_config_dump(config)

    def validate_config(self, agent_name: str) -> Dict[str, Any]:
        valid, error = self._config_manager.validate_config(agent_name)
        return {
            'valid': valid,
            'error': error,
        }

    def get_active_team(self) -> Dict[str, Any]:
        return {
            'active_team': self._config_manager.get_active_team(),
        }

    def list_presets(self):
        return PRESET_CONFIGS

    def list_available_tools(self):
        hidden = {'list_memory_index', 'read_memory_entry', 'write_memory', 'archive_memory', 'request_user_input'}
        return [
            item for item in self._tool_registry.list_direct_tool_summaries()
            if item.get('name') not in hidden
        ]

    def get_memory_config_metadata(self):
        scope_defs = [
            {
                'name': 'team',
                'description': '团队级长期记忆，适合跨会话复用的共享偏好、约束与背景事实。',
                'read_label': '允许读取',
                'write_label': '允许写入',
                'archive_label': '允许归档',
            },
            {
                'name': 'session',
                'description': '当前会话记忆，适合记录本轮协作中形成的稳定偏好和上下文。',
                'read_label': '允许读取',
                'write_label': '允许写入',
                'archive_label': '允许归档',
            },
            {
                'name': 'agent',
                'description': '当前 team 内 Agent 私有记忆，仅适合该 Agent 在所属 team 中独立维护的长期信息。',
                'read_label': '允许读取',
                'write_label': '允许写入',
                'archive_label': '允许归档',
            },
            {
                'name': 'workspace',
                'description': '当前工作区记忆，适合绑定具体 workspace 的本地约定和上下文。',
                'read_label': '允许读取',
                'write_label': '允许写入',
                'archive_label': '允许归档',
            },
        ]

        return {
            'scopes': scope_defs,
        }

    def list_available_mcp_servers(self):
        from services.mcp_service import get_mcp_service

        return get_mcp_service().list_servers()

    def list_available_skills(self, workspace_root: str | None = None):
        from agents.skills.skill_loader import get_skill_loader

        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills(workspace_root=workspace_root)
        return [
            {
                'name': skill.name,
                'display_name': skill.name.replace('-', ' ').title(),
                'description': skill.description,
                'source_type': skill.source_type,
                'source_label': skill.source_label,
                'is_auto_inject_candidate': skill.is_auto_inject_candidate,
            }
            for skill in all_skills
        ]

    @staticmethod
    def _normalize_config_dump(config: AgentConfig) -> Dict[str, Any]:
        return config.model_dump()

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
