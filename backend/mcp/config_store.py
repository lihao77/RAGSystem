# -*- coding: utf-8 -*-
"""
MCP Server 配置持久化

读写 backend/mcp/configs/mcp_servers.yaml
"""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime

import yaml

from runtime.dependencies import get_runtime_dependency

from .config import MCPServerConfig

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_DIR = Path(__file__).parent / "configs"
DEFAULT_CONFIG_PATH = DEFAULT_CONFIG_DIR / "mcp_servers.yaml"


class MCPConfigStore:
    """MCP Server 配置的持久化与读取"""

    def __init__(self, config_path: Optional[Path] = None):
        self.config_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
        self.config_path.parent.mkdir(parents=True, exist_ok=True)

    def _load_raw(self) -> Dict[str, Any]:
        """读取 YAML，文件不存在时返回默认结构"""
        if not self.config_path.exists():
            return {"servers": {}}
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
        except Exception as e:
            logger.warning(f"读取 MCP 配置失败，使用默认: {e}")
            return {"servers": {}}
        if not isinstance(data, dict):
            return {"servers": {}}
        return {"servers": data.get("servers") or {}}

    def _save_raw(self, data: Dict[str, Any]) -> None:
        """写入 YAML"""
        with open(self.config_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

    def list_servers(self) -> List[Dict[str, Any]]:
        """列出所有 MCP Server 配置"""
        raw = self._load_raw()
        result = []
        for name, cfg in raw["servers"].items():
            entry = dict(cfg)
            entry["name"] = name
            result.append(entry)
        return result

    def get_server(self, server_name: str) -> Optional[Dict[str, Any]]:
        """获取单个 Server 配置"""
        raw = self._load_raw()
        cfg = raw["servers"].get(server_name)
        if cfg is None:
            return None
        entry = dict(cfg)
        entry["name"] = server_name
        return entry

    def add_server(self, config: MCPServerConfig) -> str:
        """添加 MCP Server 配置"""
        data = self._load_raw()
        if config.name in data["servers"]:
            raise ValueError(f"MCP Server 已存在: {config.name}")
        entry = config.model_dump(exclude_none=False)
        entry.pop("name", None)
        entry["created_at"] = datetime.utcnow().isoformat() + "Z"
        data["servers"][config.name] = entry
        self._save_raw(data)
        logger.info(f"已添加 MCP Server: {config.name}")
        return config.name

    def update_server(self, server_name: str, updates: Dict[str, Any]) -> None:
        """更新 Server 配置"""
        data = self._load_raw()
        if server_name not in data["servers"]:
            raise ValueError(f"MCP Server 不存在: {server_name}")
        # 不允许修改 name
        updates.pop("name", None)
        data["servers"][server_name].update(updates)
        data["servers"][server_name]["updated_at"] = datetime.utcnow().isoformat() + "Z"
        self._save_raw(data)
        logger.info(f"已更新 MCP Server: {server_name}")

    def remove_server(self, server_name: str) -> None:
        """删除 Server 配置"""
        data = self._load_raw()
        if server_name not in data["servers"]:
            raise ValueError(f"MCP Server 不存在: {server_name}")
        del data["servers"][server_name]
        self._save_raw(data)
        logger.info(f"已删除 MCP Server: {server_name}")


_instance: Optional[MCPConfigStore] = None


def get_mcp_config_store(config_path: Optional[Path] = None) -> MCPConfigStore:
    """获取 MCP 配置存储实例。"""
    global _instance
    if config_path is not None:
        return MCPConfigStore(config_path)

    return get_runtime_dependency(
        container_getter='get_mcp_config_store',
        fallback_name='mcp_config_store',
        fallback_factory=MCPConfigStore,
        legacy_getter=lambda: _instance,
        legacy_setter=lambda instance: globals().__setitem__('_instance', instance),
    )
