"""
Model Adapter 主类

统一管理多个 AI Provider，提供统一的访问接口（LLM + Embedding）。
"""

import json
import logging
import time
import uuid
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
        self.providers: Dict[str, AIProvider] = {}
        self.config_store = ModelAdapterConfigStore()
        self.config_ids: Dict[str, str] = {}  # provider_name -> config_id 映射

        # 初始化时加载已保存的配置
        self._load_saved_configs()

    def _load_saved_configs(self) -> None:
        """
        加载所有已保存的配置
        """
        try:
            logger.info("开始加载已保存的 Model Adapter 配置...")

            # 获取所有配置列表
            config_list = self.config_store.list_configs()

            if not config_list:
                logger.info("未找到已保存的配置")
                return

            # 加载每个配置
            for config_info in config_list:
                config_id = config_info['id']
                config_data = self.config_store.load_config(config_id)

                if not config_data or 'config' not in config_data:
                    logger.warning(f"配置加载失败: {config_id}")
                    continue

                config = config_data['config']

                try:
                    # 注册 Provider（不保存配置，因为已经从文件加载）
                    self.register_provider_from_config(config, save_config=False, config_id=config_id)

                    # 记录配置ID映射
                    provider_name = config.get('name', '').lower().replace(' ', '_')
                    if provider_name:
                        self.config_ids[provider_name] = config_id

                    logger.info(f"配置加载成功: {config.get('name', 'unnamed')} ({config_id})")

                except Exception as e:
                    logger.error(f"注册 Provider 失败: {config.get('name', 'unnamed')}, {str(e)}")
                    continue

            logger.info(f"配置加载完成，共加载 {len(self.providers)} 个 Provider")

        except Exception as e:
            logger.error(f"加载保存的配置失败: {str(e)}")

    def register_provider(self, provider: AIProvider) -> None:
        """
        注册 AI Provider

        Args:
            provider: AI Provider 实例
        """
        provider_name = provider.name.lower().replace(" ", "_")
        self.providers[provider_name] = provider

        logger.info(f"已注册 Provider: {provider_name}")

    def register_provider_from_config(self, config: Dict[str, Any], save_config: bool = True, config_id: Optional[str] = None) -> str:
        """
        从配置注册 AI Provider
        
        Args:
            config: Provider 配置字典
            save_config: 是否保存配置到文件
            config_id: 配置ID（如果为None则生成新的）
            
        Returns:
            str: 配置ID
        """
        name = config.get("name", "")
        provider_type = config.get("provider_type", "").lower()
        api_key = config.get("api_key", "")
        api_endpoint = config.get("api_endpoint", "")
        
        # 获取默认模型
        model = config.get("model", "gpt-3.5-turbo")

        if not all([name, api_key]):
            raise ValueError("Provider 配置必须包含 name, api_key")
            
        # 检查同名 Provider 是否已存在
        provider_name = name.lower().replace(" ", "_")
        if provider_name in self.providers and save_config: # 仅在手动添加时检查，加载时覆盖
             # 注意：如果是更新现有配置，应该允许覆盖
             # 这里简化处理：如果是全新添加且名字冲突，则报错
             pass
             # if provider_name in self.providers:
             #    raise ValueError(f"Provider '{name}' 已存在，请使用不同的名称")
        
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
            config_id = self.config_store.save_config(config, config_id=config_id)
            provider_name = provider.name.lower().replace(" ", "_")
            self.config_ids[provider_name] = config_id
            logger.info(f"配置已持久化: {provider_name} -> {config_id}")
            return config_id
            
        return config_id or self._generate_config_id()
    
    def add_provider(self, config: Dict[str, Any]) -> str:
        """
        添加 Provider (register_provider_from_config 的别名，方便调用)
        """
        return self.register_provider_from_config(config, save_config=True)

    def _generate_config_id(self) -> str:
        return str(uuid.uuid4())[:8]

    def remove_provider(self, provider_name: str, delete_config: bool = True) -> None:
        """删除 Provider"""
        provider_name = provider_name.lower().replace(" ", "_")
        if provider_name in self.providers:
            # 删除配置文件
            if delete_config and provider_name in self.config_ids:
                config_id = self.config_ids[provider_name]
                self.config_store.delete_config(config_id)
                del self.config_ids[provider_name]

            # 从内存中删除
            del self.providers[provider_name]

            logger.info(f"已删除 Provider: {provider_name}")
        else:
            raise ValueError(f"Provider 不存在: {provider_name}")

    def get_provider(self, provider_name: str) -> AIProvider:
        """获取 Provider 实例"""
        if not provider_name:
             # 如果没有指定 provider，尝试获取第一个
             # 或者应该有一个 default provider 的概念
             if self.providers:
                 return list(self.providers.values())[0]
             raise ValueError("未指定 Provider 且无可用 Provider")

        provider_name = provider_name.lower().replace(" ", "_")
        if provider_name not in self.providers:
            raise ValueError(f"Provider 不存在: {provider_name}")

        return self.providers[provider_name]

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

    def get_provider_config(self, provider_name: str) -> Dict[str, Any]:
        """获取指定 Provider 的配置"""
        provider = self.get_provider(provider_name)

        # 从配置文件加载原始配置
        name = provider_name.lower().replace(" ", "_")
        config_id = self.config_ids.get(name, '')
        original_config = {}
        if config_id:
            config_data = self.config_store.load_config(config_id)
            if config_data and 'config' in config_data:
                original_config = config_data['config']

        config = {
            "name": provider.name,
            "provider_type": provider.provider_type.value,
            # "models": original_config.get('models', []), # 移除 models
            "model": provider.model,
            "model_map": provider.model_map, # 返回 model_map
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
        for name in self.get_available_providers():
            try:
                config = self.get_provider_config(name)
                configs.append(config)
            except Exception as e:
                logger.error(f"获取 Provider {name} 配置失败: {str(e)}")
                continue

        return configs

    def save_config(self, config_path: str) -> None:
        """保存配置到文件（用于导出）"""
        config = {
            "providers": {}
        }

        for name, provider in self.providers.items():
            config_id = self.config_ids.get(name, '')
            original_config = {}
            if config_id:
                config_data = self.config_store.load_config(config_id)
                if config_data and 'config' in config_data:
                    original_config = config_data['config']

            provider_config = {
                "provider_type": provider.provider_type.value,
                "api_endpoint": provider.api_endpoint,
                # "models": original_config.get('models', []),
                "model": provider.model,
                "model_map": provider.model_map,
                "temperature": provider.temperature,
                "max_tokens": provider.max_tokens,
                "timeout": provider.timeout,
                "retry_attempts": provider.retry_attempts,
                "retry_delay": provider.retry_delay,
                "supports_function_calling": provider.supports_function_calling
            }
            config["providers"][name] = provider_config

        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)

        logger.info(f"配置已保存到: {config_path}")

    def load_config(self, config_path: str, api_keys: Dict[str, str] = None) -> None:
        """从配置文件加载（用于导入）"""
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)

        self.providers.clear()
        for name, provider_config in config.get("providers", {}).items():
            if api_keys and name not in api_keys:
                logger.warning(f"跳过 Provider {name}（没有提供 API 密钥）")
                continue

            provider_config["api_key"] = api_keys.get(name, "")
            provider_config["name"] = name

            try:
                self.register_provider_from_config(provider_config)
            except Exception as e:
                logger.error(f"注册 Provider {name} 失败: {str(e)}")

        logger.info(f"配置已从 {config_path} 加载")


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
