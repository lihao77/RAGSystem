# -*- coding: utf-8 -*-
"""
统一配置校验模型

用于启动时健康检查与跨配置一致性校验，与当前实现（providers 复合键、api_endpoint、vectorizers 结构）一致。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Literal

from pydantic import BaseModel, Field, SecretStr, field_validator, model_validator
from utils.yaml_store import load_yaml_file


# ============ Model Adapter 配置 ============


class ProviderConfig(BaseModel):
    """单个 LLM/Embedding Provider 配置（与 providers.yaml 一致）"""
    model_config = {"protected_namespaces": ()}

    name: str
    provider_type: str
    api_key: SecretStr
    api_endpoint: Optional[str] = ""
    model_map: dict = Field(default_factory=dict)
    models: list = Field(default_factory=list)

    @field_validator("api_key", mode="before")
    @classmethod
    def validate_api_key(cls, v):
        """支持环境变量占位符 ${VAR}，拒绝明显占位符"""
        if isinstance(v, SecretStr):
            raw = v.get_secret_value()
        else:
            raw = str(v) if v else ""
        if not raw:
            raise ValueError("api_key 不能为空，请配置真实密钥或使用 ${ENV_VAR}")
        if raw.startswith("${") and raw.endswith("}"):
            env_var = raw[2:-1].strip()
            if not os.getenv(env_var):
                raise ValueError(
                    f"环境变量 {env_var} 未设置。请运行: export {env_var}=your-api-key"
                )
            return SecretStr(os.getenv(env_var))
        if raw.startswith(("sk-xxx", "your-", "placeholder")) or "your-" in raw.lower():
            raise ValueError(
                "API 密钥看起来是占位符，请替换为真实密钥或使用环境变量 ${ENV_VAR}"
            )
        return SecretStr(raw) if not isinstance(v, SecretStr) else v


class ProvidersConfig(BaseModel):
    """providers.yaml 结构：顶层为复合键 -> Provider 配置"""
    providers: dict[str, ProviderConfig] = Field(default_factory=dict)

    @classmethod
    def load(cls, path: Path | str) -> "ProvidersConfig":
        """从 YAML 加载并校验（顶层键即复合键）"""
        path = Path(path)
        if not path.exists():
            example = path.parent / f"{path.name}.example"
            raise FileNotFoundError(
                f"配置文件不存在: {path}\n"
                f"请运行: cp {example} {path}\n"
                f"然后编辑 {path} 填入真实 API 密钥"
            )
        raw = load_yaml_file(path, default_factory=dict) or {}
        validated = {}
        errors = []
        for key, value in raw.items():
            if not isinstance(value, dict):
                continue
            try:
                validated[key] = ProviderConfig(**value)
            except Exception as e:
                errors.append(f"  - Provider '{key}': {e}")
        if errors:
            raise ValueError(f"配置文件 {path} 校验失败：\n" + "\n".join(errors))
        if not validated:
            raise ValueError(f"配置文件 {path} 中没有任何有效的 Provider 配置")
        return cls(providers=validated)


# ============ 向量化器配置 ============


class VectorizerConfig(BaseModel):
    """单个向量化器配置（与 vectorizers.yaml 一致，无 dimension 字段）"""
    provider_key: str
    model_name: str
    distance_metric: str = "cosine"
    created_at: Optional[str] = None


class VectorizersConfig(BaseModel):
    """vectorizers.yaml 顶层结构"""
    active_vectorizer_key: Optional[str] = None
    vectorizers: dict[str, VectorizerConfig] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_active_in_list(self):
        if self.active_vectorizer_key and self.vectorizers:
            if self.active_vectorizer_key not in self.vectorizers:
                raise ValueError(
                    f"active_vectorizer_key '{self.active_vectorizer_key}' 不在 vectorizers 中。"
                    f"可用: {list(self.vectorizers.keys())}"
                )
        return self

    @classmethod
    def load(cls, path: Path | str) -> "VectorizersConfig":
        """加载配置，文件不存在时返回空配置"""
        path = Path(path)
        if not path.exists():
            return cls()
        raw = load_yaml_file(path, default_factory=dict) or {}
        return cls(
            active_vectorizer_key=raw.get("active_vectorizer_key"),
            vectorizers={
                k: VectorizerConfig(**v)
                for k, v in (raw.get("vectorizers") or {}).items()
                if isinstance(v, dict)
            },
        )


# ============ 配置一致性校验 ============


class ConfigValidator:
    """跨配置一致性校验（providers / vectorizers / agents）"""

    def __init__(self) -> None:
        self.providers: Optional[ProvidersConfig] = None
        self.vectorizers: Optional[VectorizersConfig] = None
        self.agents: Optional[dict] = None

    def load_all(
        self,
        providers_path: Path | str,
        vectorizers_path: Path | str,
    ) -> None:
        """加载所有相关配置"""
        self.providers = ProvidersConfig.load(providers_path)
        self.vectorizers = VectorizersConfig.load(vectorizers_path)
        try:
            from agents.config import AgentConfigManager
            mgr = AgentConfigManager()
            self.agents = getattr(mgr, "_configs", {}) or {}
        except Exception:
            self.agents = {}

    def validate(self) -> list[str]:
        """执行跨配置校验，返回警告列表（不阻止启动）"""
        warnings: list[str] = []
        if not self.providers or not self.providers.providers:
            return warnings
        provider_keys = set(self.providers.providers.keys())

        if self.vectorizers and self.vectorizers.vectorizers:
            for vec_key, vec_cfg in self.vectorizers.vectorizers.items():
                if vec_cfg.provider_key not in provider_keys:
                    warnings.append(
                        f"向量化器 '{vec_key}' 引用了不存在的 provider: '{vec_cfg.provider_key}'"
                    )

        if self.agents:
            for agent_name, agent_cfg in self.agents.items():
                llm = getattr(agent_cfg, "llm", None)
                if not llm:
                    continue
                p, pt = getattr(llm, "provider", None), getattr(llm, "provider_type", None)
                if p is not None and pt is None:
                    warnings.append(
                        f"智能体 '{agent_name}' 已设置 llm.provider 但未设置 llm.provider_type，请补全 provider_type 以便正确解析复合键"
                    )
                    continue
                if p is None or pt is None:
                    continue
                composite = f"{p}_{pt}"
                if composite not in provider_keys:
                    warnings.append(
                        f"智能体 '{agent_name}' 引用的 provider 不存在: '{composite}'"
                    )

        used = set()
        if self.vectorizers:
            for v in self.vectorizers.vectorizers.values():
                used.add(v.provider_key)
        if self.agents:
            for agent_cfg in self.agents.values():
                llm = getattr(agent_cfg, "llm", None)
                if llm and getattr(llm, "provider", None) and getattr(llm, "provider_type", None):
                    used.add(f"{llm.provider}_{llm.provider_type}")
        # 系统配置（config.yaml）中的 llm / embedding 也算作已使用
        try:
            from config import get_config
            cfg = get_config()
            if cfg.llm and getattr(cfg.llm, "provider", None) and getattr(cfg.llm, "provider_type", None):
                used.add(f"{cfg.llm.provider}_{cfg.llm.provider_type}")
            if cfg.embedding and getattr(cfg.embedding, "provider", None) and getattr(cfg.embedding, "provider_type", None):
                used.add(f"{cfg.embedding.provider}_{cfg.embedding.provider_type}")
        except Exception:
            pass
        unused = provider_keys - used
        if unused:
            warnings.append(
                f"以下 providers 已配置但未被任何「智能体」或「向量化器」引用: {', '.join(sorted(unused))}。"
                f"若不需要可忽略；若要用到，请在智能体配置中指定 llm.provider/provider_type，或在向量库中添加对应向量化器。"
            )

        return warnings
