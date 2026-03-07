# -*- coding: utf-8 -*-
"""
配置管理入口。
"""

from .base import ConfigManager
from .models import AppConfig, Neo4jConfig, LLMConfig, SystemConfig, ExternalLibsConfig

_config_manager: ConfigManager = None



def get_manager() -> ConfigManager:
    """获取配置管理器实例。"""
    try:
        from runtime.container import get_current_runtime_container

        container = get_current_runtime_container()
        if container is not None:
            return container.get_config_manager()
    except Exception:
        pass

    global _config_manager
    if not _config_manager:
        _config_manager = ConfigManager()
    return _config_manager



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
