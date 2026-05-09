"""
Model Adapter 配置存储管理（单一文件架构）

简化版本：使用单一 YAML 文件存储所有 Provider 配置
"""

import logging
from typing import Any, Dict, Optional
from pathlib import Path

from integrations.model_providers.factory import canonicalize_provider_config
from utils.file_lock import FileLock
from utils.yaml_store import load_yaml_file, save_yaml_file

logger = logging.getLogger(__name__)


class ModelAdapterConfigStore:
    """
    Model Adapter 配置存储管理类（单一文件版本）
    
    使用单一 providers.yaml 文件存储所有 Provider 配置
    以复合键 {name}_{provider_type} 作为唯一标识
    """
    
    def __init__(self, config_file: Optional[str | Path] = None):
        """初始化配置存储管理器"""
        if config_file:
            self.config_file = Path(config_file)
        else:
            from core.path_resolution import CONFIG_ROOT
            self.config_file = CONFIG_ROOT / "model_adapter" / "providers.yaml"
        logger.info(f"Model Adapter 配置文件: {self.config_file}")
    
    def load_all(self) -> Dict[str, Dict]:
        """
        加载所有 Provider 配置

        Returns:
            Dict[str, Dict]: {provider_key: config_dict}
        """
        if not self.config_file.exists():
            logger.warning(f"配置文件不存在: {self.config_file}")
            return {}

        try:
            configs = load_yaml_file(self.config_file, default_factory=dict)
            normalized_configs = self._normalize_configs(configs)
            if normalized_configs != configs:
                self.save_all(normalized_configs)

            logger.debug(f"加载了 {len(normalized_configs)} 个 Provider 配置")
            return normalized_configs

        except Exception as e:
            logger.error(f"加载配置文件失败: {e}")
            return {}

    def _normalize_configs(self, configs: Dict[str, Dict]) -> Dict[str, Dict]:
        normalized_configs: Dict[str, Dict] = {}
        for provider_key, config in (configs or {}).items():
            if not isinstance(config, dict):
                logger.warning(f"跳过无效 Provider 配置: {provider_key}")
                continue

            normalized_config = self._normalize_provider_config(config)
            normalized_key = self._make_provider_key(
                normalized_config.get("name", ""),
                normalized_config.get("provider_type", ""),
            )
            if not normalized_key:
                logger.warning(f"跳过缺少 name/provider_type 的 Provider 配置: {provider_key}")
                continue
            normalized_configs[normalized_key] = normalized_config
        return normalized_configs

    @staticmethod
    def _make_provider_key(name: str, provider_type: str) -> str:
        clean_name = str(name or "").lower().replace(" ", "_")
        clean_type = str(provider_type or "").lower()
        if not clean_name or not clean_type:
            return ""
        return f"{clean_name}_{clean_type}"

    @staticmethod
    def _normalize_model_value(value: Any) -> str | list[str]:
        if isinstance(value, list):
            models = []
            seen = set()
            for item in value:
                model = str(item or "").strip()
                if model and model not in seen:
                    models.append(model)
                    seen.add(model)
            return models
        return str(value or "").strip()

    @classmethod
    def _normalize_model_map(cls, model_map: Any) -> Dict[str, str | list[str]]:
        if not isinstance(model_map, dict):
            return {}

        normalized: Dict[str, str | list[str]] = {}
        for task, value in model_map.items():
            task_name = str(task or "").strip()
            if not task_name:
                continue
            model_value = cls._normalize_model_value(value)
            if model_value:
                normalized[task_name] = model_value
        return normalized

    @classmethod
    def _rebuild_models_from_model_map(cls, config: Dict[str, Any]) -> None:
        model_map = cls._normalize_model_map(config.get("model_map"))
        fallback_model = str(config.get("model") or "").strip()
        fallback_models = cls._normalize_model_value(config.get("models"))

        if "chat" not in model_map and fallback_model:
            model_map["chat"] = fallback_model
        elif not model_map and fallback_models:
            model_map["chat"] = fallback_models

        config["model_map"] = model_map

        models = []
        seen = set()
        for value in model_map.values():
            values = value if isinstance(value, list) else [value]
            for item in values:
                model = str(item or "").strip()
                if model and model not in seen:
                    models.append(model)
                    seen.add(model)
        config["models"] = models

    def _normalize_provider_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        normalized_config = canonicalize_provider_config(config)
        self._rebuild_models_from_model_map(normalized_config)
        return normalized_config

    def _load_all_unlocked(self) -> Dict[str, Dict]:
        if not self.config_file.exists():
            return {}
        configs = load_yaml_file(self.config_file, default_factory=dict)
        return self._normalize_configs(configs)

    def _save_all_unlocked(self, configs: Dict[str, Dict]) -> None:
        save_yaml_file(self.config_file, configs, indent=2, sort_keys=False)

    def save_all(self, configs: Dict[str, Dict]) -> None:
        """
        保存所有 Provider 配置

        Args:
            configs: {provider_key: config_dict}
        """
        try:
            with FileLock(self.config_file):
                normalized_configs = self._normalize_configs(configs)
                self._save_all_unlocked(normalized_configs)
            logger.info(f"已保存 {len(normalized_configs)} 个 Provider 配置")

        except Exception as e:
            logger.error(f"保存配置文件失败: {e}")
            raise

    def save_provider(self, provider_key: str, config: Dict) -> None:
        """
        保存单个 Provider 配置

        Args:
            provider_key: 复合键（如 test_deepseek）
            config: Provider 配置字典
        """
        with FileLock(self.config_file):
            configs = self._load_all_unlocked()
            configs[provider_key] = self._normalize_provider_config(config)
            self._save_all_unlocked(configs)

        logger.info(f"已保存 Provider: {provider_key}")
    
    def delete_provider(self, provider_key: str) -> bool:
        """
        删除单个 Provider 配置

        Args:
            provider_key: 复合键（如 test_deepseek）

        Returns:
            bool: 是否删除成功
        """
        with FileLock(self.config_file):
            configs = self._load_all_unlocked()

            if provider_key in configs:
                del configs[provider_key]
                self._save_all_unlocked(configs)
                logger.info(f"已删除 Provider: {provider_key}")
                return True

        logger.warning(f"Provider 不存在: {provider_key}")
        return False
    
    def reorder_providers(self, provider_keys: list[str]) -> Dict[str, Dict]:
        """按传入 provider_key 列表重排 providers.yaml 顶层顺序。"""
        if len(provider_keys) != len(set(provider_keys)):
            raise ValueError("Provider 顺序列表包含重复 key")

        with FileLock(self.config_file):
            configs = self._load_all_unlocked()
            current_keys = list(configs.keys())
            requested_keys = [str(key).strip() for key in provider_keys]

            missing = [key for key in current_keys if key not in requested_keys]
            unknown = [key for key in requested_keys if key not in configs]
            if missing or unknown:
                details = []
                if missing:
                    details.append(f"缺少 Provider: {', '.join(missing)}")
                if unknown:
                    details.append(f"未知 Provider: {', '.join(unknown)}")
                raise ValueError("; ".join(details))

            reordered = {key: configs[key] for key in requested_keys}
            self._save_all_unlocked(reordered)

        logger.info("已更新 Provider 顺序: %s", ", ".join(provider_keys))
        return reordered

    def get_provider(self, provider_key: str) -> Optional[Dict]:
        """
        获取单个 Provider 配置
        
        Args:
            provider_key: 复合键（如 test_deepseek）
            
        Returns:
            Optional[Dict]: Provider 配置，不存在则返回 None
        """
        configs = self.load_all()
        return configs.get(provider_key)
    
    def exists(self, provider_key: str) -> bool:
        """
        检查 Provider 是否存在
        
        Args:
            provider_key: 复合键（如 test_deepseek）
            
        Returns:
            bool: 是否存在
        """
        configs = self.load_all()
        return provider_key in configs
