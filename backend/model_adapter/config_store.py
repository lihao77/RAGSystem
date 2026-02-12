"""
Model Adapter 配置存储管理

实现 Model Adapter 配置的持久化存储，参考节点系统的配置管理模式
"""

import os
import yaml
import uuid
import logging
from typing import Dict, List, Optional, Any
from pathlib import Path
from datetime import datetime

logger = logging.getLogger(__name__)


class ModelAdapterConfigStore:
    """
    Model Adapter 配置存储管理类

    管理 AI Provider 配置文件的存储、加载、删除等操作
    配置文件存储在 backend/model_adapter/configs/instances/ 目录下
    """

    def __init__(self):
        """初始化配置存储管理器"""
        self.configs_dir = Path(__file__).parent / "configs" / "instances"
        self.configs_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"Model Adapter 配置存储目录: {self.configs_dir}")

    def _generate_config_id(self) -> str:
        """
        生成唯一的配置ID

        Returns:
            str: UUID前8位
        """
        return str(uuid.uuid4())[:8]

    def _get_config_path(self, config_id: str, name: str) -> Path:
        """
        获取配置文件路径

        Args:
            config_id: 配置ID
            name: 配置名称

        Returns:
            Path: 配置文件完整路径
        """
        # 清理文件名中的非法字符
        safe_name = "".join(c for c in name if c.isalnum() or c in ('-', '_')).rstrip()
        filename = f"{config_id}_{safe_name}.yaml"
        return self.configs_dir / filename

    def save_config(self, config: Dict[str, Any], config_id: Optional[str] = None,
                    overwrite: bool = True) -> str:
        """
        保存 Provider 配置

        Args:
            config: 配置数据
            config_id: 配置ID（如果为None则生成新的）
            overwrite: 是否覆盖同名配置

        Returns:
            str: 配置ID
        """
        try:
            # 生成或获取配置ID
            if not config_id:
                config_id = self._generate_config_id()

            # 准备元数据
            name = config.get('name', 'unnamed')
            provider_type = config.get('provider_type', 'unknown')

            # 构建完整的配置结构
            config_data = {
                '_metadata': {
                    'id': config_id,
                    'name': name,
                    'provider_type': provider_type,
                    'created_at': datetime.now().isoformat(),
                    'updated_at': datetime.now().isoformat(),
                    'version': '1.0'
                },
                'config': {
                    'provider_type': provider_type,
                    'name': name,
                    'api_key': config.get('api_key', ''),
                    'api_endpoint': config.get('api_endpoint', ''),
                    'models': config.get('models', []),
                    'model_map': config.get('model_map', {}), # 新增 model_map
                    'temperature': config.get('temperature', 0.7),
                    'max_tokens': config.get('max_tokens', 4096),
                    'timeout': config.get('timeout', 30),
                    'retry_attempts': config.get('retry_attempts', 3),
                    'retry_delay': config.get('retry_delay', 1.0),
                    'supports_function_calling': config.get('supports_function_calling', True),
                    # 保存其他额外参数
                    **{k: v for k, v in config.items() if k not in [
                        'provider_type', 'name', 'api_key', 'api_endpoint', 'models', 'model_map',
                        'temperature', 'max_tokens', 'timeout', 'retry_attempts',
                        'retry_delay', 'supports_function_calling'
                    ]}
                }
            }

            # 检查是否已存在（基于名称，不区分大小写）
            config_path = self._get_config_path(config_id, name)
            if config_path.exists() and not overwrite:
                raise FileExistsError(f"配置已存在: {config_path}")

            # 保存到文件
            with open(config_path, 'w', encoding='utf-8') as f:
                yaml.dump(config_data, f, allow_unicode=True, indent=2)

            logger.info(f"配置已保存: {config_path}")
            return config_id

        except Exception as e:
            logger.error(f"保存配置失败: {str(e)}")
            raise

    def load_config(self, config_id: str) -> Optional[Dict[str, Any]]:
        """
        加载指定配置

        Args:
            config_id: 配置ID

        Returns:
            Optional[Dict]: 配置数据，如果不存在返回None
        """
        try:
            # 查找匹配的配置文件
            pattern = f"{config_id}_*.yaml"
            matching_files = list(self.configs_dir.glob(pattern))

            if not matching_files:
                logger.warning(f"配置未找到: {config_id}")
                return None

            config_path = matching_files[0]
            with open(config_path, 'r', encoding='utf-8') as f:
                config_data = yaml.safe_load(f)

            # 更新访问时间
            if config_data and '_metadata' in config_data:
                config_data['_metadata']['updated_at'] = datetime.now().isoformat()
                with open(config_path, 'w', encoding='utf-8') as f:
                    yaml.dump(config_data, f, allow_unicode=True, indent=2)

            logger.info(f"配置已加载: {config_path}")
            return config_data

        except Exception as e:
            logger.error(f"加载配置失败: {str(e)}")
            return None

    def delete_config(self, config_id: str) -> bool:
        """
        删除配置

        Args:
            config_id: 配置ID

        Returns:
            bool: 是否成功删除
        """
        try:
            # 查找匹配的配置文件
            pattern = f"{config_id}_*.yaml"
            matching_files = list(self.configs_dir.glob(pattern))

            if not matching_files:
                logger.warning(f"配置未找到，无法删除: {config_id}")
                return False

            config_path = matching_files[0]
            config_path.unlink()

            logger.info(f"配置已删除: {config_path}")
            return True

        except Exception as e:
            logger.error(f"删除配置失败: {str(e)}")
            return False

    def list_configs(self) -> List[Dict[str, Any]]:
        """
        列出所有配置

        Returns:
            List[Dict]: 配置列表
        """
        try:
            configs = []

            # 遍历所有配置文件
            for config_file in self.configs_dir.glob("*.yaml"):
                try:
                    with open(config_file, 'r', encoding='utf-8') as f:
                        config_data = yaml.safe_load(f)

                    if config_data and '_metadata' in config_data:
                        configs.append({
                            'id': config_data['_metadata']['id'],
                            'name': config_data['_metadata']['name'],
                            'provider_type': config_data['_metadata']['provider_type'],
                            'created_at': config_data['_metadata']['created_at'],
                            'updated_at': config_data['_metadata']['updated_at']
                        })
                except Exception as e:
                    logger.warning(f"读取配置文件失败: {config_file}, {str(e)}")
                    continue

            # 按更新时间倒序排列
            configs.sort(key=lambda x: x['updated_at'], reverse=True)

            logger.info(f"找到 {len(configs)} 个配置")
            return configs

        except Exception as e:
            logger.error(f"列出配置失败: {str(e)}")
            return []

    def get_config_path(self, config_id: str) -> Optional[Path]:
        """
        获取配置文件路径

        Args:
            config_id: 配置ID

        Returns:
            Optional[Path]: 配置文件路径，如果不存在返回None
        """
        pattern = f"{config_id}_*.yaml"
        matching_files = list(self.configs_dir.glob(pattern))
        return matching_files[0] if matching_files else None

    def save_active_providers(self, provider_names: List[str]) -> None:
        """
        保存默认的 Provider 列表

        Args:
            provider_names: Provider 名称列表
        """
        try:
            data = {
                'provider_names': provider_names,
                'updated_at': datetime.now().isoformat()
            }
            file_path = self.configs_dir / "active_providers.yaml"
            with open(file_path, 'w', encoding='utf-8') as f:
                yaml.dump(data, f, allow_unicode=True, indent=2)

            logger.info(f"默认 Provider 列表已保存: {provider_names}")
        except Exception as e:
            logger.error(f"保存默认 Provider 列表失败: {str(e)}")
            raise

    def load_active_providers(self) -> List[str]:
        """
        加载默认的 Provider 列表

        Returns:
            List[str]: Provider 名称列表
        """
        try:
            file_path = self.configs_dir / "active_providers.yaml"
            if not file_path.exists():
                return []

            with open(file_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f)

            provider_names = data.get('provider_names', [])
            logger.info(f"默认 Provider 列表已加载: {provider_names}")
            return provider_names
        except Exception as e:
            logger.error(f"加载默认 Provider 列表失败: {str(e)}")
            return []
