# -*- coding: utf-8 -*-
"""
配置管理入口。
"""

from .base import ConfigManager
from .models import AppConfig, Neo4jConfig, LLMConfig, SystemConfig, ExternalLibsConfig
from runtime.dependencies import get_runtime_dependency

_config_manager: ConfigManager = None



def get_manager() -> ConfigManager:
    """获取配置管理器实例。"""
    return get_runtime_dependency(
        container_getter='get_config_manager',
        fallback_name='config_manager',
        fallback_factory=ConfigManager,
        require_container=True,
    )



def get_config() -> AppConfig:
    """获取当前配置。"""
    return get_manager().get_config()



def reload_config() -> AppConfig:
    """热重载配置。"""
    manager = get_manager()
    manager.reload()
    return manager.get_config()


__all__ = [
    'ConfigManager',
    'AppConfig',
    'Neo4jConfig',
    'LLMConfig',
    'SystemConfig',
    'ExternalLibsConfig',
    'get_config',
    'reload_config',
    'get_manager',
]
