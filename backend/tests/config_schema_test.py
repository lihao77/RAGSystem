# -*- coding: utf-8 -*-
"""配置系统测试（schemas / health_check）

运行方式：在 backend 目录下执行
  pytest tests/config_schema_test.py -v
  python -m pytest tests/config_schema_test.py -v
"""
from pathlib import Path

import pytest

from config.schemas import (
    ConfigValidator,
    ProviderConfig,
    ProvidersConfig,
    VectorizerConfig,
    VectorizersConfig,
)

_BACKEND = Path(__file__).resolve().parent.parent


class TestProviderConfig:
    """Provider 配置测试"""

    def test_load_example_config(self, monkeypatch):
        """示例配置可正常加载（示例中使用 ${ENV} 时需设置环境变量）"""
        path = _BACKEND / "model_adapter" / "configs" / "providers.yaml.example"
        if not path.exists():
            pytest.skip("providers.yaml.example 不存在")
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-example-deepseek")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-example-openrouter")
        config = ProvidersConfig.load(path)
        assert len(config.providers) > 0
        for key, p in config.providers.items():
            assert isinstance(p, ProviderConfig)
            assert p.name
            assert p.provider_type

    def test_invalid_api_key_rejected(self, tmp_path):
        """占位符密钥应被拒绝"""
        bad = tmp_path / "bad.yaml"
        bad.write_text(
            """
x_openai:
  name: x
  provider_type: openai
  api_key: "sk-xxx-placeholder"
  api_endpoint: ""
  model_map: {}
  models: []
""",
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="占位符|无效"):
            ProvidersConfig.load(bad)

    def test_env_var_substitution(self, tmp_path, monkeypatch):
        """环境变量替换"""
        monkeypatch.setenv("TEST_CONFIG_KEY", "sk-real-secret-12345")
        f = tmp_path / "env.yaml"
        f.write_text(
            """
my_test:
  name: my
  provider_type: test
  api_key: "${TEST_CONFIG_KEY}"
  api_endpoint: ""
  model_map: {}
  models: []
""",
            encoding="utf-8",
        )
        config = ProvidersConfig.load(f)
        assert "my_test" in config.providers
        assert config.providers["my_test"].api_key.get_secret_value() == "sk-real-secret-12345"

    def test_empty_providers_file_rejected(self, tmp_path):
        """空或无效 provider 列表应报错"""
        empty = tmp_path / "empty.yaml"
        empty.write_text("{}", encoding="utf-8")
        with pytest.raises(ValueError, match="没有任何有效的 Provider|校验失败"):
            ProvidersConfig.load(empty)


class TestVectorizersConfig:
    """向量化器配置测试"""

    def test_active_vectorizer_must_exist(self):
        """激活的向量化器必须在 vectorizers 中"""
        with pytest.raises(ValueError, match="不在 vectorizers 中"):
            VectorizersConfig(
                active_vectorizer_key="nonexistent",
                vectorizers={
                    "existing": VectorizerConfig(
                        provider_key="p",
                        model_name="m",
                    )
                },
            )

    def test_empty_config_allowed(self):
        """空配置（无激活）可接受"""
        config = VectorizersConfig()
        assert config.active_vectorizer_key is None
        assert len(config.vectorizers) == 0

    def test_load_missing_file_returns_empty(self, tmp_path):
        """文件不存在时 load 返回空配置"""
        config = VectorizersConfig.load(tmp_path / "nonexistent.yaml")
        assert config.active_vectorizer_key is None
        assert config.vectorizers == {}


class TestConfigValidator:
    """跨配置一致性校验测试"""

    def test_validate_returns_list(self):
        """validate() 返回 list，且不抛错（使用当前环境配置）"""
        validator = ConfigValidator()
        providers_path = _BACKEND / "model_adapter" / "configs" / "providers.yaml"
        if not providers_path.exists():
            pytest.skip("providers.yaml 不存在，跳过一致性校验")
        validator.load_all(
            providers_path=providers_path,
            vectorizers_path=_BACKEND / "vector_store" / "config" / "vectorizers.yaml",
        )
        warnings = validator.validate()
        assert isinstance(warnings, list)
