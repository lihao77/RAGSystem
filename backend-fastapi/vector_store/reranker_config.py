# -*- coding: utf-8 -*-
"""
重排序器配置存储

与主系统 config 解耦，独立 YAML 文件存储多重排序器及激活态。
"""

import logging
import re
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone

from core.path_resolution import CONFIG_ROOT
from utils.versioned_yaml_store import load_versioned_yaml_file, save_versioned_yaml_file

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_DIR = CONFIG_ROOT / "vector_store"
DEFAULT_CONFIG_PATH = DEFAULT_CONFIG_DIR / "rerankers.yaml"


def _normalize_reranker_key(mode: str, provider_key: Optional[str] = None, model_name: Optional[str] = None) -> str:
    """
    生成重排序器键。
    model 模式: {provider_key}_{safe_model_name}
    lexical 模式: bm25_local
    none 模式: noop
    """
    mode = (mode or "none").strip().lower()
    if mode in {"none", "noop"}:
        return "noop"
    if mode in {"lexical", "bm25", "keyword", "local"}:
        return "bm25_local"
    if not provider_key or not model_name:
        raise ValueError("model 模式的重排序器必须提供 provider_key 和 model_name")
    safe_name = re.sub(r"[^\w\-.]", "_", model_name)
    raw = f"{provider_key}_{safe_name}"
    if len(raw) <= 120:
        return raw
    suffix = hashlib.sha256(model_name.encode("utf-8")).hexdigest()[:12]
    return f"{provider_key}_{suffix}"


class RerankerConfigStore:
    """重排序器配置的持久化与读取（YAML 文件）"""

    def __init__(self, config_path: Optional[Path] = None):
        self.config_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH

    def _build_empty_payload(self) -> Dict[str, Any]:
        return {
            "active_reranker_key": None,
            "rerankers": {},
        }

    def _migrate_raw(self, data: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
        if not isinstance(data, dict):
            return self._build_empty_payload(), True
        payload = dict(data)
        changed = False
        if not isinstance(payload.get("rerankers"), dict):
            payload["rerankers"] = {}
            changed = True
        for cfg in payload["rerankers"].values():
            if isinstance(cfg, dict) and "mode" not in cfg:
                cfg["mode"] = "none"
                changed = True
        return payload, changed

    def _load_raw(self) -> Dict[str, Any]:
        try:
            data, _ = load_versioned_yaml_file(
                self.config_path,
                default_factory=self._build_empty_payload,
                migrate=self._migrate_raw,
                persist_on_change=True,
                backup_on_change=True,
                default_flow_style=False,
                sort_keys=False,
            )
        except Exception as e:
            logger.warning("读取重排序器配置失败，使用默认: %s", e)
            return self._build_empty_payload()
        return data

    def _save_raw(self, data: Dict[str, Any]) -> None:
        save_versioned_yaml_file(self.config_path, data, backup=True, default_flow_style=False, sort_keys=False)

    def get_active_key(self) -> Optional[str]:
        return self._load_raw()["active_reranker_key"]

    def get_active_reranker_config(self) -> Optional[Dict[str, Any]]:
        """获取当前激活重排序器的完整配置，未激活返回 None"""
        data = self._load_raw()
        active = data["active_reranker_key"]
        if not active or active not in data["rerankers"]:
            return None
        cfg = dict(data["rerankers"][active])
        cfg["reranker_key"] = active
        return cfg

    def set_active_key(self, reranker_key: str) -> None:
        data = self._load_raw()
        if reranker_key and reranker_key not in data["rerankers"]:
            raise ValueError(f"重排序器不存在: {reranker_key}")
        data["active_reranker_key"] = reranker_key or None
        self._save_raw(data)
        logger.info("已设置激活重排序器: %s", reranker_key or "(无)")

    def list_rerankers(self) -> List[Dict[str, Any]]:
        raw = self._load_raw()
        active = raw["active_reranker_key"]
        result = []
        for key, cfg in raw["rerankers"].items():
            result.append({
                "reranker_key": key,
                "mode": cfg.get("mode", "none"),
                "provider_key": cfg.get("provider_key", ""),
                "provider_type": cfg.get("provider_type"),
                "model_name": cfg.get("model_name", ""),
                "api_endpoint": cfg.get("api_endpoint", ""),
                "created_at": cfg.get("created_at"),
                "is_active": key == active,
            })
        return result

    def get_reranker(self, reranker_key: str) -> Optional[Dict[str, Any]]:
        data = self._load_raw()
        if reranker_key not in data["rerankers"]:
            return None
        cfg = dict(data["rerankers"][reranker_key])
        cfg["reranker_key"] = reranker_key
        cfg["is_active"] = data["active_reranker_key"] == reranker_key
        return cfg

    def add_reranker(
        self,
        mode: str = "none",
        reranker_key: Optional[str] = None,
        provider_key: Optional[str] = None,
        provider_type: Optional[str] = None,
        model_name: Optional[str] = None,
        api_endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        **_extra: Any,
    ) -> str:
        key = reranker_key or _normalize_reranker_key(mode, provider_key, model_name)
        data = self._load_raw()
        if key in data["rerankers"]:
            raise ValueError(f"重排序器键已存在: {key}")
        entry: Dict[str, Any] = {
            "mode": (mode or "none").strip().lower(),
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        if provider_key:
            entry["provider_key"] = provider_key
        if provider_type:
            entry["provider_type"] = provider_type
        if model_name:
            entry["model_name"] = model_name
        if api_endpoint:
            entry["api_endpoint"] = api_endpoint
        if api_key:
            entry["api_key"] = api_key
        data["rerankers"][key] = entry
        if not data["active_reranker_key"]:
            data["active_reranker_key"] = key
        self._save_raw(data)
        logger.info("已添加重排序器: %s (mode=%s)", key, mode)
        return key

    def delete_reranker(self, reranker_key: str) -> None:
        data = self._load_raw()
        if reranker_key not in data["rerankers"]:
            raise ValueError(f"重排序器不存在: {reranker_key}")
        del data["rerankers"][reranker_key]
        if data["active_reranker_key"] == reranker_key:
            data["active_reranker_key"] = list(data["rerankers"].keys())[0] if data["rerankers"] else None
        self._save_raw(data)
        logger.info("已删除重排序器配置: %s", reranker_key)


def get_reranker_config_store(config_path: Optional[Path] = None) -> RerankerConfigStore:
    """获取重排序器配置存储单例（按路径区分）"""
    path = config_path or DEFAULT_CONFIG_PATH
    if not hasattr(get_reranker_config_store, "_instances"):
        get_reranker_config_store._instances = {}
    if path not in get_reranker_config_store._instances:
        get_reranker_config_store._instances[path] = RerankerConfigStore(path)
    return get_reranker_config_store._instances[path]
