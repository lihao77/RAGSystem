"""
Model Adapter 配置存储管理（单一文件架构）

简化版本：使用单一 YAML 文件存储所有 Provider 配置
"""

import logging
from typing import Dict, Optional
from pathlib import Path

from integrations.model_providers.factory import canonicalize_provider_config
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
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
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

            normalized_config = canonicalize_provider_config(config)
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

    def save_all(self, configs: Dict[str, Dict]) -> None:
        """
        保存所有 Provider 配置
        
        Args:
            configs: {provider_key: config_dict}
        """
        try:
            save_yaml_file(self.config_file, configs, indent=2, sort_keys=False)
            
            logger.info(f"已保存 {len(configs)} 个 Provider 配置")
            
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
        configs = self.load_all()
        configs[provider_key] = config
        self.save_all(configs)
        
        logger.info(f"已保存 Provider: {provider_key}")
    
    def delete_provider(self, provider_key: str) -> bool:
        """
        删除单个 Provider 配置
        
        Args:
            provider_key: 复合键（如 test_deepseek）
            
        Returns:
            bool: 是否删除成功
        """
        configs = self.load_all()
        
        if provider_key in configs:
            del configs[provider_key]
            self.save_all(configs)
            logger.info(f"已删除 Provider: {provider_key}")
            return True
        else:
            logger.warning(f"Provider 不存在: {provider_key}")
            return False
    
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
