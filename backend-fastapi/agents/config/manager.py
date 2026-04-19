# -*- coding: utf-8 -*-
"""
智能体配置管理服务

负责智能体配置的加载、保存、更新和查询
"""

import copy
import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from runtime.dependencies import get_runtime_dependency
from utils.versioned_yaml_store import load_versioned_yaml_file, save_versioned_yaml_file

from .models import (
    AgentConfig,
    AgentConfigPreset,
    AgentLLMConfig,
    AgentMCPConfig,
    AgentMemoryConfig,
    AgentSkillConfig,
    AgentTaskConfig,
    AgentToolConfig,
    apply_preset,
)

logger = logging.getLogger(__name__)

CONFIG_SCHEMA_VERSION = '2.0'
DEFAULT_TEAM_NAME = 'default'
TEAM_INDEX_FILE_NAME = 'team_index.yaml'
TEAM_CONFIG_DIR_NAME = 'teams'
LEGACY_CONFIG_FILE_NAME = 'agent_configs.yaml'

_DEFAULT_LLM_TIER = {
    'provider': '',
    'provider_type': 'openai_chat',
    'model_name': '',
    'temperature': 0.2,
    'max_completion_tokens': 4096,
    'max_context_tokens': 128000,
    'extra_params': {},
}
_DEFAULT_MEMORY_CONFIG = {
    'auto_inject': True,
    # team scope 只读：team 记忆由系统统一管理，Agent 不允许直接写入或归档
    'allowed_scopes': ['team', 'session', 'agent', 'workspace'],
    'write_scopes': ['session', 'agent', 'workspace'],
    'archive_scopes': ['session', 'agent', 'workspace'],
}

_DEFAULT_TASK_CONFIG = {
    'workflow': False,
    'background': False,
}


def _render_config_text(data: Dict[str, Any], format: str) -> str:
    if format == 'yaml':
        return yaml.safe_dump(data, allow_unicode=True, default_flow_style=False, sort_keys=False)
    if format == 'json':
        return json.dumps(data, ensure_ascii=False, indent=2)
    raise ValueError(f'不支持的格式: {format}')


def _parse_config_text(config_str: str, format: str) -> Dict[str, Any]:
    if format == 'yaml':
        return yaml.safe_load(config_str) or {}
    if format == 'json':
        return json.loads(config_str)
    raise ValueError(f'不支持的格式: {format}')


def _slugify_team_name(team_name: str) -> str:
    normalized = re.sub(r'[^a-zA-Z0-9._-]+', '-', (team_name or '').strip()).strip('-._')
    return normalized or DEFAULT_TEAM_NAME


def _dump_agent_config(config: AgentConfig) -> Dict[str, Any]:
    if hasattr(config, 'model_dump'):
        return config.model_dump()
    return config.dict()


