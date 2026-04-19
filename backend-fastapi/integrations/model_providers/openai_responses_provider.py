"""OpenAI Responses Provider 实现。"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Union

from model_adapter.base import AIProviderType, ModelResponse
from .common import InterruptedError, _preview_model_content
from .openai_chat_completions_provider import OpenAIChatCompletionsProvider

logger = logging.getLogger(__name__)


class OpenAIResponsesProvider(OpenAIChatCompletionsProvider):
    """使用 OpenAI 官方 Python SDK Responses API 的 Provider 实现。"""

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.OPENAI_RESPONSES

    def _build_responses_request(
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
        local_kwargs.pop('stop', None)
        thinking_budget_tokens = local_kwargs.pop('thinking_budget_tokens', None)
        _UNSET = object()
        reasoning_effort_raw = local_kwargs.pop('reasoning_effort', _UNSET)
        if reasoning_effort_raw is _UNSET:
            reasoning_effort = self.reasoning_effort
        else:
            reasoning_effort = reasoning_effort_raw

        model = model or self.get_model_for_task('chat')
        temperature = temperature if temperature is not None else self.temperature
        max_output_tokens = max_tokens if max_tokens is not None else self.max_completion_tokens

        input_messages = []
        for message in self._normalize_messages(messages):
            role = message.get('role')
            content = message.get('content')
            if isinstance(content, list):
                input_messages.append({'role': role, 'content': content})
            else:
                input_messages.append({'role': role, 'content': content or ''})

        payload: Dict[str, Any] = {
            'model': model,
            'input': input_messages,
            'temperature': temperature,
            'max_output_tokens': max_output_tokens,
        }
        if tools and self._should_attach_tools():
            payload['tools'] = tools
            if tool_choice:
                payload['tool_choice'] = tool_choice
        if response_format is not None:
            payload['text'] = response_format

        if reasoning_effort:
            payload['reasoning'] = {'effort': reasoning_effort}
        if thinking_budget_tokens is not None:
            payload['reasoning'] = {
                **payload.get('reasoning', {}),
                'max_output_tokens': thinking_budget_tokens,
            }

        payload.update({key: value for key, value in local_kwargs.items() if value is not None})
        return payload, cancel_event

    @staticmethod
    def _coerce_response_text(response: Any) -> str:
        output_text = getattr(response, 'output_text', None)
        if output_text:
            return output_text
        parts: List[str] = []
        for item in getattr(response, 'output', None) or []:
            for content in getattr(item, 'content', None) or []:
                text = getattr(content, 'text', None)
                if text:
                    parts.append(text)
        return ''.join(parts)

    @staticmethod
    def _extract_response_usage(usage_data: Any) -> Dict[str, int]:
        if usage_data is None:
            return {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
        input_tokens = getattr(usage_data, 'input_tokens', 0) or 0
        output_tokens = getattr(usage_data, 'output_tokens', 0) or 0
        total_tokens = getattr(usage_data, 'total_tokens', 0) or (input_tokens + output_tokens)
        usage = {
            'prompt_tokens': input_tokens,
            'completion_tokens': output_tokens,
            'total_tokens': total_tokens,
        }
        input_details = getattr(usage_data, 'input_tokens_details', None)
        cached_tokens = getattr(input_details, 'cached_tokens', 0) if input_details is not None else 0
        if cached_tokens:
            usage['cached_tokens'] = cached_tokens
        return usage

    def _extract_response_tool_calls(self, response: Any) -> Optional[List[Dict[str, Any]]]:
        tool_calls: List[Dict[str, Any]] = []
        for item in getattr(response, 'output', None) or []:
            item_type = getattr(item, 'type', None)
            if item_type not in ('function_call', 'tool_call'):
                continue
            tool_calls.append({
                'id': getattr(item, 'call_id', None) or getattr(item, 'id', None),
                'type': 'function',
                'function': {
                    'name': getattr(item, 'name', None),
                    'arguments': getattr(item, 'arguments', None) or '{}',
                },
            })
        return tool_calls or None

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
        request_kwargs, cancel_event = self._build_responses_request(
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
                lambda: self._get_client().responses.create(**request_kwargs),
                cancel_event,
            )
            content = self._coerce_response_text(response)
            usage = self._extract_response_usage(getattr(response, 'usage', None))
            selected_model = getattr(response, 'model', None) or request_kwargs['model']
            finish_reason = getattr(response, 'status', None) or 'stop'
            tool_calls = self._extract_response_tool_calls(response)
            if not content:
                logger.warning(
                    '[%s] OpenAI Responses returned empty content: model=%s finish_reason=%s has_tool_calls=%s',
                    self.name,
                    selected_model,
                    finish_reason,
                    bool(tool_calls),
                )
            else:
                logger.debug(
                    '[%s] OpenAI Responses returned content: model=%s finish_reason=%s has_xml=%s preview=%r',
                    self.name,
                    selected_model,
                    finish_reason,
                    ('<final_answer>' in content) or ('<tools>' in content) or ('<intent>' in content),
                    _preview_model_content(content),
                )
            latency = self._after_request(start_time)
            cost = self.calculate_cost(usage['prompt_tokens'], usage['completion_tokens'], selected_model)
            return ModelResponse(
                content=content or None,
                finish_reason=finish_reason,
                usage=usage,
                model=selected_model,
                provider=self.name,
                cost=cost,
                latency=latency,
                tool_calls=tool_calls,
            )
        except InterruptedError:
            logger.info('%s Responses 调用被用户中断', self.name)
            return ModelResponse(
                error='interrupted',
                model=request_kwargs['model'],
                provider=self.name,
                latency=self._after_request(start_time),
            )
        except Exception as error:
            logger.error('%s Responses 调用失败: %s', self.name, error)
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
        request_kwargs, cancel_event = self._build_responses_request(
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
        stream_has_content = False
        stream_chunk_count = 0
        stream_finish_reason = None
        try:
            if cancel_event is not None and cancel_event.is_set():
                yield {'content': '', 'finish_reason': 'interrupted'}
                return

            stream = self._get_client().responses.create(**request_kwargs)
            for event in stream:
                if cancel_event is not None and cancel_event.is_set():
                    if hasattr(stream, 'close'):
                        stream.close()
                    yield {'content': '', 'finish_reason': 'interrupted'}
                    return

                event_type = getattr(event, 'type', None) or ''
                delta = getattr(event, 'delta', None)
                if not delta and isinstance(event, dict):
                    delta = event.get('delta')
                    event_type = event_type or event.get('type', '')

                if event_type in ('response.output_text.delta', 'response.refusal.delta') and delta:
                    stream_has_content = True
                    stream_chunk_count += 1
                    logger.debug(
                        '[%s] OpenAI Responses stream content chunk: model=%s event=%s has_xml=%s preview=%r',
                        self.name,
                        request_kwargs['model'],
                        event_type,
                        ('<final_answer>' in delta) or ('<tools>' in delta) or ('<intent>' in delta),
                        _preview_model_content(delta),
                    )
                    yield {'content': delta, 'finish_reason': None}
                    continue

                if event_type in ('response.completed', 'response.failed', 'response.cancelled'):
                    stream_finish_reason = event_type.rsplit('.', 1)[-1]
                    logger.debug(
                        '[%s] OpenAI Responses stream finish event without content: model=%s finish_reason=%s chunks=%s',
                        self.name,
                        request_kwargs['model'],
                        stream_finish_reason,
                        stream_chunk_count,
                    )
                    yield {'content': '', 'finish_reason': stream_finish_reason}

            if not stream_has_content:
                logger.warning(
                    '[%s] OpenAI Responses stream completed without content: model=%s finish_reason=%s max_output_tokens=%s stop=%s',
                    self.name,
                    request_kwargs['model'],
                    stream_finish_reason,
                    request_kwargs.get('max_output_tokens'),
                    request_kwargs.get('stop'),
                )
        except InterruptedError:
            yield {'content': '', 'finish_reason': 'interrupted'}
        except Exception as error:
            logger.error('%s Responses 流式调用失败: %s', self.name, error)
            yield {'content': '', 'error': str(error), 'finish_reason': 'error'}
        finally:
            if stream is not None and hasattr(stream, 'close'):
                stream.close()
