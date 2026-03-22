# -*- coding: utf-8 -*-

from model_adapter.base import AIProvider, AIProviderType, EmbeddingResponse, ModelResponse


class _RetryProbeProvider(AIProvider):
    def __init__(self, stream_attempts):
        super().__init__(
            name="RetryProbe",
            api_key="demo",
            api_endpoint="https://example.com",
            model="demo-model",
            retry_attempts=2,
            retry_delay=0,
            retry_backoff_factor=1,
        )
        self._stream_attempts = list(stream_attempts)
        self.stream_calls = 0

    def _do_chat_completion(self, messages, model=None, temperature=None, max_tokens=None, tools=None, tool_choice=None, **kwargs):
        del messages, model, temperature, max_tokens, tools, tool_choice, kwargs
        return ModelResponse(content="ok", provider=self.name)

    def _do_chat_completion_stream(self, messages, model=None, temperature=None, max_tokens=None, **kwargs):
        del messages, model, temperature, max_tokens, kwargs
        self.stream_calls += 1
        for chunk in self._stream_attempts[self.stream_calls - 1]:
            yield chunk

    def generate_text(self, prompt, model=None, temperature=None, max_tokens=None, **kwargs):
        del prompt, model, temperature, max_tokens, kwargs
        return ModelResponse(content="ok", provider=self.name)

    def embed(self, texts, model=None, dimensions=None, **kwargs):
        del texts, model, dimensions, kwargs
        return EmbeddingResponse(embeddings=[], provider=self.name)

    def _get_provider_type(self):
        return AIProviderType.CUSTOM

    def get_model_list(self):
        return ["demo-model"]

    def calculate_cost(self, input_tokens, output_tokens, model):
        del input_tokens, output_tokens, model
        return 0.0

    def is_available(self):
        return True


def test_retryable_error_detects_incomplete_chunked_read():
    error = "peer closed connection without sending complete message body (incomplete chunked read)"

    assert AIProvider._is_retryable_error(error) is True


def test_stream_retries_on_incomplete_chunked_read_before_first_chunk():
    provider = _RetryProbeProvider(
        stream_attempts=[
            [
                {
                    "content": "",
                    "error": "peer closed connection without sending complete message body (incomplete chunked read)",
                    "finish_reason": "error",
                }
            ],
            [
                {
                    "content": "<final_answer>ok</final_answer>",
                    "finish_reason": "stop",
                }
            ],
        ]
    )

    chunks = list(provider.chat_completion_stream(messages=[{"role": "user", "content": "hello"}]))

    assert provider.stream_calls == 2
    assert chunks == [{"content": "<final_answer>ok</final_answer>", "finish_reason": "stop"}]
