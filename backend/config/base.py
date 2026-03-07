# -*- coding: utf-8 -*-
"""
配置管理器 - 支持优先级加载和热重载
"""

import os
from pathlib import Path
from typing import Optional, Dict, Any
from dotenv import load_dotenv
from pydantic import ValidationError
from utils.yaml_store import load_yaml_file
from .models import AppConfig


class ConfigManager:
    """配置管理器 - 支持优先级加载和热重载"""

    def __init__(self):
        self._config: Optional[AppConfig] = None
        self._backend_root = Path(__file__).resolve().parent.parent
        self._config_dir = Path(__file__).parent / "yaml"
        self._default_config_path = self._config_dir / "config.default.yaml"
        self._user_config_path = self._config_dir / "config.yaml"
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
            print(f"配置验证失败: {e}")
            raise

    def reload(self):
        """热重载配置"""
        self.load()

    def get_config(self) -> AppConfig:
        """获取当前配置"""
        return self._config

    def _load_yaml(self, path: Path) -> Optional[dict]:
        """加载 YAML 文件"""
        if not path.exists():
            return None
        try:
            return load_yaml_file(path, default_factory=dict)
        except Exception as e:
            print(f"加载配置文件失败 {path}: {e}")
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

        # Neo4j 相关环境变量
        neo4j_uri = os.getenv('NEO4J_URI')
        neo4j_user = os.getenv('NEO4J_USER')
        neo4j_password = os.getenv('NEO4J_PASSWORD')

        if neo4j_uri or neo4j_user or neo4j_password:
            overrides['neo4j'] = {}
            if neo4j_uri:
                overrides['neo4j']['uri'] = neo4j_uri
            if neo4j_user:
                overrides['neo4j']['user'] = neo4j_user
            if neo4j_password:
                overrides['neo4j']['password'] = neo4j_password

        # LLM 相关环境变量
        llm_api_endpoint = os.getenv('LLM_API_ENDPOINT')
        llm_api_key = os.getenv('LLM_API_KEY')
        llm_model_name = os.getenv('LLM_MODEL_NAME')

        if llm_api_endpoint or llm_api_key or llm_model_name:
            overrides['llm'] = {}
            if llm_api_endpoint:
                overrides['llm']['api_endpoint'] = llm_api_endpoint
            if llm_api_key:
                overrides['llm']['api_key'] = llm_api_key
            if llm_model_name:
                overrides['llm']['model_name'] = llm_model_name

        return overrides
