"""OpenAI Provider 实现。"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, List, Optional, Union

from model_adapter.base import AIProviderType, EmbeddingResponse, ModelResponse
from .common import InterruptedError
from .openai_compatible_provider import OpenAICompatibleProvider

try:
    from openai import OpenAI
except Exception:  # pragma: no cover - 运行时缺依赖时由 _get_client 抛出更明确错误
    OpenAI = None


logger = logging.getLogger(__name__)


class OpenAIProvider(OpenAICompatibleProvider):
    """使用 OpenAI 官方 Python SDK 的 Provider 实现。"""

    def __init__(self, api_key: str, model: str = 'gpt-3.5-turbo', name: str = 'OpenAI', **kwargs):
        api_endpoint = kwargs.pop('api_endpoint', 'https://api.openai.com/v1')
        super().__init__(
            name=name,
            api_key=api_key,
            api_endpoint=api_endpoint,
            model=model,
            **kwargs,
        )
        self.supports_function_calling = kwargs.get('supports_function_calling', True)
        self.supports_prompt_caching = kwargs.get('supports_prompt_caching', True)
        self.prompt_cache_style = kwargs.get('prompt_cache_style', 'openai')
        self.prompt_cache_min_tokens = kwargs.get('prompt_cache_min_tokens', 1024)
        self.headers = {
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json',
        }
        self._client = None

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.OPENAI

    def _prefers_max_completion_tokens(self) -> bool:
        return True

    def _get_client(self):
        if OpenAI is None:
            raise ImportError('未安装 openai 包，请先安装 backend-fastapi/requirements.txt 中的依赖')
        if self._client is None:
            self._client = OpenAI(
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
            except Exception as exc:  # pragma: no cover - 通过主线程抛出
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

    def _build_chat_request(
        self,
        *,
        messages: List[Dict[str, str]],
        model: Optional[str],
        temperature: Optional[float],
        max_tokens: Optional[int],
        tools: Optional[List[Dict[str, Any]]],
        tool_choice: Optional[Union[str, Dict[str, Any]]],
        kwargs: Dict[str, Any],
    ) -> tuple[Dict[str, Any], Any]:
        local_kwargs = dict(kwargs)
        cancel_event = local_kwargs.pop('cancel_event', None)
        response_format = local_kwargs.pop('response_format', None)
        stop = local_kwargs.pop('stop', None)
        thinking_budget_tokens = local_kwargs.pop('thinking_budget_tokens', None)
        reasoning_effort = local_kwargs.pop('reasoning_effort', None) or self.reasoning_effort

        model = model or self.get_model_for_task('chat')
        temperature = temperature if temperature is not None else self.temperature
        max_token_field = 'max_completion_tokens' if self._prefers_max_completion_tokens() else 'max_tokens'
        max_token_value = max_tokens if max_tokens is not None else (
            self.max_completion_tokens if self._prefers_max_completion_tokens() else self.max_tokens
        )

        payload: Dict[str, Any] = {
            'model': model,
            'messages': messages,
            'temperature': temperature,
            max_token_field: max_token_value,
        }
        if response_format is not None:
            payload['response_format'] = response_format
        if stop is not None:
            payload['stop'] = stop
        if tools and self._should_attach_tools():
            payload['tools'] = tools
            if tool_choice:
                payload['tool_choice'] = tool_choice

        extra_body = {
            key: value
            for key, value in local_kwargs.items()
            if value is not None
        }
        if reasoning_effort:
            extra_body['reasoning_effort'] = reasoning_effort
        if thinking_budget_tokens is not None:
            extra_body['thinking_budget_tokens'] = thinking_budget_tokens
        if extra_body:
            payload['extra_body'] = extra_body
        return payload, cancel_event

    def _normalize_tool_calls(self, tool_calls: Any) -> Optional[List[Dict[str, Any]]]:
        if not tool_calls:
            return None
        normalized = []
        for tool_call in tool_calls:
            if hasattr(tool_call, 'model_dump'):
                normalized.append(tool_call.model_dump(mode='python', exclude_none=True))
            elif isinstance(tool_call, dict):
                normalized.append(tool_call)
            else:
                normalized.append({
                    'id': getattr(tool_call, 'id', None),
                    'type': getattr(tool_call, 'type', None),
                    'function': {
                        'name': getattr(getattr(tool_call, 'function', None), 'name', None),
                        'arguments': getattr(getattr(tool_call, 'function', None), 'arguments', None),
                    },
                })
        return normalized

    def _normalize_stream_tool_calls(self, tool_calls: Any) -> Optional[List[Dict[str, Any]]]:
        if not tool_calls:
            return None
        normalized = []
        for tool_call in tool_calls:
            if hasattr(tool_call, 'model_dump'):
                normalized.append(tool_call.model_dump(mode='python', exclude_none=True))
                continue

            function = getattr(tool_call, 'function', None)
            normalized.append({
                'index': getattr(tool_call, 'index', None),
                'id': getattr(tool_call, 'id', None),
                'type': getattr(tool_call, 'type', None),
                'function': {
                    'name': getattr(function, 'name', None),
                    'arguments': getattr(function, 'arguments', None),
                },
            })
        return normalized or None

    def _extract_usage(self, usage_data: Any) -> Dict[str, int]:
        usage = {
            'prompt_tokens': getattr(usage_data, 'prompt_tokens', 0) or 0,
            'completion_tokens': getattr(usage_data, 'completion_tokens', 0) or 0,
            'total_tokens': getattr(usage_data, 'total_tokens', 0) or 0,
        }
        prompt_details = getattr(usage_data, 'prompt_tokens_details', None)
        cached_tokens = getattr(prompt_details, 'cached_tokens', 0) if prompt_details is not None else 0
        if cached_tokens:
            usage['cached_tokens'] = cached_tokens
        return usage

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
        request_kwargs, cancel_event = self._build_chat_request(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
            kwargs=kwargs,
        )
        start_time = self._before_request()

        try:
            response = self._call_with_cancel(
                lambda: self._get_client().chat.completions.create(**request_kwargs),
                cancel_event,
            )
            choice = response.choices[0]
            message = choice.message
            usage_data = getattr(response, 'usage', None)
            usage = self._extract_usage(usage_data)
            selected_model = getattr(response, 'model', None) or request_kwargs['model']
            latency = self._after_request(start_time)
            cost = self.calculate_cost(usage['prompt_tokens'], usage['completion_tokens'], selected_model)
            normalized_tool_calls = self._normalize_tool_calls(getattr(message, 'tool_calls', None))
            if normalized_tool_calls:
                logger.info(
                    '[%s] OpenAI raw tool_calls detected (non-stream): model=%s tool_calls=%s',
                    self.name,
                    selected_model,
                    normalized_tool_calls,
                )

            return ModelResponse(
                content=getattr(message, 'content', None),
                finish_reason=getattr(choice, 'finish_reason', None),
                usage=usage,
                model=selected_model,
                provider=self.name,
                cost=cost,
                latency=latency,
                tool_calls=normalized_tool_calls,
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
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs,
    ):
        request_kwargs, cancel_event = self._build_chat_request(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=None,
            tool_choice=None,
            kwargs=kwargs,
        )
        request_kwargs['stream'] = True

        stream = None
        try:
            if cancel_event is not None and cancel_event.is_set():
                yield {'content': '', 'finish_reason': 'interrupted'}
                return

            stream = self._get_client().chat.completions.create(**request_kwargs)
            for chunk in stream:
                if cancel_event is not None and cancel_event.is_set():
                    if hasattr(stream, 'close'):
                        stream.close()
                    yield {'content': '', 'finish_reason': 'interrupted'}
                    return

                choices = getattr(chunk, 'choices', None) or []
                if not choices:
                    continue
                choice = choices[0]
                delta = getattr(choice, 'delta', None)
                content = getattr(delta, 'content', None) or ''
                raw_tool_calls = self._normalize_stream_tool_calls(getattr(delta, 'tool_calls', None))
                finish_reason = getattr(choice, 'finish_reason', None)

                if raw_tool_calls:
                    logger.info(
                        '[%s] OpenAI raw tool_calls detected (stream): model=%s finish_reason=%s tool_calls=%s',
                        self.name,
                        request_kwargs['model'],
                        finish_reason,
                        raw_tool_calls,
                    )

                if content or finish_reason:
                    yield {
                        'content': content,
                        'finish_reason': finish_reason,
                    }
        except InterruptedError:
            yield {'content': '', 'finish_reason': 'interrupted'}
        except Exception as error:
            logger.error('%s SDK 流式调用失败: %s', self.name, error)
            yield {'content': '', 'error': str(error), 'finish_reason': 'error'}
        finally:
            if stream is not None and hasattr(stream, 'close'):
                stream.close()

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
        cancel_event = kwargs.pop('cancel_event', None)
        payload: Dict[str, Any] = {
            'input': texts,
            'model': model,
        }
        if dimensions and self._supports_dimensions():
            payload['dimensions'] = dimensions
        payload.update({key: value for key, value in kwargs.items() if value is not None})

        start_time = self._before_request()
        try:
            response = self._call_with_cancel(
                lambda: self._get_client().embeddings.create(**payload),
                cancel_event,
            )
            embeddings = [item.embedding for item in sorted(response.data, key=lambda item: item.index)]
            usage_data = getattr(response, 'usage', None)
            usage = {
                'prompt_tokens': getattr(usage_data, 'prompt_tokens', 0) or 0,
                'total_tokens': getattr(usage_data, 'total_tokens', 0) or 0,
            }
            latency = self._after_request(start_time)
            return EmbeddingResponse(
                embeddings=embeddings,
                model=getattr(response, 'model', None) or model,
                usage=usage,
                provider=self.name,
                latency=latency,
            )
        except InterruptedError:
            return EmbeddingResponse(
                embeddings=[],
                error='interrupted',
                provider=self.name,
                latency=self._after_request(start_time),
            )
        except Exception as error:
            logger.error('%s Embedding SDK 调用失败: %s', self.name, error)
            return EmbeddingResponse(
                embeddings=[],
                error=str(error),
                provider=self.name,
            )

    def is_available(self) -> bool:
        try:
            self._get_client().models.list()
            return True
        except Exception:
            return False

    def get_model_list(self) -> List[str]:
        return [
            'gpt-4-turbo-preview',
            'gpt-4',
            'gpt-3.5-turbo',
            'text-embedding-3-small',
            'text-embedding-3-large',
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        pricing = {
            'gpt-4': {'input': 0.03 / 1000, 'output': 0.06 / 1000},
            'gpt-3.5-turbo': {'input': 0.0015 / 1000, 'output': 0.002 / 1000},
            'text-embedding-3-small': {'input': 0.00002 / 1000, 'output': 0},
        }
        price = pricing.get(model)
        if not price:
            if 'gpt-4' in model:
                price = pricing['gpt-4']
            else:
                price = pricing['gpt-3.5-turbo']
        return input_tokens * price['input'] + output_tokens * price['output']
