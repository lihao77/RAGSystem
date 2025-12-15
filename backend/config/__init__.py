# -*- coding: utf-8 -*-
"""
配置管理入口
"""

from .base import ConfigManager
from .models import AppConfig, Neo4jConfig, LLMConfig, SystemConfig, ExternalLibsConfig

# 全局配置管理器实例
_config_manager: ConfigManager = None


def get_config() -> AppConfig:
    """获取当前配置

    Returns:
        AppConfig: 当前应用配置
    """
    global _config_manager
    if not _config_manager:
        _config_manager = ConfigManager()
    return _config_manager.get_config()


def reload_config() -> AppConfig:
    """热重载配置

    Returns:
        AppConfig: 重新加载后的配置
    """
    global _config_manager
    if _config_manager:
        _config_manager.reload()
    return get_config()


def get_manager() -> ConfigManager:
    """获取配置管理器实例

    Returns:
        ConfigManager: 配置管理器实例
    """
    global _config_manager
    if not _config_manager:
        _config_manager = ConfigManager()
    return _config_manager


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
