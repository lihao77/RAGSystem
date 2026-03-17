"""
AI Provider 抽象基类和数据模型
"""

from abc import ABC, abstractmethod
from enum import Enum
import time
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field


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

        # Token 配置（业界标准语义）
        self.max_tokens = kwargs.get("max_tokens", 4096)  # 向后兼容
        self.max_completion_tokens = kwargs.get("max_completion_tokens") or self.max_tokens  # 单次输出限制
        self.max_context_tokens = kwargs.get("max_context_tokens")  # 模型上下文窗口
        self.thinking_budget_tokens = kwargs.get("thinking_budget_tokens")
        self.reasoning_effort = kwargs.get("reasoning_effort")

        self.timeout = kwargs.get("timeout", 30)
        self.retry_attempts = kwargs.get("retry_attempts", 10)
        self.retry_delay = kwargs.get("retry_delay", 1.0)
        self.retry_backoff_factor = kwargs.get("retry_backoff_factor", 2.5)
        self.supports_function_calling = kwargs.get("supports_function_calling", False)

    def _resolve_retry_settings(self, kwargs: Dict[str, Any]) -> tuple[int, float, float]:
        """允许调用方临时覆盖重试参数，未指定时回退到 Provider 配置。"""
        retry_attempts = kwargs.pop("retry_attempts", None)
        retry_delay = kwargs.pop("retry_delay", None)
        retry_backoff_factor = kwargs.pop("retry_backoff_factor", None)
        attempts = self.retry_attempts if retry_attempts is None else int(retry_attempts)
        delay = self.retry_delay if retry_delay is None else float(retry_delay)
        backoff_factor = (
            self.retry_backoff_factor
            if retry_backoff_factor is None
            else float(retry_backoff_factor)
        )
        return max(1, attempts), max(0.0, delay), max(1.0, backoff_factor)

    @staticmethod
    def _is_retryable_error(error: Any) -> bool:
        """判断是否属于适合自动重试的临时性错误。"""
        if isinstance(error, (ConnectionError, TimeoutError)):
            return True

        message = str(error or "").lower()
        if not message:
            return False

        retryable_markers = (
            "connection error",
            "api connection error",
            "connection reset",
            "connection refused",
            "connection aborted",
            "peer closed connection",
            "remote end closed connection",
            "connect timeout",
            "read timeout",
            "timed out",
            "timeout",
            "incomplete chunked read",
            "chunked read",
            "response ended prematurely",
            "server disconnected without sending a response",
            "temporarily unavailable",
            "service unavailable",
            "server disconnected",
            "network error",
            "network is unreachable",
            "dns",
            "rate limit",
            "too many requests",
            "quota exceeded",
            "502",
            "503",
            "504",
        )
        return any(marker in message for marker in retryable_markers)

    @staticmethod
    def _wait_before_retry(wait_time: float, cancel_event) -> bool:
        """等待下次重试，返回 True 表示期间被取消。"""
        if cancel_event:
            return bool(cancel_event.wait(timeout=wait_time))
        time.sleep(wait_time)
        return False

    def _publish_retry_event(
        self,
        *,
        publisher,
        scope: str,
        model: Optional[str],
        failed_attempt: int,
        next_attempt: int,
        max_attempts: int,
        wait_time: float,
        error: str,
    ) -> None:
        """向前端发布 LLM 重试计划。"""
        if not publisher or not hasattr(publisher, "agent_retry_scheduled"):
            return
        try:
            publisher.agent_retry_scheduled(
                provider=self.name,
                model=model,
                scope=scope,
                failed_attempt=failed_attempt,
                next_attempt=next_attempt,
                max_attempts=max_attempts,
                wait_seconds=wait_time,
                error=error,
            )
        except Exception:
            pass

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
                - cancel_event: threading.Event，用于取消请求

        Returns:
            ModelResponse: 响应对象
        """
        import time
        import logging

        logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
        last_error = None
        retry_attempts, retry_delay, retry_backoff_factor = self._resolve_retry_settings(kwargs)

        # 提取 cancel_event（不传给 provider）
        cancel_event = kwargs.pop('cancel_event', None)
        publisher = kwargs.pop('publisher', None)

        for attempt in range(retry_attempts):
            # 每次重试前检查是否被取消
            if cancel_event and cancel_event.is_set():
                return ModelResponse(
                    error="interrupted",
                    provider=self.name
                )

            try:
                # 调用子类实现的实际请求方法（传入 cancel_event）
                response = self._do_chat_completion(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    tools=tools,
                    tool_choice=tool_choice,
                    cancel_event=cancel_event,
                    **kwargs
                )

                # 如果没有错误，直接返回
                if not response.error:
                    if attempt > 0:
                        logger.info(f"[{self.name}] LLM 调用成功（第 {attempt + 1} 次尝试）")
                    return response

                # 检查是否是中断错误
                if response.error == "interrupted":
                    return response

                # 有错误，记录并准备重试
                last_error = response.error
                logger.warning(
                    f"[{self.name}] LLM 调用失败（尝试 {attempt + 1}/{retry_attempts}）: {last_error}"
                )

                # 如果是最后一次尝试，返回错误响应
                if attempt == retry_attempts - 1:
                    return response

                # 指数退避（支持提前唤醒）
                wait_time = retry_delay * (retry_backoff_factor ** attempt)
                logger.info(f"[{self.name}] 等待 {wait_time:.1f}s 后重试...")
                self._publish_retry_event(
                    publisher=publisher,
                    scope="chat_completion",
                    model=model or self.get_model_for_task('chat'),
                    failed_attempt=attempt + 1,
                    next_attempt=attempt + 2,
                    max_attempts=retry_attempts,
                    wait_time=wait_time,
                    error=str(last_error),
                )
                if self._wait_before_retry(wait_time, cancel_event):
                    return ModelResponse(
                        error="interrupted",
                        provider=self.name
                    )

            except Exception as e:
                last_error = str(e)
                logger.error(
                    f"[{self.name}] LLM 调用异常（尝试 {attempt + 1}/{retry_attempts}）: {last_error}"
                )

                # 如果是最后一次尝试，返回错误响应
                if attempt == retry_attempts - 1:
                    return ModelResponse(
                        error=f"LLM 调用异常: {last_error}",
                        provider=self.name
                    )

                # 指数退避（支持提前唤醒）
                wait_time = retry_delay * (retry_backoff_factor ** attempt)
                logger.info(f"[{self.name}] 等待 {wait_time:.1f}s 后重试...")
                self._publish_retry_event(
                    publisher=publisher,
                    scope="chat_completion",
                    model=model or self.get_model_for_task('chat'),
                    failed_attempt=attempt + 1,
                    next_attempt=attempt + 2,
                    max_attempts=retry_attempts,
                    wait_time=wait_time,
                    error=str(last_error),
                )
                if self._wait_before_retry(wait_time, cancel_event):
                    return ModelResponse(
                        error="interrupted",
                        provider=self.name
                    )

        # 理论上不会到这里
        return ModelResponse(
            error=f"LLM 调用失败: {last_error}",
            provider=self.name
        )

    def _do_chat_completion_stream(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ):
        """
        单次流式对话补全请求（子类可重写）。

        默认降级为一次非流式请求，再包装成单个 chunk 输出。
        """
        response = self._do_chat_completion(
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
        import logging

        logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
        last_error = None
        retry_attempts, retry_delay, retry_backoff_factor = self._resolve_retry_settings(kwargs)
        cancel_event = kwargs.pop('cancel_event', None)
        publisher = kwargs.pop('publisher', None)

        for attempt in range(retry_attempts):
            if cancel_event and cancel_event.is_set():
                yield {"content": "", "finish_reason": "interrupted"}
                return

            stream_started = False
            should_retry = False

            try:
                stream = self._do_chat_completion_stream(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    cancel_event=cancel_event,
                    **kwargs
                )

                for chunk in stream:
                    if chunk.get('finish_reason') == 'interrupted':
                        yield chunk
                        return

                    if chunk.get('error'):
                        last_error = chunk['error']
                        retryable = self._is_retryable_error(last_error)

                        if stream_started:
                            logger.warning(
                                f"[{self.name}] 流式调用在已输出内容后失败，不自动重试: {last_error}"
                            )
                            yield chunk
                            return

                        logger.warning(
                            f"[{self.name}] 流式调用失败（尝试 {attempt + 1}/{retry_attempts}）: {last_error}"
                        )
                        if not retryable or attempt == retry_attempts - 1:
                            yield chunk
                            return

                        should_retry = True
                        break

                    if chunk.get('content') or chunk.get('finish_reason') or chunk.get('tool_calls'):
                        stream_started = True
                    yield chunk

                if not should_retry:
                    return

                wait_time = retry_delay * (retry_backoff_factor ** attempt)
                logger.info(f"[{self.name}] 流式调用等待 {wait_time:.1f}s 后重试...")
                self._publish_retry_event(
                    publisher=publisher,
                    scope="chat_completion_stream",
                    model=model or self.get_model_for_task('chat'),
                    failed_attempt=attempt + 1,
                    next_attempt=attempt + 2,
                    max_attempts=retry_attempts,
                    wait_time=wait_time,
                    error=str(last_error),
                )
                if self._wait_before_retry(wait_time, cancel_event):
                    yield {"content": "", "finish_reason": "interrupted"}
                    return

            except Exception as e:
                last_error = str(e)
                logger.error(
                    f"[{self.name}] 流式调用异常（尝试 {attempt + 1}/{retry_attempts}）: {last_error}"
                )
                if attempt == retry_attempts - 1 or not self._is_retryable_error(e):
                    yield {"content": "", "error": last_error, "finish_reason": "error"}
                    return

                wait_time = retry_delay * (retry_backoff_factor ** attempt)
                logger.info(f"[{self.name}] 流式调用等待 {wait_time:.1f}s 后重试...")
                self._publish_retry_event(
                    publisher=publisher,
                    scope="chat_completion_stream",
                    model=model or self.get_model_for_task('chat'),
                    failed_attempt=attempt + 1,
                    next_attempt=attempt + 2,
                    max_attempts=retry_attempts,
                    wait_time=wait_time,
                    error=str(last_error),
                )
                if self._wait_before_retry(wait_time, cancel_event):
                    yield {"content": "", "finish_reason": "interrupted"}
                    return

        yield {
            "content": "",
            "error": f"LLM 流式调用失败: {last_error}",
            "finish_reason": "error",
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
