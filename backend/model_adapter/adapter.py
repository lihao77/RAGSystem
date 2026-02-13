"""
Model Adapter 主类

统一管理多个 AI Provider，提供统一的访问接口（LLM + Embedding）。
"""

import json
import yaml
import logging
import time
from typing import Any, Dict, List, Optional, Union
from .base import AIProvider, ModelResponse, EmbeddingResponse, AIProviderType
from .providers import OpenAIProvider, DeepSeekProvider, OpenRouterProvider, ModelScopeProvider
from .config_store import ModelAdapterConfigStore

logger = logging.getLogger(__name__)


class ModelAdapter:
    """
    Model Adapter 主类

    统一管理多个 AI Provider，提供统一的访问接口。
    """

    def __init__(self):
        """初始化 Model Adapter"""
        self.providers: Dict[str, AIProvider] = {}  # provider_key -> provider
        self.config_store = ModelAdapterConfigStore()
        # 不再需要 config_ids 映射

        # 初始化时加载已保存的配置
        self._load_saved_configs()

    def _make_provider_key(self, name: str, provider_type: str) -> str:
        """
        生成复合键：{name}_{provider_type}
        
        Args:
            name: Provider 名称
            provider_type: Provider 类型
            
        Returns:
            str: 复合键（如 test_deepseek）
        """
        clean_name = name.lower().replace(" ", "_")
        clean_type = provider_type.lower()
        return f"{clean_name}_{clean_type}"
    
    def _load_saved_configs(self) -> None:
        """
        加载所有已保存的配置（单次 IO）
        """
        try:
            logger.info("[ModelAdapter] 开始加载配置...")

            # 一次性加载所有配置
            all_configs = self.config_store.load_all()

            if not all_configs:
                logger.info("[ModelAdapter] 未找到已保存的配置")
                return

            # 加载每个配置
            for provider_key, config in all_configs.items():
                try:
                    # 注册 Provider（不保存配置，因为已经从文件加载）
                    self.register_provider_from_config(config, save_config=False)
                    logger.info(f"[ModelAdapter] 已加载: {provider_key}")

                except Exception as e:
                    logger.error(f"[ModelAdapter] 加载 {provider_key} 失败: {e}")
                    continue

            logger.info(f"[ModelAdapter] 配置加载完成，共 {len(self.providers)} 个 Provider")

        except Exception as e:
            logger.error(f"[ModelAdapter] 加载配置失败: {e}")

    def register_provider(self, provider: AIProvider) -> None:
        """
        注册 AI Provider（使用复合键）

        Args:
            provider: AI Provider 实例
        """
        provider_key = self._make_provider_key(provider.name, provider.provider_type.value)
        self.providers[provider_key] = provider

        logger.info(f"[ModelAdapter] 已注册: {provider_key}")

    def register_provider_from_config(self, config: Dict[str, Any], save_config: bool = True) -> str:
        """
        从配置注册 AI Provider
        
        Args:
            config: Provider 配置字典
            save_config: 是否保存配置到文件
            
        Returns:
            str: provider_key（复合键）
        """
        name = config.get("name", "")
        provider_type = config.get("provider_type", "").lower()
        api_key = config.get("api_key", "")
        api_endpoint = config.get("api_endpoint", "")
        
        # 获取默认模型
        model = config.get("model", "gpt-3.5-turbo")

        if not all([name, provider_type, api_key]):
            raise ValueError("Provider 配置必须包含 name, provider_type, api_key")
        
        # 生成复合键
        provider_key = self._make_provider_key(name, provider_type)
            
        # 检查是否已存在（仅在保存时检查）
        if provider_key in self.providers and save_config:
            logger.warning(f"[ModelAdapter] Provider {provider_key} 已存在，将被覆盖")
        
        provider_kwargs = {k: v for k, v in config.items() 
                          if k not in ["provider_type", "name", "api_key", "api_endpoint", "models", "model"]}

        provider = None
        if provider_type == "openai":
            provider = OpenAIProvider(
                api_key=api_key,
                model=model,
                name=name,
                api_endpoint=api_endpoint or "https://api.openai.com/v1",
                **provider_kwargs
            )
        elif provider_type == "deepseek":
            provider = DeepSeekProvider(
                api_key=api_key,
                model=model,
                name=name,
                api_endpoint=api_endpoint or "https://api.deepseek.com/v1",
                **provider_kwargs
            )
        elif provider_type == "openrouter":
            provider = OpenRouterProvider(
                api_key=api_key,
                model=model,
                name=name,
                api_endpoint=api_endpoint or "https://openrouter.ai/api/v1",
                **provider_kwargs
            )
        elif provider_type == "modelscope":
            provider = ModelScopeProvider(
                api_key=api_key,
                model=model,
                name=name,
                api_endpoint=api_endpoint or "https://api-inference.modelscope.cn/v1",
                **provider_kwargs
            )
        else:
            raise ValueError(f"不支持的 Provider 类型: {provider_type}")
            
        self.register_provider(provider)
        
        # 保存配置到文件
        if save_config:
            self.config_store.save_provider(provider_key, config)
            logger.info(f"[ModelAdapter] 配置已持久化: {provider_key}")
            
        return provider_key
    
    def add_provider(self, config: Dict[str, Any]) -> str:
        """
        添加 Provider (register_provider_from_config 的别名，方便调用)
        """
        return self.register_provider_from_config(config, save_config=True)

    def remove_provider(self, provider_key: str, delete_config: bool = True) -> None:
        """
        删除 Provider
        
        Args:
            provider_key: 复合键（如 test_deepseek）或简单名称
            delete_config: 是否删除配置文件
        """
        # 尝试直接作为复合键删除
        if provider_key in self.providers:
            # 从内存中删除
            del self.providers[provider_key]
            
            # 删除配置文件
            if delete_config:
                self.config_store.delete_provider(provider_key)

            logger.info(f"[ModelAdapter] 已删除: {provider_key}")
        else:
            raise ValueError(f"Provider 不存在: {provider_key}")

    def get_provider(self, name: str, provider_type: Optional[str] = None) -> AIProvider:
        """
        获取 Provider 实例（支持多种查找方式）
        
        Args:
            name: Provider 名称或复合键
            provider_type: Provider 类型（可选）
            
        Returns:
            AIProvider: Provider 实例
            
        Raises:
            ValueError: Provider 不存在或匹配多个 Provider
        """
        if not name:
            # 如果没有指定 provider，尝试获取第一个
            if self.providers:
                return list(self.providers.values())[0]
            raise ValueError("未指定 Provider 且无可用 Provider")

        # 情况 1：提供了 provider_type，精确查找
        if provider_type:
            key = self._make_provider_key(name, provider_type)
            if key in self.providers:
                return self.providers[key]
            raise ValueError(f"Provider 不存在: {key}")
        
        # 情况 2：name 本身可能是复合键，直接尝试
        if name in self.providers:
            return self.providers[name]
        
        # 情况 3：name 是简单名称，需要模糊匹配（向后兼容）
        clean_name = name.lower().replace(" ", "_")
        prefix = clean_name + "_"
        matching = [(k, p) for k, p in self.providers.items() if k.startswith(prefix)]
        
        if len(matching) == 0:
            raise ValueError(f"Provider 不存在: {name}")
        elif len(matching) == 1:
            return matching[0][1]
        else:
            types = [k.split('_')[-1] for k, _ in matching]
            raise ValueError(
                f"名称 '{name}' 匹配多个 Provider ({', '.join(types)})，"
                f"请指定 provider_type"
            )

    def reload(self) -> bool:
        """
        热重载所有配置（原子性，失败自动回滚）
        
        Returns:
            bool: 是否重新加载成功
        """
        try:
            # 备份当前状态
            backup_providers = self.providers.copy()
            logger.info("[ModelAdapter] 开始热重载...")
            
            # 清空当前状态
            self.providers.clear()
            
            # 重新加载
            self._load_saved_configs()
            
            logger.info(f"[ModelAdapter] 热重载成功，共 {len(self.providers)} 个 Provider")
            return True
            
        except Exception as e:
            logger.error(f"[ModelAdapter] 热重载失败: {e}", exc_info=True)
            
            # 恢复备份
            self.providers = backup_providers
            logger.info("[ModelAdapter] 已恢复到热重载前的状态")
            
            return False
    
    def chat_completion(
        self,
        messages: List[Dict[str, str]],
        provider: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        **kwargs
    ) -> ModelResponse:
        """
        发送对话补全请求

        Args:
            messages: 消息列表
            provider: 使用的 Provider 名称（必需）
            model: 使用的模型（可选，若不传则使用 Provider 默认 Chat 模型）
            ...
        """
        # 验证Provider是否存在
        provider_name = provider.lower().replace(" ", "_")
        if provider_name not in self.providers:
            return ModelResponse(
                error=f"Provider 不存在: {provider}",
                provider=provider_name
            )

        try:
            provider_instance = self.providers[provider_name]

            response = provider_instance.chat_completion(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                **kwargs
            )

            return response

        except Exception as e:
            logger.error(f"Provider {provider_name} 调用异常: {str(e)}")
            return ModelResponse(
                error=f"Provider 调用失败: {str(e)}",
                provider=provider_name
            )

    def chat_completion_stream(
        self,
        messages: List[Dict[str, str]],
        provider: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ):
        """流式对话补全请求"""
        provider_name = provider.lower().replace(" ", "_")
        if provider_name not in self.providers:
            yield {
                "content": "",
                "error": f"Provider 不存在: {provider}",
                "finish_reason": "error"
            }
            return

        try:
            provider_instance = self.providers[provider_name]

            for chunk in provider_instance.chat_completion_stream(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                **kwargs
            ):
                yield chunk

        except Exception as e:
            logger.error(f"Provider {provider_name} 流式调用异常: {str(e)}")
            yield {
                "content": "",
                "error": f"Provider 调用失败: {str(e)}",
                "finish_reason": "error"
            }

    def generate_text(
        self,
        prompt: str,
        provider: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ) -> ModelResponse:
        """生成文本"""
        messages = [{"role": "user", "content": prompt}]
        return self.chat_completion(
            messages=messages,
            provider=provider,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs
        )
        
    def embed(
        self,
        texts: List[str],
        provider: str,
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        **kwargs
    ) -> EmbeddingResponse:
        """
        生成向量 Embedding
        
        Args:
            texts: 文本列表
            provider: Provider 名称（必需）
            model: 模型名称（可选，若不传则使用 Provider 默认 Embedding 模型）
            dimensions: 向量维度
        """
        provider_name = provider.lower().replace(" ", "_")
        if provider_name not in self.providers:
            return EmbeddingResponse(
                embeddings=[],
                error=f"Provider 不存在: {provider}",
                provider=provider_name
            )
            
        try:
            provider_instance = self.providers[provider_name]
            
            return provider_instance.embed(
                texts=texts,
                model=model,
                dimensions=dimensions,
                **kwargs
            )
            
        except Exception as e:
            logger.error(f"Provider {provider_name} Embedding 调用异常: {str(e)}")
            return EmbeddingResponse(
                embeddings=[],
                error=f"Provider 调用失败: {str(e)}",
                provider=provider_name
            )


    def get_available_providers(self) -> List[str]:
        """获取可用的 Provider 列表"""
        return [name for name in self.providers.keys()]

    def get_provider_config(self, provider_key: str) -> Dict[str, Any]:
        """
        获取 Provider 的配置信息
        
        Args:
            provider_key: 复合键（如 test_deepseek）
            
        Returns:
            Dict: Provider 配置
        """
        # 首先尝试从配置文件获取完整配置
        config_from_file = self.config_store.get_provider(provider_key)
        if config_from_file:
            # 添加 key 字段
            config_from_file["key"] = provider_key
            # 添加运行时状态
            provider = self.providers.get(provider_key)
            if provider:
                config_from_file["is_available"] = provider.is_available()
            return config_from_file
        
        # 如果配置文件中没有，从 Provider 实例构建
        provider = self.providers.get(provider_key)
        if not provider:
            raise ValueError(f"Provider 不存在: {provider_key}")
        
        config = {
            "key": provider_key,
            "name": provider.name,
            "provider_type": provider.provider_type.value,
            "model": provider.model,
            "models": [],
            "model_map": provider.model_map,
            "temperature": provider.temperature,
            "max_tokens": provider.max_tokens,
            "timeout": provider.timeout,
            "retry_attempts": provider.retry_attempts,
            "retry_delay": provider.retry_delay,
            "supports_function_calling": provider.supports_function_calling,
            "is_available": provider.is_available()
        }
        if hasattr(provider, 'api_endpoint'):
            config["api_endpoint"] = provider.api_endpoint

        return config

    def get_provider_configs(self) -> List[Dict[str, Any]]:
        """获取所有 Provider 的配置"""
        configs = []
        for provider_key in self.get_available_providers():
            try:
                config = self.get_provider_config(provider_key)
                # 添加 key 字段方便前端识别
                config["key"] = provider_key
                configs.append(config)
            except Exception as e:
                logger.error(f"[ModelAdapter] 获取配置失败: {provider_key}, {e}")
                continue

        return configs

    def save_config(self, config_path: str) -> None:
        """
        保存配置到文件（用于导出）
        
        Args:
            config_path: 导出文件路径
        """
        # 直接导出当前的 providers.yaml 内容
        all_configs = self.config_store.load_all()
        
        with open(config_path, 'w', encoding='utf-8') as f:
            yaml.dump(all_configs, f, allow_unicode=True, indent=2, sort_keys=False)

        logger.info(f"[ModelAdapter] 配置已导出到: {config_path}")

    def load_config(self, config_path: str, api_keys: Dict[str, str] = None) -> None:
        """
        从配置文件加载（用于导入）
        
        Args:
            config_path: 导入文件路径
            api_keys: 可选的 API 密钥字典（provider_key -> api_key）
        """
        with open(config_path, 'r', encoding='utf-8') as f:
            configs = yaml.safe_load(f) or {}

        self.providers.clear()
        
        for provider_key, config in configs.items():
            # 如果提供了 api_keys，更新密钥
            if api_keys and provider_key in api_keys:
                config["api_key"] = api_keys[provider_key]
            
            # 跳过没有 API 密钥的配置
            if not config.get("api_key"):
                logger.warning(f"[ModelAdapter] 跳过 {provider_key}（缺少 API 密钥）")
                continue

            try:
                self.register_provider_from_config(config, save_config=False)
            except Exception as e:
                logger.error(f"[ModelAdapter] 导入 {provider_key} 失败: {e}")

        logger.info(f"[ModelAdapter] 配置已从 {config_path} 导入")


# 全局实例
_default_adapter = None


def get_default_adapter() -> ModelAdapter:
    """获取全局默认的 Model Adapter 实例"""
    global _default_adapter
    if _default_adapter is None:
        _default_adapter = ModelAdapter()
    return _default_adapter


def set_default_adapter(adapter: ModelAdapter) -> None:
    """设置全局默认的 Model Adapter 实例"""
    global _default_adapter
    _default_adapter = adapter
