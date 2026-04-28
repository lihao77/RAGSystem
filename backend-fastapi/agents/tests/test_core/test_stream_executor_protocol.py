# -*- coding: utf-8 -*-

import pytest

from agents.streaming.stream_executor import StreamExecutor


class _FakeModelAdapter:
    def __init__(self, chunks):
        self._chunks = chunks

    def chat_completion_stream(self, **kwargs):
        del kwargs
        for chunk in self._chunks:
            yield {"content": chunk}


class _FakePublisher:
    def __init__(self):
        self.chunks = []
        self.tool_errors = []
        self.first_tokens = []

    def llm_first_token(self, **kwargs):
        self.first_tokens.append(kwargs)

    def intent_delta(self, content, round=None, agent_display_name=None):
        del content, round, agent_display_name

    def intent_complete(self, content, round=None, agent_display_name=None):
        del content, round, agent_display_name

    def chunk(self, content):
        self.chunks.append(content)

    def tool_error(self, tool_name, error):
        self.tool_errors.append((tool_name, error))


def test_stream_executor_emits_llm_first_token_once_before_semantic_chunk(monkeypatch):
    timestamps = iter([10.0, 10.2, 10.3])
    monkeypatch.setattr("agents.streaming.stream_executor.time.time", lambda: next(timestamps))
    publisher = _FakePublisher()
    executor = StreamExecutor(
        model_adapter=_FakeModelAdapter(["<intent>先想", "一下</intent><final_answer>完成</final_answer>"]),
        publisher=publisher,
    )

    result = executor.execute_llm_stream(
        messages=[{"role": "user", "content": "test"}],
        llm_config={"provider": "p", "provider_type": "openai", "model_name": "m"},
        round_num=3,
    )

    assert result.answer == "完成"
    assert len(publisher.first_tokens) == 1
    assert publisher.first_tokens[0]["round"] == 3
    assert publisher.first_tokens[0]["provider"] == "p"
    assert publisher.first_tokens[0]["provider_type"] == "openai"
    assert publisher.first_tokens[0]["model"] == "m"
    assert publisher.first_tokens[0]["elapsed_ms"] == pytest.approx(200, abs=1)
    assert publisher.first_tokens[0]["content_length"] == len("<intent>先想")
    assert "content" not in publisher.first_tokens[0]


def test_stream_executor_ignores_empty_chunks_for_llm_first_token():
    publisher = _FakePublisher()
    executor = StreamExecutor(
        model_adapter=type('EmptyAwareAdapter', (), {
            'chat_completion_stream': staticmethod(lambda **kwargs: iter([
                {'content': ''},
                {'usage': {'cached_tokens': 10}},
                {'content': '<final_answer>完成</final_answer>'},
            ]))
        })(),
        publisher=publisher,
    )

    result = executor.execute_llm_stream(
        messages=[{"role": "user", "content": "test"}],
        llm_config={},
        round_num=1,
    )

    assert result.answer == "完成"
    assert len(publisher.first_tokens) == 1


    executor = StreamExecutor(
        model_adapter=_FakeModelAdapter(["<final_answer>完成</final_answer>"]),
        publisher=_FakePublisher(),
    )

    result = executor.execute_llm_stream(
        messages=[{"role": "user", "content": "test"}],
        llm_config={},
        round_num=1,
    )

    assert result.answer == "完成"


def test_stream_executor_records_first_token_time(monkeypatch):
    timestamps = iter([10.0, 10.05])
    monkeypatch.setattr("agents.streaming.stream_executor.time.time", lambda: next(timestamps))
    executor = StreamExecutor(
        model_adapter=_FakeModelAdapter(["<intent>先想</intent><final_answer>首个 token</final_answer>"]),
        publisher=_FakePublisher(),
    )

    result = executor.execute_llm_stream(
        messages=[{"role": "user", "content": "test"}],
        llm_config={},
        round_num=1,
    )

    assert result.answer == "首个 token"
    assert result.first_token_time == pytest.approx(0.05)


def test_stream_executor_ignores_usage_metadata_chunks():
    executor = StreamExecutor(
        model_adapter=_FakeModelAdapter(["<final_answer>完成</final_answer>"]),
        publisher=_FakePublisher(),
    )
    executor.model_adapter = type('UsageAwareAdapter', (), {
        'chat_completion_stream': staticmethod(lambda **kwargs: iter([
            {'content': '<final_answer>完', 'usage': {'cached_tokens': 10}},
            {'content': '成</final_answer>', 'finish_reason': 'stop', 'usage': {'cached_tokens': 10}},
        ]))
    })()

    result = executor.execute_llm_stream(
        messages=[{"role": "user", "content": "test"}],
        llm_config={},
        round_num=1,
    )

    assert result.answer == "完成"


def test_stream_executor_keeps_legacy_answer_tag_compatible():
    executor = StreamExecutor(
        model_adapter=_FakeModelAdapter(["<answer>兼容</answer>"]),
        publisher=_FakePublisher(),
    )

    result = executor.execute_llm_stream(
        messages=[{"role": "user", "content": "test"}],
        llm_config={},
        round_num=1,
    )

    assert result.answer == "兼容"
