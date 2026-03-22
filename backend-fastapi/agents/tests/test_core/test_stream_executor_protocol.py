# -*- coding: utf-8 -*-

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

    def intent_delta(self, content, round=None):
        del content, round

    def intent_complete(self, content, round=None):
        del content, round

    def chunk(self, content):
        self.chunks.append(content)

    def tool_error(self, tool_name, error):
        self.tool_errors.append((tool_name, error))


def test_stream_executor_supports_final_answer_tag():
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
