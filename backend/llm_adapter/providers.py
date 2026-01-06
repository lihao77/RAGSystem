"""
LLM Provider 具体实现

实现了 OpenAI、DeepSeek、OpenRouter 等主流 LLM 服务。
"""

import json
import logging
import time
from typing import Any, Dict, List, Optional, Union
import requests
from .base import LLMProvider, LLMResponse, LLMProviderType

logger = logging.getLogger(__name__)


class OpenAIProvider(LLMProvider):
    """OpenAI Provider 实现"""

    def __init__(self, api_key: str, model: str = "gpt-3.5-turbo", name: str = "OpenAI", **kwargs):
        """初始化 OpenAI Provider

        Args:
            api_key: API 密钥
            model: 模型名称
            name: Provider 名称
            **kwargs: 其他参数
        """
        api_endpoint = kwargs.pop("api_endpoint", "https://api.openai.com/v1")
        super().__init__(
            name=name,
            api_key=api_key,
            api_endpoint=api_endpoint,
            model=model,
            **kwargs
        )
        self.supports_function_calling = kwargs.get("supports_function_calling", True)
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

    def chat_completion(
        self,
        messages: List[Dict[str, str]],
        model: str,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """发送对话补全请求"""
        temperature = temperature if temperature is not None else self.temperature
        max_tokens = max_tokens if max_tokens is not None else self.max_tokens

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            **kwargs
        }

        if tools and self.supports_function_calling:
            payload["tools"] = tools
            if tool_choice:
                payload["tool_choice"] = tool_choice

        start_time = self._before_request()
        response_data = None

        try:
            response = requests.post(
                f"{self.api_endpoint}/chat/completions",
                headers=self.headers,
                json=payload,
                timeout=self.timeout
            )
            response.raise_for_status()
            response_data = response.json()

            self._validate_response(response_data)

            choice = response_data["choices"][0]
            usage_data = response_data.get("usage", {})

            # 只提取 LLMResponse 需要的字段，忽略其他额外字段
            usage = {
                "prompt_tokens": usage_data.get("prompt_tokens", 0),
                "completion_tokens": usage_data.get("completion_tokens", 0),
                "total_tokens": usage_data.get("total_tokens", 0)
            }

            latency = self._after_request(start_time)

            cost = self.calculate_cost(
                usage["prompt_tokens"],
                usage["completion_tokens"],
                model
            )

            return LLMResponse(
                content=choice["message"].get("content"),
                finish_reason=choice.get("finish_reason"),
                usage=usage,
                model=model,
                provider=self.name,
                cost=cost,
                latency=latency,
                tool_calls=choice["message"].get("tool_calls")
            )

        except Exception as e:
            logger.error(f"OpenAI API 调用失败: {str(e)}")
            return LLMResponse(
                error=str(e),
                model=model,
                provider=self.name,
                latency=self._after_request(start_time) if response_data else 0
            )

    def generate_text(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ) -> LLMResponse:
        """发送文本生成请求"""
        messages = [{"role": "user", "content": prompt}]
        return self.chat_completion(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs
        )

    def _get_provider_type(self) -> LLMProviderType:
        return LLMProviderType.OPENAI

    def get_model_list(self) -> List[str]:
        """获取支持的模型列表"""
        return [
            "gpt-4-turbo-preview",
            "gpt-4",
            "gpt-3.5-turbo",
            "gpt-3.5-turbo-16k"
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        """计算成本"""
        pricing = {
            "gpt-4": {"input": 0.03 / 1000, "output": 0.06 / 1000},
            "gpt-3.5-turbo": {"input": 0.0015 / 1000, "output": 0.002 / 1000},
            "gpt-3.5-turbo-16k": {"input": 0.003 / 1000, "output": 0.004 / 1000},
        }

        if model not in pricing:
            model = "gpt-3.5-turbo"

        return (
            input_tokens * pricing[model]["input"] +
            output_tokens * pricing[model]["output"]
        )

    def is_available(self) -> bool:
        """检查可用性"""
        try:
            response = requests.get(
                f"{self.api_endpoint}/models",
                headers=self.headers,
                timeout=5
            )
            return response.status_code == 200
        except Exception:
            return False


class DeepSeekProvider(LLMProvider):
    """DeepSeek Provider 实现"""

    def __init__(self, api_key: str, model: str = "deepseek-chat", name: str = "DeepSeek", **kwargs):
        """初始化 DeepSeek Provider"""
        api_endpoint = kwargs.pop("api_endpoint", "https://api.deepseek.com/v1")
        super().__init__(
            name=name,
            api_key=api_key,
            api_endpoint=api_endpoint,
            model=model,
            **kwargs
        )
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json"
        }

    def chat_completion(
        self,
        messages: List[Dict[str, str]],
        model: str,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """发送对话补全请求（带重试机制）"""
        temperature = temperature if temperature is not None else self.temperature
        max_tokens = max_tokens if max_tokens is not None else self.max_tokens

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            **kwargs
        }

        if tools:
            # 只有当 tools 不为空时才添加到 payload
            payload["tools"] = tools
            if tool_choice:
                payload["tool_choice"] = tool_choice

        start_time = self._before_request()
        response_data = None
        last_error = None

        # 重试循环
        for attempt in range(self.retry_attempts):
            try:
                logger.info(f"DeepSeek API 调用 (尝试 {attempt + 1}/{self.retry_attempts})")

                response = requests.post(
                    f"{self.api_endpoint}/chat/completions",
                    headers=self.headers,
                    json=payload,
                    timeout=self.timeout
                )
                response.raise_for_status()
                response_data = response.json()

                self._validate_response(response_data)

                choice = response_data["choices"][0]
                usage_data = response_data.get("usage", {})

                # 只提取 LLMResponse 需要的字段，忽略其他额外字段
                usage = {
                    "prompt_tokens": usage_data.get("prompt_tokens", 0),
                    "completion_tokens": usage_data.get("completion_tokens", 0),
                    "total_tokens": usage_data.get("total_tokens", 0)
                }

                latency = self._after_request(start_time)

                cost = self.calculate_cost(
                    usage["prompt_tokens"],
                    usage["completion_tokens"],
                    model
                )

                return LLMResponse(
                    content=choice["message"].get("content"),
                    finish_reason=choice.get("finish_reason"),
                    usage=usage,
                    model=model,
                    provider=self.name,
                    cost=cost,
                    latency=latency,
                    tool_calls=choice["message"].get("tool_calls")
                )

            except requests.exceptions.Timeout as e:
                last_error = f"请求超时 (timeout={self.timeout}s)"
                logger.warning(f"DeepSeek API 超时 (尝试 {attempt + 1}/{self.retry_attempts}): {last_error}")

                if attempt < self.retry_attempts - 1:
                    # 不是最后一次尝试，等待后重试
                    import time
                    time.sleep(self.retry_delay)
                    continue

            except requests.exceptions.RequestException as e:
                last_error = str(e)
                logger.warning(f"DeepSeek API 请求失败 (尝试 {attempt + 1}/{self.retry_attempts}): {last_error}")

                # 如果是 400 错误，记录详细的错误信息
                if hasattr(e, 'response') and e.response is not None:
                    try:
                        error_detail = e.response.json()
                        logger.error(f"DeepSeek API 400 错误详情: {json.dumps(error_detail, ensure_ascii=False, indent=2)}")
                    except:
                        logger.error(f"DeepSeek API 响应内容: {e.response.text[:500]}")

                if attempt < self.retry_attempts - 1:
                    import time
                    time.sleep(self.retry_delay)
                    continue

            except Exception as e:
                last_error = str(e)
                logger.error(f"DeepSeek API 调用失败 (尝试 {attempt + 1}/{self.retry_attempts}): {last_error}")

                if attempt < self.retry_attempts - 1:
                    import time
                    time.sleep(self.retry_delay)
                    continue

        # 所有重试都失败
        logger.error(f"DeepSeek API 调用失败，已重试 {self.retry_attempts} 次: {last_error}")
        return LLMResponse(
            error=last_error,
            model=model,
            provider=self.name,
            latency=self._after_request(start_time) if response_data else 0
        )

    def generate_text(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ) -> LLMResponse:
        """发送文本生成请求"""
        messages = [{"role": "user", "content": prompt}]
        return self.chat_completion(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs
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
        流式对话补全请求

        Yields:
            Dict[str, Any]: 流式数据块
        """
        temperature = temperature if temperature is not None else self.temperature
        max_tokens = max_tokens if max_tokens is not None else self.max_tokens
        model = model or self.model

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,  # 启用流式
            **kwargs
        }

        try:
            logger.info(f"DeepSeek 流式 API 调用: model={model}")

            response = requests.post(
                f"{self.api_endpoint}/chat/completions",
                headers=self.headers,
                json=payload,
                timeout=self.timeout,
                stream=True  # 启用流式响应
            )
            response.raise_for_status()

            # 逐行读取 SSE 流
            for line in response.iter_lines():
                if not line:
                    continue

                line = line.decode('utf-8')

                # 跳过注释行
                if line.startswith(':'):
                    continue

                # 解析 SSE 数据
                if line.startswith('data: '):
                    data_str = line[6:]  # 移除 "data: " 前缀

                    # 检查是否为结束标记
                    if data_str.strip() == '[DONE]':
                        yield {
                            "content": "",
                            "finish_reason": "stop",
                            "model": model
                        }
                        break

                    try:
                        chunk_data = json.loads(data_str)

                        # 提取内容
                        if "choices" in chunk_data and len(chunk_data["choices"]) > 0:
                            choice = chunk_data["choices"][0]
                            delta = choice.get("delta", {})
                            content = delta.get("content", "")
                            finish_reason = choice.get("finish_reason")

                            yield {
                                "content": content,
                                "finish_reason": finish_reason,
                                "model": model
                            }

                    except json.JSONDecodeError as e:
                        logger.warning(f"无法解析 SSE 数据块: {data_str[:100]}")
                        continue

        except requests.exceptions.RequestException as e:
            logger.error(f"DeepSeek 流式 API 请求失败: {str(e)}")
            yield {
                "content": "",
                "error": str(e),
                "finish_reason": "error"
            }

    def _get_provider_type(self) -> LLMProviderType:
        return LLMProviderType.DEEPSEEK

    def get_model_list(self) -> List[str]:
        """获取支持的模型列表"""
        return [
            "deepseek-chat",
            "deepseek-coder"
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        """计算成本"""
        if model == "deepseek-chat":
            input_cost = 0.00007 * (input_tokens / 1000)
            output_cost = 0.00028 * (output_tokens / 1000)
        elif model == "deepseek-coder":
            input_cost = 0.00014 * (input_tokens / 1000)
            output_cost = 0.00028 * (output_tokens / 1000)
        else:  # 默认使用 deepseek-chat 的定价
            input_cost = 0.00007 * (input_tokens / 1000)
            output_cost = 0.00028 * (output_tokens / 1000)

        return input_cost + output_cost

    def is_available(self) -> bool:
        """检查可用性"""
        try:
            response = requests.post(
                f"{self.api_endpoint}/models",
                headers=self.headers,
                timeout=5
            )
            return response.status_code == 200
        except Exception:
            return False


class OpenRouterProvider(LLMProvider):
    """OpenRouter Provider 实现"""

    def __init__(self, api_key: str, model: str = "anthropic/claude-3-sonnet-20240229", name: str = "OpenRouter", **kwargs):
        """初始化 OpenRouter Provider"""
        api_endpoint = kwargs.pop("api_endpoint", "https://openrouter.ai/api/v1")
        super().__init__(
            name=name,
            api_key=api_key,
            api_endpoint=api_endpoint,
            model=model,
            **kwargs
        )
        self.supports_function_calling = kwargs.get("supports_function_calling", True)
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": kwargs.get("site_url", ""),
            "X-Title": kwargs.get("site_name", "RAGSystem"),
            "Content-Type": "application/json"
        }

    def chat_completion(
        self,
        messages: List[Dict[str, str]],
        model: str,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """发送对话补全请求"""
        temperature = temperature if temperature is not None else self.temperature
        max_tokens = max_tokens if max_tokens is not None else self.max_tokens

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            **kwargs
        }

        if tools and self.supports_function_calling:
            payload["tools"] = tools
            if tool_choice:
                payload["tool_choice"] = tool_choice

        start_time = self._before_request()
        response_data = None

        try:
            response = requests.post(
                f"{self.api_endpoint}/chat/completions",
                headers=self.headers,
                json=payload,
                timeout=self.timeout
            )
            response.raise_for_status()
            response_data = response.json()

            self._validate_response(response_data)

            choice = response_data["choices"][0]
            usage_data = response_data.get("usage", {})

            # 只提取 LLMResponse 需要的字段，忽略其他额外字段
            usage = {
                "prompt_tokens": usage_data.get("prompt_tokens", 0),
                "completion_tokens": usage_data.get("completion_tokens", 0),
                "total_tokens": usage_data.get("total_tokens", 0)
            }

            latency = self._after_request(start_time)

            cost = self.calculate_cost(
                usage["prompt_tokens"],
                usage["completion_tokens"],
                model
            )

            return LLMResponse(
                content=choice["message"].get("content"),
                finish_reason=choice.get("finish_reason"),
                usage=usage,
                model=model,
                provider=self.name,
                cost=cost,
                latency=latency,
                tool_calls=choice["message"].get("tool_calls")
            )

        except Exception as e:
            logger.error(f"OpenRouter API 调用失败: {str(e)}")
            return LLMResponse(
                error=str(e),
                model=model,
                provider=self.name,
                latency=self._after_request(start_time) if response_data else 0
            )

    def generate_text(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ) -> LLMResponse:
        """发送文本生成请求"""
        messages = [{"role": "user", "content": prompt}]
        return self.chat_completion(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs
        )

    def _get_provider_type(self) -> LLMProviderType:
        return LLMProviderType.OPENROUTER

    def get_model_list(self) -> List[str]:
        """获取支持的模型列表"""
        return [
            "anthropic/claude-3-sonnet-20240229",
            "anthropic/claude-3-opus-20240229",
            "anthropic/claude-3-haiku-20240307",
            "openai/gpt-4-turbo-preview",
            "openai/gpt-3.5-turbo",
            "google/gemini-pro"
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        """计算成本 - OpenRouter 会自动计算"""
        # OpenRouter 会在响应中返回成本
        # 这里返回 0，实际成本需要从响应中获取
        return 0.0

    def is_available(self) -> bool:
        """检查可用性"""
        try:
            response = requests.get(
                f"{self.api_endpoint}/models",
                headers=self.headers,
                timeout=5
            )
            return response.status_code == 200
        except Exception:
            return False
