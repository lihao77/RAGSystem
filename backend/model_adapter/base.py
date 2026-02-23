"""
AI Provider 抽象基类和数据模型
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field
from enum import Enum
import time


class AIProviderType(str, Enum):
    """AI Provider 类型枚举"""
    OPENAI = "openai"
    DEEPSEEK = "deepseek"
    OPENROUTER = "openrouter"
    MODELSCOPE = "modelscope"
    CUSTOM = "custom"


class ModelResponse(BaseModel):
    """模型响应数据模型 (LLM)"""
    content: Optional[str] = Field(None, description="响应内容")
    finish_reason: Optional[str] = Field(None, description="完成原因")
    usage: Optional[Dict[str, int]] = Field(None, description="Token 使用情况")
    model: Optional[str] = Field(None, description="使用的模型")
    provider: Optional[str] = Field(None, description="Provider 名称")
    cost: Optional[float] = Field(None, description="请求成本（美元）")
    latency: Optional[float] = Field(None, description="请求延迟（秒）")
    tool_calls: Optional[List[Dict[str, Any]]] = Field(None, description="工具调用")
    error: Optional[str] = Field(None, description="错误信息")


class EmbeddingResponse(BaseModel):
    """Embedding 响应数据模型"""
    embeddings: List[List[float]] = Field(..., description="向量列表")
    model: Optional[str] = Field(None, description="使用的模型")
    usage: Optional[Dict[str, int]] = Field(None, description="Token 使用情况")
    provider: Optional[str] = Field(None, description="Provider 名称")
    latency: Optional[float] = Field(None, description="请求延迟（秒）")
    error: Optional[str] = Field(None, description="错误信息")


class AIProvider(ABC):
    """
    AI Provider 抽象基类
    
    统一管理 LLM 和 Embedding 能力。
    所有 Provider 都必须实现此类中定义的抽象方法。
    """

    def __init__(self, name: str, api_key: str, api_endpoint: str, **kwargs):
        """
        初始化 AI Provider

        Args:
            name: Provider 名称
            api_key: API 密钥
            api_endpoint: API 端点
            **kwargs: 其他配置参数
                - model: 默认模型 (兼容旧配置)
                - model_map: 模型映射 {task_type: model_id}
                - temperature: 温度
                - max_tokens: 最大 token
                - ...
        """
        self.name = name
        self.api_key = api_key
        self.api_endpoint = api_endpoint.rstrip("/")
        
        # 模型配置
        self.model = kwargs.get("model", "")
        self.model_map = kwargs.get("model_map", {}) or {}
        
        # 兼容性处理：如果只提供了 model，默认作为 chat 模型
        if self.model and 'chat' not in self.model_map:
            self.model_map['chat'] = self.model
            
        self.temperature = kwargs.get("temperature", 0.7)
        self.max_tokens = kwargs.get("max_tokens", 4096)
        self.timeout = kwargs.get("timeout", 30)
        self.retry_attempts = kwargs.get("retry_attempts", 3)
        self.retry_delay = kwargs.get("retry_delay", 1.0)
        self.supports_function_calling = kwargs.get("supports_function_calling", False)

    def get_model_for_task(self, task: str) -> Optional[str]:
        """根据任务类型获取模型 ID。model_map 值可为字符串或列表，列表时取第一项为默认。"""
        val = self.model_map.get(task) or self.model
        if not val:
            return self.model
        if isinstance(val, list):
            return val[0].strip() if val else self.model
        return str(val).strip() if str(val).strip() else self.model

    @abstractmethod
    def _do_chat_completion(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        **kwargs
    ) -> ModelResponse:
        """
        实际的对话补全请求（子类实现，不包含重试逻辑）

        Args:
            messages: 消息列表
            model: 指定模型（若未指定则使用配置的 chat 模型）
            ...
        """
        pass

    def chat_completion(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        **kwargs
    ) -> ModelResponse:
        """
        发送对话补全请求（带统一重试机制）

        Args:
            messages: 消息列表
            model: 指定模型（若未指定则使用配置的 chat 模型）
            temperature: 温度参数
            max_tokens: 最大 token 数
            tools: 工具列表
            tool_choice: 工具选择策略
            **kwargs: 其他参数

        Returns:
            ModelResponse: 响应对象
        """
        import time
        import logging

        logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
        last_error = None

        for attempt in range(self.retry_attempts):
            try:
                # 调用子类实现的实际请求方法
                response = self._do_chat_completion(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    tools=tools,
                    tool_choice=tool_choice,
                    **kwargs
                )

                # 如果没有错误，直接返回
                if not response.error:
                    if attempt > 0:
                        logger.info(f"[{self.name}] LLM 调用成功（第 {attempt + 1} 次尝试）")
                    return response

                # 有错误，记录并准备重试
                last_error = response.error
                logger.warning(
                    f"[{self.name}] LLM 调用失败（尝试 {attempt + 1}/{self.retry_attempts}）: {last_error}"
                )

                # 如果是最后一次尝试，返回错误响应
                if attempt == self.retry_attempts - 1:
                    return response

                # 指数退避
                wait_time = self.retry_delay * (2 ** attempt)  # 1s, 2s, 4s
                logger.info(f"[{self.name}] 等待 {wait_time:.1f}s 后重试...")
                time.sleep(wait_time)

            except Exception as e:
                last_error = str(e)
                logger.error(
                    f"[{self.name}] LLM 调用异常（尝试 {attempt + 1}/{self.retry_attempts}）: {last_error}"
                )

                # 如果是最后一次尝试，返回错误响应
                if attempt == self.retry_attempts - 1:
                    return ModelResponse(
                        error=f"LLM 调用异常: {last_error}",
                        provider=self.name
                    )

                # 指数退避
                wait_time = self.retry_delay * (2 ** attempt)
                logger.info(f"[{self.name}] 等待 {wait_time:.1f}s 后重试...")
                time.sleep(wait_time)

        # 理论上不会到这里
        return ModelResponse(
            error=f"LLM 调用失败: {last_error}",
            provider=self.name
        )

    def chat_completion_stream(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ):
        """
        流式对话补全请求（生成器）
        """
        # 默认实现：降级到非流式
        response = self.chat_completion(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs
        )

        if response.error:
            yield {"content": "", "error": response.error, "finish_reason": "error"}
        else:
            yield {
                "content": response.content or "",
                "finish_reason": response.finish_reason or "stop",
                "model": response.model
            }

    @abstractmethod
    def generate_text(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ) -> ModelResponse:
        """发送文本生成请求"""
        pass
    
    @abstractmethod
    def embed(
        self,
        texts: List[str],
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        **kwargs
    ) -> EmbeddingResponse:
        """
        生成向量 Embedding
        
        Args:
            texts: 文本列表
            model: 指定模型（若未指定则使用配置的 embedding 模型）
            dimensions: 向量维度（部分 API 支持）
            
        Returns:
            EmbeddingResponse
        """
        pass

    @property
    def provider_type(self) -> AIProviderType:
        """获取 Provider 类型"""
        return self._get_provider_type()

    @abstractmethod
    def _get_provider_type(self) -> AIProviderType:
        """抽象方法：返回 Provider 类型"""
        pass

    @abstractmethod
    def get_model_list(self) -> List[str]:
        """获取支持的模型列表"""
        pass

    @abstractmethod
    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        """计算 API 调用成本"""
        pass

    @abstractmethod
    def is_available(self) -> bool:
        """检查 Provider 是否可用"""
        pass

    def _validate_response(self, response: Dict[str, Any]) -> None:
        if not isinstance(response, dict):
            raise ValueError("响应必须是字典类型")

    def _before_request(self) -> float:
        return time.time()

    def _after_request(self, start_time: float) -> float:
        return time.time() - start_time

    def __str__(self) -> str:
        return f"{self.__class__.__name__}(name='{self.name}', model_map={self.model_map})"

    def __repr__(self) -> str:
        return self.__str__()
