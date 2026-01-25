# -*- coding: utf-8 -*-
"""
智能体配置管理服务

负责智能体配置的加载、保存、更新和查询
"""

import os
import yaml
import json
import logging
from typing import Dict, Optional, List
from datetime import datetime
from pathlib import Path
from .agent_config import AgentConfig, AgentLLMConfig, AgentToolConfig, AgentConfigPreset, apply_preset

logger = logging.getLogger(__name__)


class AgentConfigManager:
    """
    智能体配置管理器

    功能：
    1. 从文件加载配置
    2. 保存配置到文件
    3. 运行时配置管理（CRUD）
    4. 配置验证
    5. 预设配置应用
    """

    def __init__(self, config_dir: str = None):
        """
        初始化配置管理器

        Args:
            config_dir: 配置文件目录，默认为 backend/agents/configs/
        """
        if config_dir is None:
            # 默认配置目录：agents 模块内的 configs 子目录
            agents_dir = Path(__file__).parent
            config_dir = agents_dir / "configs"

        self.config_dir = Path(config_dir)
        self.config_file = self.config_dir / "agent_configs.yaml"

        # 确保目录存在
        self.config_dir.mkdir(parents=True, exist_ok=True)

        # 内存中的配置缓存
        self._configs: Dict[str, AgentConfig] = {}

        # 加载配置
        self._load_configs()

        logger.info(f"AgentConfigManager 初始化完成，配置目录: {self.config_dir}")

    def _load_configs(self):
        """从文件加载配置"""
        if not self.config_file.exists():
            logger.info(f"配置文件不存在，创建默认配置: {self.config_file}")
            self._create_default_configs()
            return

        try:
            with open(self.config_file, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f) or {}

            # 解析配置
            for agent_name, config_data in data.get('agents', {}).items():
                try:
                    config = AgentConfig(**config_data)
                    self._configs[agent_name] = config
                except Exception as e:
                    logger.error(f"解析智能体 '{agent_name}' 配置失败: {e}")

            logger.info(f"成功加载 {len(self._configs)} 个智能体配置")

        except Exception as e:
            logger.error(f"加载配置文件失败: {e}")
            self._create_default_configs()

    def _create_default_configs(self):
        """创建默认配置"""

        # # MasterAgent 默认配置
        # master_config = AgentConfig(
        #     agent_name="master_agent",
        #     display_name="主协调智能体",
        #     description="主协调智能体，负责任务分析、分解和结果整合",
        #     enabled=True,
        #     llm=AgentLLMConfig(
        #         temperature=0.0,  # 分析任务时需要确定性
        #         max_tokens=2000,
        #         timeout=30,
        #         retry_attempts=3
        #     ),
        #     custom_params={
        #         "analysis_temperature": 0.0,
        #         "synthesis_temperature": 0.3
        #     }
        # )


        # self._configs["master_agent"] = master_config

        # 保存到文件
        self._save_configs()

        logger.info("已创建默认智能体配置")

    def _save_configs(self):
        """保存配置到文件"""
        try:
            # 准备数据
            data = {
                'agents': {},
                'metadata': {
                    'updated_at': datetime.now().isoformat(),
                    'version': '1.0'
                }
            }

            for agent_name, config in self._configs.items():
                data['agents'][agent_name] = config.model_dump()

            # 写入文件
            with open(self.config_file, 'w', encoding='utf-8') as f:
                yaml.dump(data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

            logger.info(f"配置已保存到: {self.config_file}")

        except Exception as e:
            logger.error(f"保存配置失败: {e}")
            raise

    def get_config(self, agent_name: str) -> Optional[AgentConfig]:
        """
        获取智能体配置

        Args:
            agent_name: 智能体名称

        Returns:
            智能体配置，如果不存在返回 None
        """
        return self._configs.get(agent_name)

    def get_all_configs(self) -> Dict[str, AgentConfig]:
        """
        获取所有智能体配置

        Returns:
            所有智能体配置字典
        """
        return self._configs.copy()

    def set_config(self, config: AgentConfig, save: bool = True):
        """
        设置智能体配置

        Args:
            config: 智能体配置
            save: 是否立即保存到文件
        """
        # 保存到内存
        self._configs[config.agent_name] = config

        # 保存到文件
        if save:
            self._save_configs()

        logger.info(f"智能体 '{config.agent_name}' 配置已更新")

    def update_config(
        self,
        agent_name: str,
        llm: Optional[AgentLLMConfig] = None,
        tools: Optional[AgentToolConfig] = None,
        skills: Optional['AgentSkillConfig'] = None,
        custom_params: Optional[Dict] = None,
        enabled: Optional[bool] = None,
        save: bool = True
    ) -> Optional[AgentConfig]:
        """
        更新智能体配置（部分更新）

        Args:
            agent_name: 智能体名称
            llm: LLM 配置（可选）
            tools: 工具配置（可选）
            skills: Skills 配置（可选）
            custom_params: 自定义参数（可选）
            enabled: 是否启用（可选）
            save: 是否立即保存

        Returns:
            更新后的配置，如果智能体不存在返回 None
        """
        config = self.get_config(agent_name)
        if config is None:
            logger.warning(f"智能体 '{agent_name}' 不存在")
            return None

        # 更新字段
        if llm is not None:
            config.llm = llm
        if tools is not None:
            config.tools = tools
        if skills is not None:
            config.skills = skills
        if custom_params is not None:
            config.custom_params = custom_params  # 完整替换，不使用 update
        if enabled is not None:
            config.enabled = enabled

        # 保存
        self.set_config(config, save=save)

        return config

    def delete_config(self, agent_name: str, save: bool = True):
        """
        删除智能体配置

        Args:
            agent_name: 智能体名称
            save: 是否立即保存
        """
        if agent_name in self._configs:
            del self._configs[agent_name]

            if save:
                self._save_configs()

            logger.info(f"智能体 '{agent_name}' 配置已删除")
        else:
            logger.warning(f"智能体 '{agent_name}' 不存在")

    def apply_preset(self, agent_name: str, preset: AgentConfigPreset, save: bool = True) -> Optional[AgentConfig]:
        """
        应用预设配置

        Args:
            agent_name: 智能体名称
            preset: 预设类型
            save: 是否立即保存

        Returns:
            更新后的配置，如果智能体不存在返回 None
        """
        config = self.get_config(agent_name)
        if config is None:
            logger.warning(f"智能体 '{agent_name}' 不存在")
            return None

        # 应用预设
        config = apply_preset(config, preset)

        # 保存
        self.set_config(config, save=save)

        logger.info(f"智能体 '{agent_name}' 已应用预设 '{preset.value}'")

        return config

    def list_agent_names(self) -> List[str]:
        """
        列出所有智能体名称

        Returns:
            智能体名称列表
        """
        return list(self._configs.keys())

    def get_enabled_agents(self) -> Dict[str, AgentConfig]:
        """
        获取所有启用的智能体配置

        Returns:
            启用的智能体配置字典
        """
        return {
            name: config
            for name, config in self._configs.items()
            if config.enabled
        }

    def export_config(self, agent_name: str, format: str = 'yaml') -> Optional[str]:
        """
        导出智能体配置为字符串

        Args:
            agent_name: 智能体名称
            format: 格式（'yaml' 或 'json'）

        Returns:
            配置字符串，如果智能体不存在返回 None
        """
        config = self.get_config(agent_name)
        if config is None:
            return None

        data = config.model_dump()

        if format == 'yaml':
            return yaml.dump(data, allow_unicode=True, default_flow_style=False)
        elif format == 'json':
            return json.dumps(data, ensure_ascii=False, indent=2)
        else:
            raise ValueError(f"不支持的格式: {format}")

    def import_config(self, config_str: str, format: str = 'yaml', save: bool = True) -> AgentConfig:
        """
        从字符串导入智能体配置

        Args:
            config_str: 配置字符串
            format: 格式（'yaml' 或 'json'）
            save: 是否立即保存

        Returns:
            导入的配置
        """
        if format == 'yaml':
            data = yaml.safe_load(config_str)
        elif format == 'json':
            data = json.loads(config_str)
        else:
            raise ValueError(f"不支持的格式: {format}")

        # 验证并创建配置
        config = AgentConfig(**data)

        # 保存
        self.set_config(config, save=save)

        logger.info(f"已导入智能体 '{config.agent_name}' 配置")

        return config

    def validate_config(self, agent_name: str) -> tuple[bool, Optional[str]]:
        """
        验证智能体配置

        Args:
            agent_name: 智能体名称

        Returns:
            (是否有效, 错误信息)
        """
        config = self.get_config(agent_name)
        if config is None:
            return False, f"智能体 '{agent_name}' 不存在"

        try:
            # Pydantic 自动验证
            AgentConfig(**config.model_dump())
            return True, None
        except Exception as e:
            return False, str(e)


# 全局单例
_global_config_manager: Optional[AgentConfigManager] = None


def get_config_manager() -> AgentConfigManager:
    """
    获取全局配置管理器单例

    Returns:
        AgentConfigManager 实例
    """
    global _global_config_manager
    if _global_config_manager is None:
        _global_config_manager = AgentConfigManager()
    return _global_config_manager