class AgentConfigManager:
    """
    智能体配置管理器

    功能：
    1. 从文件加载配置
    2. 保存配置到文件
    3. 运行时配置管理（CRUD）
    4. 配置验证
    5. 预设配置应用
    6. Team 配置文件切换与管理
    """

    def __init__(self, config_dir: str = None):
        if config_dir is None:
            from core.path_resolution import CONFIG_ROOT
            config_dir = CONFIG_ROOT / 'agents'

        self.config_dir = Path(config_dir)
        self.team_index_file = self.config_dir / TEAM_INDEX_FILE_NAME
        self.legacy_config_file = self.config_dir / LEGACY_CONFIG_FILE_NAME
        self.team_config_dir = self.config_dir / TEAM_CONFIG_DIR_NAME

        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.team_config_dir.mkdir(parents=True, exist_ok=True)

        self._configs: Dict[str, AgentConfig] = {}
        self._team_files: Dict[str, str] = {}
        self._active_team: str = DEFAULT_TEAM_NAME

        self._load_configs()

        logger.info(
            'AgentConfigManager 初始化完成，配置目录: %s, active_team=%s',
            self.config_dir,
            self._active_team,
        )

    def _load_configs(self):
        """从文件加载当前 active_team 的智能体配置。"""
        self._configs = {}

        if self.team_index_file.exists():
            try:
                self._load_from_team_index()
                return
            except Exception as e:
                logger.error('加载 team 索引失败: %s', e, exc_info=True)

        if self.legacy_config_file.exists():
            try:
                self._migrate_legacy_config_file()
                self._load_from_team_index()
                return
            except Exception as e:
                logger.error('迁移旧配置失败: %s', e, exc_info=True)

        self._create_default_configs()

    def _load_from_team_index(self):
        data, _ = load_versioned_yaml_file(
            self.team_index_file,
            default_factory=self._build_empty_index_payload,
            migrate=self._migrate_team_index_data,
            persist_on_change=True,
            backup_on_change=True,
            default_flow_style=False,
            sort_keys=False,
        )

        self._active_team = data.get('active_team') or DEFAULT_TEAM_NAME
        raw_team_files = data.get('teams') or {}
        if not isinstance(raw_team_files, dict):
            raise ValueError('team 索引中的 teams 必须是对象')

        self._team_files = {}
        for team_name, relative_path in raw_team_files.items():
            if not isinstance(relative_path, str) or not relative_path.strip():
                logger.warning('跳过无效 team 文件映射: team=%s path=%s', team_name, relative_path)
                continue
            self._team_files[team_name] = relative_path.strip().replace('\\', '/')

        if not self._team_files:
            default_relative_path = self._default_team_relative_path(DEFAULT_TEAM_NAME)
            self._team_files = {DEFAULT_TEAM_NAME: default_relative_path}
            self._active_team = DEFAULT_TEAM_NAME
            self._save_team_index()

        if self._active_team not in self._team_files:
            self._active_team = next(iter(self._team_files.keys()))
            self._save_team_index()

        self._configs = self._read_team_configs(self._active_team)
        logger.info('成功加载 team=%s，共 %s 个智能体配置', self._active_team, len(self._configs))

    def _read_team_configs(self, team_name: str) -> Dict[str, AgentConfig]:
        team_file = self._resolve_team_file_path(team_name)
        data, _ = load_versioned_yaml_file(
            team_file,
            default_factory=self._build_empty_team_payload,
            migrate=self._migrate_team_config_data,
            persist_on_change=True,
            backup_on_change=True,
            default_flow_style=False,
            sort_keys=False,
        )

        configs: Dict[str, AgentConfig] = {}
        for agent_name, config_data in (data.get('agents') or {}).items():
            try:
                config = AgentConfig(**config_data)
                configs[agent_name] = config
            except Exception as e:
                logger.error("解析智能体 '%s' 配置失败: %s", agent_name, e)
        return configs

    def _migrate_legacy_config_file(self):
        legacy_data, _ = load_versioned_yaml_file(
            self.legacy_config_file,
            default_factory=self._build_empty_team_payload,
            migrate=self._migrate_team_config_data,
            persist_on_change=False,
            backup_on_change=False,
            default_flow_style=False,
            sort_keys=False,
        )

        self._team_files = {DEFAULT_TEAM_NAME: self._default_team_relative_path(DEFAULT_TEAM_NAME)}
        self._active_team = DEFAULT_TEAM_NAME
        self._save_team_index()
        self._write_team_payload(DEFAULT_TEAM_NAME, legacy_data)
        logger.info('已将旧配置迁移到 team 文件: %s -> %s', self.legacy_config_file, self._resolve_team_file_path(DEFAULT_TEAM_NAME))

    def _create_default_configs(self):
        self._team_files = {DEFAULT_TEAM_NAME: self._default_team_relative_path(DEFAULT_TEAM_NAME)}
        self._active_team = DEFAULT_TEAM_NAME
        default_team_payload = self._build_default_team_payload()
        self._configs = {
            agent_name: AgentConfig(**copy.deepcopy(config_data))
            for agent_name, config_data in default_team_payload['agents'].items()
        }
        self._save_team_index()
        self._save_configs()
        logger.info('已创建默认系统 team 配置')

    def _build_default_team_payload(self) -> Dict[str, Any]:
        specialist_agents = [
            'team_maker',
            'plan_agent',
            'explor_agent',
            'general_agent',
            'review_agent',
            'test_agent',
        ]
        return {
            'agents': {
                'orchestrator_agent': self._build_system_agent_config(
                    agent_name='orchestrator_agent',
                    display_name='Orchestrator Agent',
                    description='系统默认主编排器，负责理解用户需求、路由任务并整合最终答案。',
                    system_prompt='你是系统默认主编排器，负责优先直接解决问题；必要时再委派给 team 内其他系统 Agent。',
                    default_entry=True,
                    agent_type='orchestrator',
                    tools=['read_file', 'write_file', 'edit_file', 'preview_data_structure', 'execute_bash'],
                    delegation=specialist_agents,
                    tasks={'workflow': True, 'background': True},
                ),
                'team_maker': self._build_system_agent_config(
                    agent_name='team_maker',
                    display_name='Team Maker',
                    description='系统默认组队 Agent，负责生成、整理和调整 team 配置方案。',
                    system_prompt='你负责根据目标生成、整理和调整 team 配置，输出尽量少而完整的 team 方案。',
                    skills=['team-generation'],
                    delegation=['plan_agent', 'explor_agent', 'general_agent'],
                ),
                'plan_agent': self._build_system_agent_config(
                    agent_name='plan_agent',
                    display_name='Plan Agent',
                    description='系统默认规划 Agent，负责方案设计、任务拆解和实现路径规划。',
                    system_prompt='你负责阅读上下文后给出精炼、可执行的实现计划，明确改动点、验证路径和边界。',
                    tools=['read_file', 'preview_data_structure'],
                    delegation=['explor_agent', 'general_agent'],
                ),
                'explor_agent': self._build_system_agent_config(
                    agent_name='explor_agent',
                    display_name='Explore Agent',
                    description='系统默认探索 Agent，负责搜索代码库、定位实现与归纳上下文。',
                    system_prompt='你负责快速探索仓库，定位相关文件、现有实现和可复用模式，只返回与当前目标直接相关的结论。',
                    tools=['read_file', 'preview_data_structure'],
                ),
                'general_agent': self._build_system_agent_config(
                    agent_name='general_agent',
                    display_name='General Agent',
                    description='系统默认通用执行 Agent，负责处理中等复杂度的综合实现与代码修改。',
                    system_prompt='你负责承接通用实现任务，优先复用现有代码模式，直接产出完成所需的最少改动。',
                    tools=['read_file', 'write_file', 'edit_file', 'preview_data_structure', 'execute_bash'],
                    delegation=['explor_agent'],
                ),
                'review_agent': self._build_system_agent_config(
                    agent_name='review_agent',
                    display_name='Review Agent',
                    description='系统默认评审 Agent，负责检查改动质量、复用性和潜在问题。',
                    system_prompt='你负责审查当前改动，聚焦正确性、复用性、一致性和不必要复杂度，并给出精炼结论。',
                    tools=['read_file', 'preview_data_structure', 'execute_bash'],
                ),
                'test_agent': self._build_system_agent_config(
                    agent_name='test_agent',
                    display_name='Test Agent',
                    description='系统默认测试 Agent，负责运行验证命令并定位失败原因。',
                    system_prompt='你负责运行测试、构建和验证命令，准确报告失败点并归纳最直接的修复线索。',
                    tools=['read_file', 'preview_data_structure', 'execute_bash'],
                ),
            },
        }

    def _build_system_agent_config(
        self,
        *,
        agent_name: str,
        display_name: str,
        description: str,
        system_prompt: str,
        default_entry: bool = False,
        agent_type: str = 'orchestrator',
        tools: Optional[List[str]] = None,
        skills: Optional[List[str]] = None,
        delegation: Optional[List[str]] = None,
        tasks: Optional[Dict[str, bool]] = None,
    ) -> Dict[str, Any]:
        return {
            'agent_name': agent_name,
            'display_name': display_name,
            'description': description,
            'enabled': True,
            'default_entry': default_entry,
            'llm_tiers': {
                'default': copy.deepcopy(_DEFAULT_LLM_TIER),
            },
            'tools': {
                'enabled_tools': list(tools or ['read_file', 'preview_data_structure']),
            },
            'skills': {
                'enabled_skills': list(skills or []),
                'auto_inject': True,
            },
            'mcp': {
                'enabled_servers': [],
            },
            'memory': copy.deepcopy(_DEFAULT_MEMORY_CONFIG),
            'tasks': {
                **copy.deepcopy(_DEFAULT_TASK_CONFIG),
                **dict(tasks or {}),
            },
            'delegation': {
                'enabled_agents': list(delegation or []),
            },
            'custom_params': {
                'type': agent_type,
                'behavior': {
                    'system_prompt': system_prompt,
                    'auto_execute_tools': True,
                },
            },
        }

    def _build_empty_index_payload(self) -> Dict[str, Any]:
        return {
            'active_team': DEFAULT_TEAM_NAME,
            'teams': {
                DEFAULT_TEAM_NAME: self._default_team_relative_path(DEFAULT_TEAM_NAME),
            },
            'metadata': {
                'updated_at': datetime.now().isoformat(),
                'version': CONFIG_SCHEMA_VERSION,
            },
        }

    def _build_empty_team_payload(self) -> Dict[str, Any]:
        return {
            'agents': {},
            'metadata': {
                'updated_at': datetime.now().isoformat(),
                'version': CONFIG_SCHEMA_VERSION,
            },
        }

    def _migrate_team_index_data(self, data: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
        changed = False
        if not isinstance(data, dict):
            return self._build_empty_index_payload(), True

        payload = dict(data)
        teams = payload.get('teams')
        if not isinstance(teams, dict) or not teams:
            payload['teams'] = {DEFAULT_TEAM_NAME: self._default_team_relative_path(DEFAULT_TEAM_NAME)}
            changed = True

        active_team = payload.get('active_team')
        if not isinstance(active_team, str) or not active_team.strip() or active_team not in payload['teams']:
            payload['active_team'] = next(iter(payload['teams'].keys()))
            changed = True

        metadata = payload.get('metadata')
        if not isinstance(metadata, dict):
            metadata = {}
            payload['metadata'] = metadata
            changed = True

        if metadata.get('version') != CONFIG_SCHEMA_VERSION:
            metadata['version'] = CONFIG_SCHEMA_VERSION
            changed = True

        if not metadata.get('updated_at'):
            metadata['updated_at'] = datetime.now().isoformat()
            changed = True

        return payload, changed

    def _migrate_team_config_data(self, data: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
        changed = False
        if not isinstance(data, dict):
            return self._build_empty_team_payload(), True

        payload = dict(data)
        agents = payload.get('agents')
        if not isinstance(agents, dict):
            payload['agents'] = {}
            changed = True

        metadata = payload.get('metadata')
        if not isinstance(metadata, dict):
            metadata = {}
            payload['metadata'] = metadata
            changed = True

        if metadata.get('version') != CONFIG_SCHEMA_VERSION:
            metadata['version'] = CONFIG_SCHEMA_VERSION
            changed = True

        if not metadata.get('updated_at'):
            metadata['updated_at'] = datetime.now().isoformat()
            changed = True

        return payload, changed

    def _resolve_team_file_path(self, team_name: str) -> Path:
        relative_path = self._team_files.get(team_name)
        if not relative_path:
            raise ValueError(f"team '{team_name}' 不存在")
        return (self.config_dir / relative_path).resolve()

    def _default_team_relative_path(self, team_name: str) -> str:
        return f'{TEAM_CONFIG_DIR_NAME}/{_slugify_team_name(team_name)}.yaml'

    def _save_team_index(self):
        data = {
            'active_team': self._active_team,
            'teams': dict(self._team_files),
            'metadata': {
                'updated_at': datetime.now().isoformat(),
                'version': CONFIG_SCHEMA_VERSION,
            },
        }
        save_versioned_yaml_file(
            self.team_index_file,
            data,
            backup=True,
            default_flow_style=False,
            sort_keys=False,
        )

    def _write_team_payload(self, team_name: str, payload: Dict[str, Any]):
        team_file = self._resolve_team_file_path(team_name)
        team_file.parent.mkdir(parents=True, exist_ok=True)
        data = self._build_empty_team_payload()
        data['metadata']['updated_at'] = datetime.now().isoformat()
        data['agents'] = payload.get('agents', {})
        save_versioned_yaml_file(
            team_file,
            data,
            backup=True,
            default_flow_style=False,
            sort_keys=False,
        )

    def _save_configs(self):
        try:
            data = self._build_empty_team_payload()
            data['metadata']['updated_at'] = datetime.now().isoformat()
            for agent_name, config in self._configs.items():
                data['agents'][agent_name] = _dump_agent_config(config)
            self._write_team_payload(self._active_team, data)
            logger.info('team=%s 配置已保存', self._active_team)
        except Exception as e:
            logger.error('保存配置失败: %s', e)
            raise

    def reset_default_team(self) -> Dict[str, Any]:
        """将 default team 重置为系统默认配置，不影响其他 team。"""
        default_team_payload = self._build_default_team_payload()
        result = self.apply_team_payload(DEFAULT_TEAM_NAME, default_team_payload['agents'])
        logger.info('default team 已重置为系统默认配置')
        return result

    def get_active_team(self) -> str:
        return self._active_team

    def list_teams(self) -> Dict[str, str]:
        return dict(self._team_files)

    def get_team_configs(self, team_name: str) -> Dict[str, AgentConfig]:
        return self._read_team_configs(team_name)

    def set_active_team(self, team_name: str) -> None:
        if team_name not in self._team_files:
            raise ValueError(f"team '{team_name}' 不存在")
        self._active_team = team_name
        self._configs = self._read_team_configs(team_name)
        self._save_team_index()

    def create_team(self, team_name: str, source_team: Optional[str] = None) -> None:
        normalized_team_name = (team_name or '').strip()
        if not normalized_team_name:
            raise ValueError('team_name 不能为空')
        if normalized_team_name in self._team_files:
            raise ValueError(f"team '{normalized_team_name}' 已存在")

        relative_path = self._default_team_relative_path(normalized_team_name)
        used_paths = set(self._team_files.values())
        if relative_path in used_paths:
            relative_path = f'{TEAM_CONFIG_DIR_NAME}/{_slugify_team_name(normalized_team_name)}-{datetime.now().strftime("%Y%m%d%H%M%S")}.yaml'

        self._team_files[normalized_team_name] = relative_path
        source_configs = self.get_team_configs(source_team) if source_team else {}
        self._write_team_payload(
            normalized_team_name,
            {
                'agents': {
                    agent_name: copy.deepcopy(_dump_agent_config(config))
                    for agent_name, config in source_configs.items()
                },
            },
        )
        self._save_team_index()

    def delete_team(self, team_name: str) -> None:
        if team_name not in self._team_files:
            raise ValueError(f"team '{team_name}' 不存在")
        if len(self._team_files) == 1:
            raise ValueError('至少需要保留一个 team')

        team_file = self._resolve_team_file_path(team_name)
        del self._team_files[team_name]
        if self._active_team == team_name:
            self._active_team = next(iter(self._team_files.keys()))
            self._configs = self._read_team_configs(self._active_team)
        self._save_team_index()
        if team_file.exists():
            team_file.unlink()

    def rename_team(self, team_name: str, new_team_name: str) -> None:
        normalized_new_name = (new_team_name or '').strip()
        if team_name not in self._team_files:
            raise ValueError(f"team '{team_name}' 不存在")
        if not normalized_new_name:
            raise ValueError('new_team_name 不能为空')
        if normalized_new_name != team_name and normalized_new_name in self._team_files:
            raise ValueError(f"team '{normalized_new_name}' 已存在")

        old_file = self._resolve_team_file_path(team_name)
        new_relative_path = self._default_team_relative_path(normalized_new_name)
        if normalized_new_name != team_name:
            self._team_files[normalized_new_name] = new_relative_path
            del self._team_files[team_name]

        new_file = self._resolve_team_file_path(normalized_new_name)
        new_file.parent.mkdir(parents=True, exist_ok=True)
        if old_file.exists() and old_file != new_file:
            old_file.replace(new_file)

        if self._active_team == team_name:
            self._active_team = normalized_new_name
        self._save_team_index()

    def copy_agents_between_teams(self, source_team: str, target_team: str, agent_names: List[str]) -> None:
        if source_team not in self._team_files:
            raise ValueError(f"source team '{source_team}' 不存在")
        if target_team not in self._team_files:
            raise ValueError(f"target team '{target_team}' 不存在")
        if not agent_names:
            raise ValueError('agent_names 不能为空')

        source_configs = self.get_team_configs(source_team)
        target_configs = self.get_team_configs(target_team)
        for agent_name in agent_names:
            config = source_configs.get(agent_name)
            if config is None:
                raise ValueError(f"源 team 中不存在智能体 '{agent_name}'")
            target_configs[agent_name] = AgentConfig(**copy.deepcopy(_dump_agent_config(config)))

        original_active_team = self._active_team
        original_configs = self._configs.copy()
        try:
            self._active_team = target_team
            self._configs = target_configs
            self._save_configs()
        finally:
            self._active_team = original_active_team
            self._configs = original_configs

    def apply_team_payload(
        self,
        team_name: str,
        agents_payload: Dict[str, Any],
        source_team: Optional[str] = None,
    ) -> Dict[str, Any]:
        normalized_team_name = (team_name or '').strip()
        if not normalized_team_name:
            raise ValueError('team_name 不能为空')
        if not isinstance(agents_payload, dict) or not agents_payload:
            raise ValueError('agents_payload 必须是非空对象')
        if source_team is not None and source_team not in self._team_files:
            raise ValueError(f"source team '{source_team}' 不存在")

        if normalized_team_name not in self._team_files:
            self.create_team(normalized_team_name, source_team=source_team)

        normalized_configs: Dict[str, AgentConfig] = {}
        default_entries = []
        for agent_name, config_payload in agents_payload.items():
            if not isinstance(config_payload, dict):
                raise ValueError(f"智能体 '{agent_name}' 的配置必须是对象")
            config_data = copy.deepcopy(config_payload)
            config_data.setdefault('agent_name', agent_name)
            config = AgentConfig(**config_data)
            if config.agent_name != agent_name:
                raise ValueError(f"智能体键名 '{agent_name}' 与配置中的 agent_name '{config.agent_name}' 不一致")
            if getattr(config, 'default_entry', False):
                default_entries.append(agent_name)
            normalized_configs[agent_name] = config

        if len(default_entries) > 1:
            raise ValueError(f'default_entry=true 只能有一个，当前: {default_entries}')

        payload = {
            'agents': {
                agent_name: _dump_agent_config(config)
                for agent_name, config in normalized_configs.items()
            },
        }
        self._write_team_payload(normalized_team_name, payload)
        if normalized_team_name == self._active_team:
            self._configs = normalized_configs

        return {
            'team_name': normalized_team_name,
            'agent_count': len(normalized_configs),
            'agents': sorted(normalized_configs.keys()),
            'source_team': source_team,
        }

    def get_team_summary(self) -> Dict[str, Any]:
        items = []
        for team_name, relative_path in self._team_files.items():
            configs = self.get_team_configs(team_name)
            items.append(
                {
                    'team_name': team_name,
                    'file_path': relative_path,
                    'agent_count': len(configs),
                    'agents': sorted(configs.keys()),
                    'is_active': team_name == self._active_team,
                }
            )
        return {
            'active_team': self._active_team,
            'teams': items,
        }

    def get_config(self, agent_name: str) -> Optional[AgentConfig]:
        return self._configs.get(agent_name)

    def get_all_configs(self) -> Dict[str, AgentConfig]:
        return self._configs.copy()

    def _clear_other_default_entries(self, target_agent_name: str) -> None:
        for name, config in self._configs.items():
            if name != target_agent_name and getattr(config, 'default_entry', False):
                config.default_entry = False

    def set_config(self, config: AgentConfig, save: bool = True):
        if getattr(config, 'default_entry', False):
            self._clear_other_default_entries(config.agent_name)
        self._configs[config.agent_name] = config
        if save:
            self._save_configs()
        logger.info("team=%s 智能体 '%s' 配置已更新", getattr(self, '_active_team', None), config.agent_name)

    def update_config(
        self,
        agent_name: str,
        tools: Optional[AgentToolConfig] = None,
        skills: Optional['AgentSkillConfig'] = None,
        mcp: Optional['AgentMCPConfig'] = None,
        memory: Optional['AgentMemoryConfig'] = None,
        tasks: Optional['AgentTaskConfig'] = None,
        custom_params: Optional[Dict] = None,
        enabled: Optional[bool] = None,
        save: bool = True,
    ) -> Optional[AgentConfig]:
        config = self.get_config(agent_name)
        if config is None:
            logger.warning("智能体 '%s' 不存在", agent_name)
            return None

        if tools is not None:
            config.tools = tools
        if skills is not None:
            config.skills = skills
        if mcp is not None:
            config.mcp = mcp
        if memory is not None:
            config.memory = memory
        if tasks is not None:
            config.tasks = tasks
        if custom_params is not None:
            config.custom_params = custom_params
        if enabled is not None:
            config.enabled = enabled

        if getattr(config, 'default_entry', False):
            self._clear_other_default_entries(agent_name)

        self.set_config(config, save=save)
        return config

    def delete_config(self, agent_name: str, save: bool = True):
        if agent_name in self._configs:
            del self._configs[agent_name]
            if save:
                self._save_configs()
            logger.info("team=%s 智能体 '%s' 配置已删除", self._active_team, agent_name)
        else:
            logger.warning("智能体 '%s' 不存在", agent_name)

    def apply_preset(self, agent_name: str, preset: AgentConfigPreset, save: bool = True) -> Optional[AgentConfig]:
        config = self.get_config(agent_name)
        if config is None:
            logger.warning("智能体 '%s' 不存在", agent_name)
            return None

        config = apply_preset(config, preset)
        self.set_config(config, save=save)
        logger.info("智能体 '%s' 已应用预设 '%s'", agent_name, preset.value)
        return config

    def list_agent_names(self) -> List[str]:
        return list(self._configs.keys())

    def get_enabled_agents(self) -> Dict[str, AgentConfig]:
        return {name: config for name, config in self._configs.items() if config.enabled}

    def export_config(self, agent_name: str, format: str = 'yaml') -> Optional[str]:
        config = self.get_config(agent_name)
        if config is None:
            return None
        data = _dump_agent_config(config)
        return _render_config_text(data, format)

    def import_config(self, config_str: str, format: str = 'yaml', save: bool = True) -> AgentConfig:
        data = _parse_config_text(config_str, format)
        config = AgentConfig(**data)
        self.set_config(config, save=save)
        logger.info("已导入智能体 '%s' 配置", config.agent_name)
        return config

    def validate_config(self, agent_name: str) -> tuple[bool, Optional[str]]:
        config = self.get_config(agent_name)
        if config is None:
            return False, f"智能体 '{agent_name}' 不存在"
        try:
            AgentConfig(**_dump_agent_config(config))
            return True, None
        except Exception as e:
            return False, str(e)



def get_config_manager() -> AgentConfigManager:
    return get_runtime_dependency(container_getter='get_agent_config_manager')
