"""
OpenAI-compatible Provider 公共基类。
"""

import logging
from typing import Any, Dict, List, Optional, Union
import requests

from model_adapter.base import AIProvider, EmbeddingResponse, ModelResponse
from .common import CancellableRequest, InterruptedError, _openai_compatible_stream

logger = logging.getLogger(__name__)


class OpenAICompatibleProvider(AIProvider):
    """兼容 OpenAI 协议的 Provider 公共基类。"""

    def _do_chat_completion(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
        **kwargs,
    ) -> ModelResponse:
        cancel_event = kwargs.pop('cancel_event', None)

        model = model or self.get_model_for_task('chat')
        temperature = temperature if temperature is not None else self.temperature
        max_tokens = max_tokens if max_tokens is not None else self.max_tokens

        payload = {
            'model': model,
            'messages': messages,
            'temperature': temperature,
            'max_tokens': max_tokens,
            **kwargs,
        }

        if tools and self._should_attach_tools():
            payload['tools'] = tools
            if tool_choice:
                payload['tool_choice'] = tool_choice

        start_time = self._before_request()
        response_data = None

        try:
            response = CancellableRequest.post(
                f'{self.api_endpoint}/chat/completions',
                cancel_event=cancel_event,
                headers=self.headers,
                json=payload,
                timeout=self.timeout,
            )
            response.raise_for_status()
            response_data = response.json()

            self._validate_response(response_data)

            choice = response_data['choices'][0]
            usage_data = response_data.get('usage', {})
            usage = {
                'prompt_tokens': usage_data.get('prompt_tokens', 0),
                'completion_tokens': usage_data.get('completion_tokens', 0),
                'total_tokens': usage_data.get('total_tokens', 0),
            }
            latency = self._after_request(start_time)
            cost = self.calculate_cost(usage['prompt_tokens'], usage['completion_tokens'], model)

            return ModelResponse(
                content=choice['message'].get('content'),
                finish_reason=choice.get('finish_reason'),
                usage=usage,
                model=model,
                provider=self.name,
                cost=cost,
                latency=latency,
                tool_calls=choice['message'].get('tool_calls'),
            )

        except InterruptedError:
            logger.info('%s API 调用被用户中断', self.name)
            return ModelResponse(
                error='interrupted',
                model=model,
                provider=self.name,
                latency=self._interrupted_latency(start_time, response_data),
            )
        except Exception as error:
            logger.error('%s API 调用失败: %s', self.name, error)
            return ModelResponse(
                error=str(error),
                model=model,
                provider=self.name,
                latency=self._error_latency(start_time, response_data),
            )

    def chat_completion_stream(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs,
    ):
        cancel_event = kwargs.pop('cancel_event', None)
        kwargs.pop('response_format', None)

        model = model or self.get_model_for_task('chat')
        temperature = temperature if temperature is not None else self.temperature
        max_tokens = max_tokens if max_tokens is not None else self.max_tokens

        payload = {
            'model': model,
            'messages': messages,
            'temperature': temperature,
            'max_tokens': max_tokens,
            'stream': True,
            **kwargs,
        }

        yield from _openai_compatible_stream(
            url=f'{self.api_endpoint}/chat/completions',
            headers=self.headers,
            payload=payload,
            timeout=self.timeout,
            cancel_event=cancel_event,
        )

    def generate_text(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs,
    ) -> ModelResponse:
        return self.chat_completion(
            messages=[{'role': 'user', 'content': prompt}],
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        )

    def embed(
        self,
        texts: List[str],
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        **kwargs,
    ) -> EmbeddingResponse:
        model = model or self.get_model_for_task('embedding') or self._default_embedding_model()
        payload = {
            'input': texts,
            'model': model,
            **kwargs,
        }
        if dimensions and self._supports_dimensions():
            payload['dimensions'] = dimensions

        start_time = self._before_request()
        try:
            response = requests.post(
                f'{self.api_endpoint.rstrip("/")}/embeddings',
                headers=self.headers,
                json=payload,
                timeout=self.timeout,
            )
            response.raise_for_status()
            try:
                data = response.json()
            except ValueError as error:
                handled = self._handle_embedding_non_json(response, error)
                if handled is not None:
                    return handled
                raise

            embeddings = [item['embedding'] for item in sorted(data['data'], key=lambda item: item['index'])]
            usage = {
                'prompt_tokens': data.get('usage', {}).get('prompt_tokens', 0),
                'total_tokens': data.get('usage', {}).get('total_tokens', 0),
            }
            latency = self._after_request(start_time)
            return EmbeddingResponse(
                embeddings=embeddings,
                model=model,
                usage=usage,
                provider=self.name,
                latency=latency,
            )
        except Exception as error:
            logger.error('%s Embedding 调用失败: %s', self.name, error)
            return EmbeddingResponse(
                embeddings=[],
                error=str(error),
                provider=self.name,
            )

    def is_available(self) -> bool:
        try:
            response = requests.get(
                f'{self.api_endpoint}/models',
                headers=self.headers,
                timeout=5,
            )
            return response.status_code == 200
        except Exception:
            return False

    def _should_attach_tools(self) -> bool:
        return self.supports_function_calling

    def _default_embedding_model(self) -> str:
        return 'text-embedding-3-small'

    def _supports_dimensions(self) -> bool:
        return True

    def _handle_embedding_non_json(self, response, error):
        body_preview = (response.text or '')[:300].strip() or '(空)'
        logger.error(
            '%s Embedding 返回非 JSON: status=%s, body: %r',
            self.name,
            response.status_code,
            body_preview,
        )
        return EmbeddingResponse(
            embeddings=[],
            error=f'{self.name} 返回非 JSON (status={response.status_code})，请检查端点与密钥。原始错误: {error}',
            provider=self.name,
        )

    def _interrupted_latency(self, start_time, response_data) -> float:
        return self._after_request(start_time)

    def _error_latency(self, start_time, response_data) -> float:
        return self._after_request(start_time) if response_data else 0
