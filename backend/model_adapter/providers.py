"""
AI Provider 具体实现

实现了 OpenAI、DeepSeek、OpenRouter 等主流 AI 服务。
"""

import json
import logging
import time
from typing import Any, Dict, List, Optional, Union
import requests
from .base import AIProvider, ModelResponse, EmbeddingResponse, AIProviderType

logger = logging.getLogger(__name__)


class OpenAIProvider(AIProvider):
    """OpenAI Provider 实现"""

    def __init__(self, api_key: str, model: str = "gpt-3.5-turbo", name: str = "OpenAI", **kwargs):
        """初始化 OpenAI Provider"""
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
        """发送对话补全请求（实际实现，不含重试）"""
        # 使用传入的模型，或者从 model_map['chat'] 获取，或者使用默认 model
        model = model or self.get_model_for_task('chat')
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

            return ModelResponse(
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
            return ModelResponse(
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
    ) -> ModelResponse:
        """发送文本生成请求"""
        messages = [{"role": "user", "content": prompt}]
        return self.chat_completion(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs
        )
        
    def embed(
        self,
        texts: List[str],
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        **kwargs
    ) -> EmbeddingResponse:
        """生成向量 Embedding"""
        model = model or self.get_model_for_task('embedding') or "text-embedding-3-small"
        
        payload = {
            "input": texts,
            "model": model,
            **kwargs
        }
        
        if dimensions:
            payload["dimensions"] = dimensions
            
        start_time = self._before_request()
        
        try:
            response = requests.post(
                f"{self.api_endpoint}/embeddings",
                headers=self.headers,
                json=payload,
                timeout=self.timeout
            )
            response.raise_for_status()
            try:
                data = response.json()
            except ValueError as je:
                # 响应体不是 JSON（常见为 HTML 错误页或空 body）
                body_preview = (response.text or "")[:300].strip() or "(空)"
                logger.error(
                    f"Embedding API 返回非 JSON 响应: status={response.status_code}, "
                    f"body 前 300 字符: {body_preview!r}"
                )
                return EmbeddingResponse(
                    embeddings=[],
                    error=f"API 返回非 JSON (status={response.status_code})，请检查端点与密钥。原始错误: {je}",
                    provider=self.name
                )
            
            # OpenAI format: {"data": [{"embedding": [...], "index": 0}, ...], "usage": ...}
            embeddings = [item["embedding"] for item in sorted(data["data"], key=lambda x: x["index"])]
            
            usage = {
                "prompt_tokens": data.get("usage", {}).get("prompt_tokens", 0),
                "total_tokens": data.get("usage", {}).get("total_tokens", 0)
            }
            
            latency = self._after_request(start_time)
            
            return EmbeddingResponse(
                embeddings=embeddings,
                model=model,
                usage=usage,
                provider=self.name,
                latency=latency
            )
            
        except Exception as e:
            logger.error(f"OpenAI Embedding 调用失败: {str(e)}")
            return EmbeddingResponse(
                embeddings=[],
                error=str(e),
                provider=self.name
            )

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.OPENAI

    def get_model_list(self) -> List[str]:
        """获取支持的模型列表"""
        return [
            "gpt-4-turbo-preview",
            "gpt-4",
            "gpt-3.5-turbo",
            "text-embedding-3-small",
            "text-embedding-3-large"
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        """计算成本"""
        pricing = {
            "gpt-4": {"input": 0.03 / 1000, "output": 0.06 / 1000},
            "gpt-3.5-turbo": {"input": 0.0015 / 1000, "output": 0.002 / 1000},
            "text-embedding-3-small": {"input": 0.00002 / 1000, "output": 0},
        }
        
        # 简单匹配
        price = pricing.get(model)
        if not price:
            # 尝试模糊匹配
            if "gpt-4" in model:
                price = pricing["gpt-4"]
            else:
                price = pricing["gpt-3.5-turbo"]

        return (
            input_tokens * price["input"] +
            output_tokens * price["output"]
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


class DeepSeekProvider(AIProvider):
    """DeepSeek Provider 实现"""

    def __init__(self, api_key: str, model: str = "deepseek-chat", name: str = "DeepSeek", **kwargs):
        """初始化 DeepSeek Provider"""
        api_endpoint = kwargs.pop("api_endpoint", "https://api.deepseek.com")
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
        """发送对话补全请求（实际实现，不含重试）"""
        model = model or self.get_model_for_task('chat')
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
            payload["tools"] = tools
            if tool_choice:
                payload["tool_choice"] = tool_choice

        start_time = self._before_request()

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

            return ModelResponse(
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
            logger.error(f"DeepSeek API 调用失败: {str(e)}")
            return ModelResponse(
                error=str(e),
                model=model,
                provider=self.name,
                latency=self._after_request(start_time)
            )

    def generate_text(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs
    ) -> ModelResponse:
        """发送文本生成请求"""
        messages = [{"role": "user", "content": prompt}]
        return self.chat_completion(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs
        )

    def embed(
        self,
        texts: List[str],
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        **kwargs
    ) -> EmbeddingResponse:
        """生成向量 Embedding"""
        # DeepSeek 不支持 dimensions 参数
        model = model or self.get_model_for_task('embedding') or "deepseek-embedding"
        
        payload = {
            "input": texts,
            "model": model,
            **kwargs
        }
            
        start_time = self._before_request()
        
        try:
            # DeepSeek 使用兼容 OpenAI 的接口
            # 注意：DeepSeek 的 API 端点可能略有不同，但通常也是 /embeddings
            # 如果初始化时 api_endpoint 是 https://api.deepseek.com/v1，则正确
            # 但新版 DeepSeek API 推荐 https://api.deepseek.com
            
            # 为了稳健性，确保 URL 正确拼接
            # 如果 api_endpoint 包含 v1，则去掉，或者假设它就是 base url
            # 标准做法：Base URL + /chat/completions 或 /embeddings
            
            response = requests.post(
                f"{self.api_endpoint}/embeddings", 
                headers=self.headers,
                json=payload,
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()
            
            embeddings = [item["embedding"] for item in sorted(data["data"], key=lambda x: x["index"])]
            
            usage = {
                "prompt_tokens": data.get("usage", {}).get("prompt_tokens", 0),
                "total_tokens": data.get("usage", {}).get("total_tokens", 0)
            }
            
            latency = self._after_request(start_time)
            
            return EmbeddingResponse(
                embeddings=embeddings,
                model=model,
                usage=usage,
                provider=self.name,
                latency=latency
            )
            
        except Exception as e:
            logger.error(f"DeepSeek Embedding 调用失败: {str(e)}")
            return EmbeddingResponse(
                embeddings=[],
                error=str(e),
                provider=self.name
            )

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.DEEPSEEK

    def get_model_list(self) -> List[str]:
        return [
            "deepseek-chat",
            "deepseek-coder",
            "deepseek-reasoner"
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        # 简单估算
        return 0.0

    def is_available(self) -> bool:
        try:
            response = requests.get(
                f"{self.api_endpoint}/models",
                headers=self.headers,
                timeout=5
            )
            return response.status_code == 200
        except Exception:
            return False


class ModelScopeProvider(OpenAIProvider):
    """
    ModelScope Provider 实现
    
    ModelScope 的 OpenAI 兼容接口，主要用于 Embedding，但也支持 LLM。
    特点是 Embedding 接口强制要求 encoding_format 参数。
    """
    
    def __init__(self, api_key: str, model: str = "Qwen/Qwen3-Embedding-8B", name: str = "ModelScope", **kwargs):
        """初始化 ModelScope Provider"""
        api_endpoint = kwargs.pop("api_endpoint", "https://api-inference.modelscope.cn/v1")
        super().__init__(
            api_key=api_key,
            model=model,
            name=name,
            api_endpoint=api_endpoint,
            **kwargs
        )
        
    def embed(
        self,
        texts: List[str],
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        **kwargs
    ) -> EmbeddingResponse:
        """生成向量 Embedding (强制添加 encoding_format)"""
        # ModelScope 需要显式指定 encoding_format
        kwargs["encoding_format"] = "float"
        return super().embed(texts, model, dimensions, **kwargs)

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.MODELSCOPE

    def get_model_list(self) -> List[str]:
        return [
            "Qwen/Qwen3-Embedding-8B",
            "Qwen/Qwen2.5-72B-Instruct",
            "Qwen/Qwen2.5-7B-Instruct"
        ]
class OpenRouterProvider(AIProvider):
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
        """发送对话补全请求（实际实现，不含重试）"""
        model = model or self.get_model_for_task('chat')
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

            return ModelResponse(
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
            return ModelResponse(
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
    ) -> ModelResponse:
        """发送文本生成请求"""
        messages = [{"role": "user", "content": prompt}]
        return self.chat_completion(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs
        )
        
    def embed(
        self,
        texts: List[str],
        model: Optional[str],
        dimensions: Optional[int] = None,
        **kwargs
    ) -> EmbeddingResponse:
        """生成向量 Embedding"""
        model = model or self.get_model_for_task('embedding') or "text-embedding-3-small"
        
        payload = {
            "input": texts,
            "model": model,
            **kwargs
        }
        
        if dimensions:
            payload["dimensions"] = dimensions
            
        start_time = self._before_request()
        
        try:
            # OpenRouter 的 embedding 端点与 OpenAI 兼容，路径为 /embeddings
            response = requests.post(
                f"{self.api_endpoint.rstrip('/')}/embeddings",
                headers=self.headers,
                json=payload,
                timeout=self.timeout
            )
            response.raise_for_status()
            try:
                data = response.json()
            except ValueError as je:
                body_preview = (response.text or "")[:300].strip() or "(空)"
                logger.error(
                    f"OpenRouter Embedding 返回非 JSON: status={response.status_code}, body: {body_preview!r}"
                )
                return EmbeddingResponse(
                    embeddings=[],
                    error=f"OpenRouter 返回非 JSON (status={response.status_code})，可能不支持 /embeddings 或密钥有误。原始: {je}",
                    provider=self.name
                )
            
            # OpenAI format: {"data": [{"embedding": [...], "index": 0}, ...], "usage": ...}
            embeddings = [item["embedding"] for item in sorted(data["data"], key=lambda x: x["index"])]
            
            usage = {
                "prompt_tokens": data.get("usage", {}).get("prompt_tokens", 0),
                "total_tokens": data.get("usage", {}).get("total_tokens", 0)
            }
            
            latency = self._after_request(start_time)
            
            return EmbeddingResponse(
                embeddings=embeddings,
                model=model,
                usage=usage,
                provider=self.name,
                latency=latency
            )
            
        except Exception as e:
            logger.error(f"OpenRouter Embedding 调用失败: {str(e)}")
            return EmbeddingResponse(
                embeddings=[],
                error=str(e),
                provider=self.name
            )

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.OPENROUTER

    def get_model_list(self) -> List[str]:
        return [
            "anthropic/claude-3-sonnet-20240229",
            "openai/gpt-4-turbo-preview"
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        return 0.0

    def is_available(self) -> bool:
        try:
            response = requests.get(
                f"{self.api_endpoint}/models",
                headers=self.headers,
                timeout=5
            )
            return response.status_code == 200
        except Exception:
            return False
