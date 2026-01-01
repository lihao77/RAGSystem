"""
LLM Adapter 主类

提供统一的接口来管理多个 LLM Provider，支持负载均衡、
故障转移、请求路由等高级特性。
"""

import json
import logging
import random
import time
import uuid
from typing import Any, Dict, List, Optional, Union
from collections import defaultdict
from .base import LLMProvider, LLMResponse, LLMProviderType
from .providers import OpenAIProvider, DeepSeekProvider, OpenRouterProvider
from .config_store import LLMAdapterConfigStore

logger = logging.getLogger(__name__)


class LLMAdapter:
    """
    LLM Adapter 主类

    统一管理多个 LLM Provider，提供以下功能：
    - 多 Provider 管理
    - 智能路由
    - 负载均衡
    - 故障转移
    - 请求统计
    - 成本追踪
    """

    def __init__(self):
        """初始化 LLM Adapter"""
        self.providers: Dict[str, LLMProvider] = {}
        self.active_provider: Optional[str] = None
        self.request_stats = defaultdict(lambda: {
            "total_requests": 0,
            "successful_requests": 0,
            "failed_requests": 0,
            "total_latency": 0.0,
            "total_cost": 0.0
        })
        self.load_balancer = "round_robin"
        self._last_provider_index = 0
        self.config_store = LLMAdapterConfigStore()
        self.config_ids: Dict[str, str] = {}  # provider_name -> config_id 映射

        # 初始化时加载已保存的配置
        self._load_saved_configs()

    def _load_saved_configs(self) -> None:
        """
        加载所有已保存的配置
        """
        try:
            logger.info("开始加载已保存的 LLM Adapter 配置...")

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

    def register_provider(self, provider: LLMProvider) -> None:
        """
        注册 LLM Provider

        Args:
            provider: LLM Provider 实例
        """
        provider_name = provider.name.lower().replace(" ", "_")
        self.providers[provider_name] = provider

        if not self.active_provider:
            self.active_provider = provider_name

        logger.info(f"已注册 Provider: {provider_name}")

    def register_provider_from_config(self, config: Dict[str, Any], save_config: bool = True, config_id: Optional[str] = None) -> str:
        """
        从配置注册 LLM Provider

        Args:
            config: Provider 配置字典
            save_config: 是否保存配置到文件
            config_id: 配置ID（如果为None则生成新的）

        Returns:
            str: 配置ID
        """
        provider_type = config.get("provider_type", "").lower()
        name = config.get("name", "")
        api_key = config.get("api_key", "")
        api_endpoint = config.get("api_endpoint", "")
        model = config.get("model", "")

        if not all([name, api_key, model]):
            raise ValueError("Provider 配置必须包含 name, api_key 和 model")

        provider_kwargs = {k: v for k, v in config.items()
                          if k not in ["provider_type", "name", "api_key", "api_endpoint", "model"]}

        provider = None
        if provider_type == "openai":
            provider = OpenAIProvider(
                api_key=api_key,
                model=model,
                api_endpoint=api_endpoint or "https://api.openai.com/v1",
                **provider_kwargs
            )
        elif provider_type == "deepseek":
            provider = DeepSeekProvider(
                api_key=api_key,
                model=model,
                api_endpoint=api_endpoint or "https://api.deepseek.com/v1",
                **provider_kwargs
            )
        elif provider_type == "openrouter":
            provider = OpenRouterProvider(
                api_key=api_key,
                model=model,
                api_endpoint=api_endpoint or "https://openrouter.ai/api/v1",
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

    def _generate_config_id(self) -> str:
        """
        生成配置ID

        Returns:
            str: UUID前8位
        """
        return str(uuid.uuid4())[:8]

    def remove_provider(self, provider_name: str, delete_config: bool = True) -> None:
        """
        删除 Provider

        Args:
            provider_name: Provider 名称
            delete_config: 是否删除配置文件
        """
        provider_name = provider_name.lower().replace(" ", "_")
        if provider_name in self.providers:
            # 删除配置文件
            if delete_config and provider_name in self.config_ids:
                config_id = self.config_ids[provider_name]
                self.config_store.delete_config(config_id)
                del self.config_ids[provider_name]

            # 从内存中删除
            del self.providers[provider_name]
            if self.active_provider == provider_name:
                self.active_provider = next(iter(self.providers.keys())) if self.providers else None
            logger.info(f"已删除 Provider: {provider_name}")
        else:
            raise ValueError(f"Provider 不存在: {provider_name}")

    def get_provider(self, provider_name: Optional[str] = None) -> LLMProvider:
        """
        获取 Provider 实例

        Args:
            provider_name: Provider 名称（如果为 None 则使用 active_provider）

        Returns:
            LLMProvider: Provider 实例
        """
        if not provider_name:
            provider_name = self.active_provider

        if not provider_name or provider_name not in self.providers:
            raise ValueError(f"Provider 不存在: {provider_name}")

        return self.providers[provider_name]

    def set_active_provider(self, provider_name: str) -> None:
        """
        设置活动 Provider

        Args:
            provider_name: Provider 名称
        """
        provider_name = provider_name.lower().replace(" ", "_")
        if provider_name not in self.providers:
            raise ValueError(f"Provider 不存在: {provider_name}")

        self.active_provider = provider_name
        logger.info(f"设置活动 Provider: {provider_name}")

    def _select_provider_round_robin(self, excluded: List[str] = None) -> str:
        """
        轮询选择 Provider

        Args:
            excluded: 排除的 Provider 列表

        Returns:
            str: 选中的 Provider 名称
        """
        available = [name for name in self.providers.keys()
                    if not excluded or name not in excluded]

        if not available:
            raise ValueError("没有可用的 Provider")

        provider_name = available[self._last_provider_index % len(available)]
        self._last_provider_index += 1

        return provider_name

    def _select_provider_random(self, excluded: List[str] = None) -> str:
        """
        随机选择 Provider

        Args:
            excluded: 排除的 Provider 列表

        Returns:
            str: 选中的 Provider 名称
        """
        available = [name for name in self.providers.keys()
                    if not excluded or name not in excluded]

        if not available:
            raise ValueError("没有可用的 Provider")

        return random.choice(available)

    def _select_provider_by_health(self, excluded: List[str] = None) -> str:
        """
        基于健康状态选择 Provider（成功率最高的）

        Args:
            excluded: 排除的 Provider 列表

        Returns:
            str: 选中的 Provider 名称
        """
        best_provider = None
        best_success_rate = 0

        for provider_name in self.providers.keys():
            if excluded and provider_name in excluded:
                continue

            stats = self.request_stats[provider_name]
            if stats["total_requests"] > 0:
                success_rate = stats["successful_requests"] / stats["total_requests"]
                if success_rate > best_success_rate:
                    best_success_rate = success_rate
                    best_provider = provider_name

        if not best_provider:
            # 如果没有足够的数据，使用轮询
            best_provider = self._select_provider_round_robin(excluded)

        return best_provider

    def _select_provider(self, excluded: List[str] = None) -> str:
        """
        选择 Provider

        Args:
            excluded: 排除的 Provider 列表

        Returns:
            str: 选中的 Provider 名称
        """
        if self.load_balancer == "round_robin":
            return self._select_provider_round_robin(excluded)
        elif self.load_balancer == "random":
            return self._select_provider_random(excluded)
        elif self.load_balancer == "health":
            return self._select_provider_by_health(excluded)
        else:
            raise ValueError(f"不支持的负载均衡策略: {self.load_balancer}")

    def chat_completion(
        self,
        messages: List[Dict[str, str]],
        provider: Optional[str] = None,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        enable_fallback: bool = True,
        **kwargs
    ) -> LLMResponse:
        """
        发送对话补全请求

        Args:
            messages: 消息列表
            provider: 使用的 Provider（如果为 None 则使用 active 或自动选择）
            model: 使用的模型
            temperature: 温度参数
            max_tokens: 最大 token 数
            tools: 工具定义
            tool_choice: 工具选择
            enable_fallback: 是否启用故障转移
            **kwargs: 其他参数

        Returns:
            LLMResponse: 响应对象
        """
        failed_providers = []
        provider_name = provider.lower().replace(" ", "_") if provider else None

        # 如果指定了 provider 但不存在，则报错
        if provider_name and provider_name not in self.providers:
            raise ValueError(f"Provider 不存在: {provider_name}")

        # 选择 provider
        if not provider_name:
            provider_name = self._select_provider()

        attempts = 0
        max_attempts = len(self.providers) if enable_fallback else 1

        while attempts < max_attempts:
            attempts += 1

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

                self._update_stats(provider_name, response)

                if not response.error:
                    return response

                failed_providers.append(provider_name)
                logger.warning(f"Provider {provider_name} 请求失败: {response.error}")

                if not enable_fallback:
                    return response

                # 选择下一个 provider
                provider_name = self._select_provider(failed_providers)

            except Exception as e:
                logger.error(f"Provider {provider_name} 调用异常: {str(e)}")
                failed_providers.append(provider_name)

                if not enable_fallback or len(failed_providers) >= len(self.providers):
                    return LLMResponse(
                        error=f"所有 Provider 都调用失败: {str(e)}",
                        provider=provider_name
                    )

                provider_name = self._select_provider(failed_providers)

        return LLMResponse(
            error=f"所有 Provider 都调用失败，已尝试: {', '.join(failed_providers)}",
            provider=provider_name
        )

    def generate_text(
        self,
        prompt: str,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        enable_fallback: bool = True,
        **kwargs
    ) -> LLMResponse:
        """
        生成文本

        Args:
            prompt: 提示文本
            provider: Provider 名称
            model: 模型名称
            temperature: 温度参数
            max_tokens: 最大 token 数
            enable_fallback: 是否启用故障转移
            **kwargs: 其他参数

        Returns:
            LLMResponse: 响应对象
        """
        messages = [{"role": "user", "content": prompt}]
        return self.chat_completion(
            messages=messages,
            provider=provider,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            enable_fallback=enable_fallback,
            **kwargs
        )

    def _update_stats(self, provider_name: str, response: LLMResponse) -> None:
        """
        更新统计信息

        Args:
            provider_name: Provider 名称
            response: 响应对象
        """
        stats = self.request_stats[provider_name]
        stats["total_requests"] += 1

        if response.error:
            stats["failed_requests"] += 1
        else:
            stats["successful_requests"] += 1

        if response.latency:
            stats["total_latency"] += response.latency

        if response.cost:
            stats["total_cost"] += response.cost

    def get_stats(self, provider_name: Optional[str] = None) -> Dict[str, Any]:
        """
        获取统计信息

        Args:
            provider_name: Provider 名称（如果为 None 则返回所有）

        Returns:
            Dict: 统计信息
        """
        if provider_name:
            provider_name = provider_name.lower().replace(" ", "_")
            if provider_name not in self.request_stats:
                return {}

            stats = self.request_stats[provider_name].copy()
            if stats["total_requests"] > 0:
                stats["success_rate"] = stats["successful_requests"] / stats["total_requests"]
                stats["avg_latency"] = stats["total_latency"] / stats["successful_requests"]
            else:
                stats["success_rate"] = 0
                stats["avg_latency"] = 0

            return stats

        all_stats = {}
        for name in self.providers.keys():
            all_stats[name] = self.get_stats(name)

        return all_stats

    def get_available_providers(self) -> List[str]:
        """
        获取可用的 Provider 列表

        Returns:
            List[str]: Provider 名称列表
        """
        return [name for name in self.providers.keys()]

    def get_provider_configs(self) -> List[Dict[str, Any]]:
        """
        获取所有 Provider 的配置

        Returns:
            List[Dict]: Provider 配置列表
        """
        configs = []
        for provider in self.providers.values():
            config = {
                "name": provider.name,
                "provider_type": provider.provider_type.value,
                "model": provider.model,
                "supports_function_calling": provider.supports_function_calling,
                "is_available": provider.is_available()
            }
            configs.append(config)

        return configs

    def set_load_balancer(self, strategy: str) -> None:
        """
        设置负载均衡策略

        Args:
            strategy: 策略名称（round_robin, random, health）
        """
        if strategy not in ["round_robin", "random", "health"]:
            raise ValueError(f"不支持的负载均衡策略: {strategy}")

        self.load_balancer = strategy
        logger.info(f"设置负载均衡策略: {strategy}")

    def save_config(self, config_path: str) -> None:
        """
        保存配置到文件

        Args:
            config_path: 配置文件路径
        """
        config = {
            "active_provider": self.active_provider,
            "load_balancer": self.load_balancer,
            "providers": {}
        }

        for name, provider in self.providers.items():
            provider_config = {
                "provider_type": provider.provider_type.value,
                "api_endpoint": provider.api_endpoint,
                "model": provider.model,
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
        """
        从配置文件加载

        Args:
            config_path: 配置文件路径
            api_keys: API 密钥字典（provider_name -> api_key）
        """
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)

        self.load_balancer = config.get("load_balancer", "round_robin")
        self.active_provider = config.get("active_provider")

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


def get_default_adapter() -> LLMAdapter:
    """
    获取全局默认的 LLM Adapter 实例

    Returns:
        LLMAdapter: LLM Adapter 实例
    """
    global _default_adapter
    if _default_adapter is None:
        _default_adapter = LLMAdapter()
    return _default_adapter


def set_default_adapter(adapter: LLMAdapter) -> None:
    """
    设置全局默认的 LLM Adapter 实例

    Args:
        adapter: LLM Adapter 实例
    """
    global _default_adapter
    _default_adapter = adapter
