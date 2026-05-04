# -*- coding: utf-8 -*-
"""
配置管理器 - 支持优先级加载和热重载
"""

import logging
import os
from pathlib import Path
from typing import Optional, Dict, Any
from dotenv import load_dotenv
from pydantic import ValidationError
from utils.yaml_store import load_yaml_file
from .models import AppConfig

logger = logging.getLogger(__name__)


class ConfigManager:
    """配置管理器 - 支持优先级加载和热重载"""

    def __init__(self):
        self._config: Optional[AppConfig] = None
        self._backend_root = Path(__file__).resolve().parent.parent
        self._config_dir = Path(__file__).parent / "yaml"
        self._default_config_path = self._config_dir / "config.default.yaml"
        # 用户配置固定从 CONFIG_ROOT/app/config.yaml 读取
        from core.path_resolution import CONFIG_ROOT
        self._user_config_path = CONFIG_ROOT / "app" / "config.yaml"
        load_dotenv(self._backend_root / ".env", override=False)
        self.load()

    def load(self):
        """加载配置（按优先级：环境变量 > config.yaml > Pydantic 默认值）"""
        # 1. 从默认 YAML 开始（可选，无则用空 dict，最终由 Pydantic 补全默认值）
        config_dict = self._load_yaml(self._default_config_path) or {}

        # 2. 合并用户 config.yaml（如果存在）
        if self._user_config_path.exists():
            user_config = self._load_yaml(self._user_config_path) or {}
            config_dict = self._deep_merge(config_dict, user_config)

        # 3. 环境变量覆盖
        env_overrides = self._get_env_overrides()
        if env_overrides:
            config_dict = self._deep_merge(config_dict, env_overrides)

        try:
            self._config = AppConfig(**config_dict)
        except ValidationError as e:
            logger.error("配置验证失败: %s", e, exc_info=True)
            raise

    def reload(self):
        """热重载配置"""
        self.load()

    def get_config(self) -> AppConfig:
        """获取当前配置"""
        return self._config

    def get_config_dict(self) -> dict:
        """返回当前配置的可序列化 dict。"""
        return self._config.model_dump()

    def update_config(self, partial: dict) -> AppConfig:
        """部分更新配置：深度合并 → 验证 → 持久化。"""
        current = self._config.model_dump()
        merged = self._deep_merge(current, partial)
        try:
            self._config = AppConfig(**merged)
        except ValidationError:
            # 验证失败时不改变当前配置
            raise
        self._persist()
        return self._config

    def _persist(self):
        """将当前配置写入用户 config.yaml（仅保存与默认值不同的字段）。"""
        from utils.yaml_store import save_yaml_file
        current = self._config.model_dump()
        defaults = AppConfig().model_dump()
        diff = self._compute_diff(current, defaults)
        self._user_config_path.parent.mkdir(parents=True, exist_ok=True)
        save_yaml_file(self._user_config_path, diff)

    def _compute_diff(self, current: dict, defaults: dict) -> dict:
        """计算 current 与 defaults 的差异，仅返回不同的键值对。"""
        diff = {}
        for key, value in current.items():
            default_value = defaults.get(key)
            if isinstance(value, dict) and isinstance(default_value, dict):
                sub_diff = self._compute_diff(value, default_value)
                if sub_diff:
                    diff[key] = sub_diff
            elif value != default_value:
                diff[key] = value
        return diff

    def _load_yaml(self, path: Path) -> Optional[dict]:
        """加载 YAML 文件"""
        if not path.exists():
            return None
        try:
            return load_yaml_file(path, default_factory=dict)
        except Exception as e:
            logger.error("加载配置文件失败 %s: %s", path, e, exc_info=True)
            return None

    def _deep_merge(self, base: dict, override: dict) -> dict:
        """深度合并两个字典"""
        result = base.copy()
        for key, value in override.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = self._deep_merge(result[key], value)
            else:
                result[key] = value
        return result

    def _get_env_overrides(self) -> Dict[str, Any]:
        """从环境变量获取配置覆盖"""
        overrides: Dict[str, Any] = {}

        llm_model_name = os.getenv('LLM_MODEL_NAME')
        if llm_model_name:
            overrides['llm'] = {'model_name': llm_model_name}

        return overrides
