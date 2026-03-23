"""Anthropic Provider 实现。"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, List, Optional

from model_adapter.base import AIProvider, AIProviderType, EmbeddingResponse, ModelResponse
from .common import InterruptedError

try:
    from anthropic import Anthropic
except Exception:  # pragma: no cover
    Anthropic = None


logger = logging.getLogger(__name__)


class AnthropicProvider(AIProvider):
    """使用 Anthropic 官方 Python SDK 的 Provider 实现。"""

    def __init__(self, api_key: str, model: str = 'claude-sonnet-4-5', name: str = 'Anthropic', **kwargs):
        api_endpoint = kwargs.pop('api_endpoint', 'https://api.anthropic.com')
        super().__init__(
            name=name,
            api_key=api_key,
            api_endpoint=api_endpoint,
            model=model,
            **kwargs,
        )
        self.supports_function_calling = kwargs.get('supports_function_calling', False)
        self.supports_prompt_caching = kwargs.get('supports_prompt_caching', True)
        self.prompt_cache_style = kwargs.get('prompt_cache_style', 'anthropic')
        self.prompt_cache_min_tokens = kwargs.get('prompt_cache_min_tokens', 1024)
        self._client = None

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.ANTHROPIC

    def _get_client(self):
        if Anthropic is None:
            raise ImportError('未安装 anthropic 包，请先安装 backend-fastapi/requirements.txt 中的依赖')
        if self._client is None:
            self._client = Anthropic(
                api_key=self.api_key,
                base_url=self.api_endpoint,
                timeout=self.timeout,
                max_retries=0,
            )
        return self._client

    def _call_with_cancel(self, func: Callable[[], Any], cancel_event) -> Any:
        if cancel_event is None:
            return func()
        if cancel_event.is_set():
            raise InterruptedError('请求已取消')

        result = [None]
        error = [None]
        done = threading.Event()

        def _runner():
            try:
                result[0] = func()
            except Exception as exc:  # pragma: no cover
                error[0] = exc
            finally:
                done.set()

        thread = threading.Thread(target=_runner, daemon=True)
        thread.start()

        while not done.is_set():
            if cancel_event.is_set():
                raise InterruptedError('请求被用户取消')
            done.wait(timeout=0.2)

        if error[0] is not None:
            raise error[0]
        return result[0]

    def _extract_text_block(self, content: Any) -> Optional[Dict[str, Any]]:
        if content is None:
            return None
        if isinstance(content, str):
            return {'type': 'text', 'text': content} if content else None
        if isinstance(content, dict):
            if content.get('type') == 'text':
                return {'type': 'text', 'text': str(content.get('text', ''))}
            if 'text' in content:
                return {'type': 'text', 'text': str(content.get('text', ''))}
            return None
        return {'type': 'text', 'text': str(content)}

    def _to_content_blocks(self, message: Dict[str, Any], *, enable_cache: bool) -> List[Dict[str, Any]]:
        content = message.get('content')
        metadata = message.get('metadata') or {}
        blocks: List[Dict[str, Any]] = []

        if isinstance(content, list):
            for item in content:
                block = self._extract_text_block(item)
                if block:
                    blocks.append(block)
        else:
            block = self._extract_text_block(content)
            if block:
                blocks.append(block)

        if enable_cache and metadata.get('prompt_cache', {}).get('enabled') and blocks:
            blocks[-1] = {
                **blocks[-1],
                'cache_control': {'type': 'ephemeral'},
            }
        return blocks

    def _build_messages_request(
        self,
        *,
        messages: List[Dict[str, Any]],
        model: Optional[str],
        temperature: Optional[float],
        max_tokens: Optional[int],
        kwargs: Dict[str, Any],
    ) -> tuple[Dict[str, Any], Any]:
        local_kwargs = dict(kwargs)
        cancel_event = local_kwargs.pop('cancel_event', None)
        stop = local_kwargs.pop('stop', None)
        reasoning_effort = local_kwargs.pop('reasoning_effort', None)
        thinking_budget_tokens = local_kwargs.pop('thinking_budget_tokens', None)

        selected_model = model or self.get_model_for_task('chat')
        selected_temperature = temperature if temperature is not None else self.temperature
        selected_max_tokens = max_tokens if max_tokens is not None else self.max_completion_tokens

        system_blocks: List[Dict[str, Any]] = []
        request_messages: List[Dict[str, Any]] = []

        for message in messages:
            role = message.get('role')
            content_blocks = self._to_content_blocks(message, enable_cache=self.supports_prompt_caching)
            if not content_blocks:
                continue
            if role == 'system':
                system_blocks.extend(content_blocks)
                continue
            if role not in ('user', 'assistant'):
                continue
            request_messages.append({'role': role, 'content': content_blocks})

        payload: Dict[str, Any] = {
            'model': selected_model,
            'messages': request_messages,
            'max_tokens': selected_max_tokens,
            'temperature': selected_temperature,
        }
        if system_blocks:
            payload['system'] = system_blocks
        if stop is not None:
            payload['stop_sequences'] = stop
        if thinking_budget_tokens is not None:
            payload['thinking'] = {
                'type': 'enabled',
                'budget_tokens': thinking_budget_tokens,
            }
        if reasoning_effort:
            payload['metadata'] = {'reasoning_effort': reasoning_effort}

        extra_body = {key: value for key, value in local_kwargs.items() if value is not None}
        if extra_body:
            payload.update(extra_body)
        return payload, cancel_event

    @staticmethod
    def _extract_response_text(response) -> str:
        parts: List[str] = []
        for block in getattr(response, 'content', None) or []:
            text = getattr(block, 'text', None)
            if text:
                parts.append(text)
        return ''.join(parts)

    @staticmethod
    def _extract_usage(usage_data: Any) -> Dict[str, int]:
        input_tokens = getattr(usage_data, 'input_tokens', 0) or 0
        output_tokens = getattr(usage_data, 'output_tokens', 0) or 0
        usage = {
            'prompt_tokens': input_tokens,
            'completion_tokens': output_tokens,
            'total_tokens': input_tokens + output_tokens,
        }
        creation_tokens = getattr(usage_data, 'cache_creation_input_tokens', 0) or 0
        read_tokens = getattr(usage_data, 'cache_read_input_tokens', 0) or 0
        if creation_tokens:
            usage['cache_creation_input_tokens'] = creation_tokens
        if read_tokens:
            usage['cache_read_input_tokens'] = read_tokens
        return usage

    def _do_chat_completion(
        self,
        messages: List[Dict[str, Any]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> ModelResponse:
        del tools, tool_choice
        request_kwargs, cancel_event = self._build_messages_request(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            kwargs=kwargs,
        )
        start_time = self._before_request()

        try:
            response = self._call_with_cancel(
                lambda: self._get_client().messages.create(**request_kwargs),
                cancel_event,
            )
            usage = self._extract_usage(getattr(response, 'usage', None))
            selected_model = getattr(response, 'model', None) or request_kwargs['model']
            latency = self._after_request(start_time)
            cost = self.calculate_cost(usage['prompt_tokens'], usage['completion_tokens'], selected_model)
            return ModelResponse(
                content=self._extract_response_text(response),
                finish_reason=getattr(response, 'stop_reason', None),
                usage=usage,
                model=selected_model,
                provider=self.name,
                cost=cost,
                latency=latency,
            )
        except InterruptedError:
            logger.info('%s SDK 调用被用户中断', self.name)
            return ModelResponse(
                error='interrupted',
                model=request_kwargs['model'],
                provider=self.name,
                latency=self._after_request(start_time),
            )
        except Exception as error:
            logger.error('%s SDK 调用失败: %s', self.name, error)
            return ModelResponse(
                error=str(error),
                model=request_kwargs['model'],
                provider=self.name,
                latency=self._after_request(start_time),
            )

    def _do_chat_completion_stream(
        self,
        messages: List[Dict[str, Any]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs,
    ):
        response = self._do_chat_completion(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        )
        if response.error:
            yield {'content': '', 'error': response.error, 'finish_reason': 'error'}
            return
        yield {
            'content': response.content or '',
            'finish_reason': response.finish_reason or 'stop',
            'model': response.model,
            'usage': response.usage,
        }

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
        del texts, model, dimensions, kwargs
        return EmbeddingResponse(
            embeddings=[],
            error='Anthropic 暂不支持 embedding',
            provider=self.name,
        )

    def get_model_list(self) -> List[str]:
        return [
            'claude-sonnet-4-5',
            'claude-opus-4-1',
            'claude-3-7-sonnet-latest',
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        del input_tokens, output_tokens, model
        return 0.0

    def is_available(self) -> bool:
        try:
            self._get_client()
            return True
        except Exception:
            return False
