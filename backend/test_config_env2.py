# -*- coding: utf-8 -*-
"""
测试配置系统环境变量覆盖 - 直接测试 base.ConfigManager
"""

import os
import sys

# 设置测试环境变量
os.environ['NEO4J_PASSWORD'] = 'test_password_from_env2'
os.environ['LLM_API_KEY'] = 'sk-test-key-from-env2'
os.environ['GEOCODING_API_KEY'] = 'geo-key-from-env2'

# 添加当前目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config.base import ConfigManager
from config import get_config

def test_config_with_env():
    """测试环境变量覆盖配置"""
    print("=" * 60)
    print("测试配置系统 - 环境变量覆盖 (使用 ConfigManager)")
    print("=" * 60)

    # 创建新的配置管理器实例（会读取当前环境变量）
    manager = ConfigManager()
    config = manager.get_config()

    print("\n1. Neo4j 配置:")
    print(f"   URI: {config.neo4j.uri}")
    print(f"   User: {config.neo4j.user}")
    print(f"   Password: {config.neo4j.password}")

    print("\n2. LLM 配置:")
    print(f"   API Endpoint: {config.llm.api_endpoint}")
    print(f"   API Key: {config.llm.api_key}")

    print("\n3. 地理编码配置:")
    print(f"   Service: {config.geocoding.service}")
    print(f"   API Key: {config.geocoding.api_key}")

    # 验证环境变量是否生效
    if config.neo4j.password == 'test_password_from_env2':
        print("\n✓ Neo4j 密码环境变量生效！")
    else:
        print(f"\n✗ Neo4j 密码环境变量未生效: {config.neo4j.password}")

    if config.llm.api_key == 'sk-test-key-from-env2':
        print("✓ LLM API Key 环境变量生效！")
    else:
        print(f"✗ LLM API Key 环境变量未生效: {config.llm.api_key}")

    if config.geocoding.api_key == 'geo-key-from-env2':
        print("✓ Geocoding API Key 环境变量生效！")
    else:
        print(f"✗ Geocoding API Key 环境变量未生效: {config.geocoding.api_key}")

    print("\n" + "=" * 60)

if __name__ == "__main__":
    test_config_with_env()
