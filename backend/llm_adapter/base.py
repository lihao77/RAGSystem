"""
LLM Provider 抽象基类和数据模型
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field
from enum import Enum
import time


class LLMProviderType(str, Enum):
    """LLM Provider 类型枚举"""
    OPENAI = "openai"
    DEEPSEEK = "deepseek"
    OPENROUTER = "openrouter"
    CUSTOM = "custom"


class LLMResponse(BaseModel):
    """LLM 响应数据模型"""
    content: Optional[str] = Field(None, description="响应内容")
    finish_reason: Optional[str] = Field(None, description="完成原因")
    usage: Optional[Dict[str, int]] = Field(None, description="Token 使用情况")
    model: Optional[str] = Field(None, description="使用的模型")
    provider: Optional[str] = Field(None, description="Provider 名称")
    cost: Optional[float] = Field(None, description="请求成本（美元）")
    latency: Optional[float] = Field(None, description="请求延迟（秒）")
    tool_calls: Optional[List[Dict[str, Any]]] = Field(None, description="工具调用")
    error: Optional[str] = Field(None, description="错误信息")


class LLMProvider(ABC):
    """
    LLM Provider 抽象基类

    所有 LLM Provider 都必须实现此类中定义的抽象方法。
    """

    def __init__(self, name: str, api_key: str, api_endpoint: str, **kwargs):
        """
        初始化 LLM Provider

        Args:
            name: Provider 名称
            api_key: API 密钥
            api_endpoint: API 端点
            **kwargs: 其他配置参数
        """
        self.name = name
        self.api_key = api_key
        self.api_endpoint = api_endpoint.rstrip("/")
        self.model = kwargs.get("model", "")
        self.temperature = kwargs.get("temperature", 0.7)
        self.max_tokens = kwargs.get("max_tokens", 4096)
        self.timeout = kwargs.get("timeout", 30)
        self.retry_attempts = kwargs.get("retry_attempts", 3)
        self.retry_delay = kwargs.get("retry_delay", 1.0)
        self.supports_function_calling = kwargs.get("supports_function_calling", False)

    @abstractmethod
    def chat_completion(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """
        发送对话补全请求

        Args:
            messages: 消息列表，格式为 [{"role": "user", "content": "..."}]
            model: 使用的模型（如果为 None 则使用默认模型）
            temperature: 温度参数（如果为 None 则使用默认值）
            max_tokens: 最大 token 数（如果为 None 则使用默认值）
            tools: 工具定义列表
            tool_choice: 工具选择策略
            **kwargs: 其他参数

        Returns:
            LLMResponse: LLM 响应对象
        """
        pass

    @abstractmethod
    def generate_text(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ) -> LLMResponse:
        """
        发送文本生成请求

        Args:
            prompt: 提示文本
            model: 使用的模型
            temperature: 温度参数
            max_tokens: 最大 token 数
            **kwargs: 其他参数

        Returns:
            LLMResponse: LLM 响应对象
        """
        pass

    @property
    def provider_type(self) -> LLMProviderType:
        """获取 Provider 类型"""
        return self._get_provider_type()

    @abstractmethod
    def _get_provider_type(self) -> LLMProviderType:
        """抽象方法：返回 Provider 类型"""
        pass

    @abstractmethod
    def get_model_list(self) -> List[str]:
        """
        获取支持的模型列表

        Returns:
            List[str]: 模型名称列表
        """
        pass

    @abstractmethod
    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        """
        计算 API 调用成本

        Args:
            input_tokens: 输入 token 数
            output_tokens: 输出 token 数
            model: 使用的模型

        Returns:
            float: 成本（美元）
        """
        pass

    @abstractmethod
    def is_available(self) -> bool:
        """
        检查 Provider 是否可用

        Returns:
            bool: 是否可用
        """
        pass

    def _validate_response(self, response: Dict[str, Any]) -> None:
        """
        验证响应数据

        Args:
            response: 响应字典

        Raises:
            ValueError: 如果响应无效
        """
        if not isinstance(response, dict):
            raise ValueError("响应必须是字典类型")

    def _before_request(self) -> float:
        """
        请求前回调，返回当前时间戳

        Returns:
            float: 当前时间戳
        """
        return time.time()

    def _after_request(self, start_time: float) -> float:
        """
        请求后回调，计算延迟

        Args:
            start_time: 开始时间戳

        Returns:
            float: 请求延迟（秒）
        """
        return time.time() - start_time

    def __str__(self) -> str:
        return f"{self.__class__.__name__}(name='{self.name}', model='{self.model}')"

    def __repr__(self) -> str:
        return self.__str__()
