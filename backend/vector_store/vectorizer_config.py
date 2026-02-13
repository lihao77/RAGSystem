# -*- coding: utf-8 -*-
"""
向量化器配置存储

与主系统 config.embedding 解耦，独立 YAML 文件存储多向量化器及激活态。
"""

import logging
import re
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime

import yaml

logger = logging.getLogger(__name__)

# 默认配置文件路径（相对于 backend/）
DEFAULT_CONFIG_DIR = Path(__file__).parent / "config"
DEFAULT_CONFIG_PATH = DEFAULT_CONFIG_DIR / "vectorizers.yaml"


def _normalize_vectorizer_key(provider_key: str, model_name: str) -> str:
    """
    生成全局唯一的向量化器键。
    格式: provider_key + _ + 安全化的 model_name（过长时用短哈希）。
    """
    safe_name = re.sub(r"[^\w\-.]", "_", model_name)
    raw = f"{provider_key}_{safe_name}"
    if len(raw) <= 120:
        return raw
    suffix = hashlib.sha256(model_name.encode("utf-8")).hexdigest()[:12]
    return f"{provider_key}_{suffix}"


class VectorizerConfigStore:
    """向量化器配置的持久化与读取（YAML 文件）"""

    def __init__(self, config_path: Optional[Path] = None):
        self.config_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
        self.config_path.parent.mkdir(parents=True, exist_ok=True)

    def _load_raw(self) -> Dict[str, Any]:
        """读取 YAML 为字典，文件不存在时返回默认结构"""
        if not self.config_path.exists():
            return {
                "active_vectorizer_key": None,
                "vectorizers": {},
            }
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
        except Exception as e:
            logger.warning("读取向量化器配置失败，使用默认: %s", e)
            return {"active_vectorizer_key": None, "vectorizers": {}}
        if not isinstance(data, dict):
            return {"active_vectorizer_key": None, "vectorizers": {}}
        return {
            "active_vectorizer_key": data.get("active_vectorizer_key"),
            "vectorizers": data.get("vectorizers") or {},
        }

    def _save_raw(self, data: Dict[str, Any]) -> None:
        """写入 YAML"""
        with open(self.config_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

    def get_active_key(self) -> Optional[str]:
        """当前激活的向量化器键"""
        return self._load_raw()["active_vectorizer_key"]

    def set_active_key(self, vectorizer_key: str) -> None:
        """设为当前激活的向量化器（键必须已存在）"""
        data = self._load_raw()
        if vectorizer_key and vectorizer_key not in data["vectorizers"]:
            raise ValueError(f"向量化器不存在: {vectorizer_key}")
        data["active_vectorizer_key"] = vectorizer_key or None
        self._save_raw(data)
        logger.info("已设置激活向量化器: %s", vectorizer_key or "(无)")

    def list_vectorizers(self) -> List[Dict[str, Any]]:
        """列出所有向量化器配置（含 active 标记）"""
        raw = self._load_raw()
        active = raw["active_vectorizer_key"]
        result = []
        for key, cfg in raw["vectorizers"].items():
            result.append({
                "vectorizer_key": key,
                "provider_key": cfg.get("provider_key", ""),
                "model_name": cfg.get("model_name", ""),
                "distance_metric": cfg.get("distance_metric", "cosine"),
                "created_at": cfg.get("created_at"),
                "is_active": key == active,
            })
        return result

    def get_vectorizer(self, vectorizer_key: str) -> Optional[Dict[str, Any]]:
        """获取单个向量化器配置"""
        data = self._load_raw()
        if vectorizer_key not in data["vectorizers"]:
            return None
        cfg = dict(data["vectorizers"][vectorizer_key])
        cfg["vectorizer_key"] = vectorizer_key
        cfg["is_active"] = data["active_vectorizer_key"] == vectorizer_key
        return cfg

    def add_vectorizer(
        self,
        provider_key: str,
        model_name: str,
        distance_metric: str = "cosine",
        vectorizer_key: Optional[str] = None,
        provider_type: Optional[str] = None,
    ) -> str:
        """
        新增向量化器配置。
        返回实际使用的 vectorizer_key（若未传则自动生成）。
        """
        key = vectorizer_key or _normalize_vectorizer_key(provider_key, model_name)
        data = self._load_raw()
        if key in data["vectorizers"]:
            raise ValueError(f"向量化器键已存在: {key}")
        entry = {
            "provider_key": provider_key,
            "model_name": model_name,
            "distance_metric": distance_metric,
            "created_at": datetime.utcnow().isoformat() + "Z",
        }
        if provider_type:
            entry["provider_type"] = provider_type
        data["vectorizers"][key] = entry
        # 若当前无激活，则激活本条
        if not data["active_vectorizer_key"]:
            data["active_vectorizer_key"] = key
        self._save_raw(data)
        logger.info("已添加向量化器: %s (%s / %s)", key, provider_key, model_name)
        return key

    def delete_vectorizer(self, vectorizer_key: str) -> None:
        """删除向量化器配置；若其为当前激活则清空激活"""
        data = self._load_raw()
        if vectorizer_key not in data["vectorizers"]:
            raise ValueError(f"向量化器不存在: {vectorizer_key}")
        del data["vectorizers"][vectorizer_key]
        if data["active_vectorizer_key"] == vectorizer_key:
            data["active_vectorizer_key"] = list(data["vectorizers"].keys())[0] if data["vectorizers"] else None
        self._save_raw(data)
        logger.info("已删除向量化器配置: %s", vectorizer_key)


def get_vectorizer_config_store(config_path: Optional[Path] = None) -> VectorizerConfigStore:
    """获取向量化器配置存储单例（按路径区分）"""
    path = config_path or DEFAULT_CONFIG_PATH
    if not hasattr(get_vectorizer_config_store, "_instances"):
        get_vectorizer_config_store._instances = {}
    if path not in get_vectorizer_config_store._instances:
        get_vectorizer_config_store._instances[path] = VectorizerConfigStore(path)
    return get_vectorizer_config_store._instances[path]
