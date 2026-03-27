# -*- coding: utf-8 -*-

import sys
import types
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from agents.context.compression_view import resolve_compression_view
from agents.context.config import ContextConfig
from agents.context.observation_formatters import BaseObservationFormatter, FormatContext
from agents.context.pipeline import ContextPipeline
from agents.context.prompt_materializer import PromptMaterializer
from agents.context.token_counter import TokenCounter
from agents.core.context import AgentContext
from agents.core.models import Message
from agents.monitoring.observation_window import ObservationWindowCollector
from tools.contracts.result_models import ToolExecutionResult


class _FakeConversationStore:
    def __init__(self, messages):
        self._messages = messages

    def get_recent_messages(self, session_id: str, limit: int = 50, thread_key=None):
        del session_id, limit, thread_key
        return list(self._messages)

    def get_session(self, session_id: str):
        del session_id
        return {"metadata": {}}


def _make_runtime_service(messages):
    import agents

    config_module = sys.modules.get("config")
    if config_module is None:
        config_module = types.ModuleType("config")
        config_module.get_config = lambda: None
        sys.modules["config"] = config_module

    model_adapter_module = sys.modules.get("model_adapter")
    if model_adapter_module is None:
        model_adapter_module = types.ModuleType("model_adapter")
        model_adapter_module.get_default_adapter = lambda: None
        sys.modules["model_adapter"] = model_adapter_module

    agents.get_config_manager = lambda: None

    from services.agent_api_runtime_service import AgentApiRuntimeService

    service = AgentApiRuntimeService(
        conversation_store=_FakeConversationStore(messages),
        task_registry_getter=lambda: None,
        session_manager_getter=lambda: None,
        session_application=object(),
        collaboration_application=object(),
        config_getter=lambda: None,
        config_manager_getter=lambda: None,
        default_adapter_getter=lambda: None,
    )
    service._memory_store.load_index_head = lambda **kwargs: f"# {kwargs.get('scope')} memory"
    service._memory_store.search_memories = lambda **kwargs: []
    return service


def _make_pipeline() -> ContextPipeline:
    return ContextPipeline(
        config=ContextConfig(max_tokens=1000),
        model_adapter=object(),
        get_llm_config_fn=lambda task_type=None: {},
    )


def test_resolve_compression_view_uses_replaces_up_to_seq_boundary():
    messages = [
        {"seq": 1, "role": "user", "content": "u1", "metadata": {}},
        {"seq": 2, "role": "assistant", "content": "a1", "metadata": {}},
        {
            "seq": 3,
            "role": "system",
            "content": "[历史摘要]\nold",
            "metadata": {"compression": True, "replaces_up_to_seq": 2},
        },
        {"seq": 4, "role": "user", "content": "u2", "metadata": {}},
    ]

    resolved = resolve_compression_view(messages)

    assert [item["content"] for item in resolved] == ["[历史摘要]\nold", "u2"]
    assert resolved[0]["metadata"] == {"compression": True}
    assert resolved[0]["seq"] == 3
    assert resolved[1]["seq"] == 4


def test_resolve_compression_view_prefers_in_memory_summary():
    messages = [
        {
            "seq": 10,
            "role": "system",
            "content": "[历史摘要]\npersisted",
            "metadata": {"compression": True, "replaces_up_to_seq": 8},
        },
        {"seq": 11, "role": "user", "content": "kept", "metadata": {}},
        {
            "seq": None,
            "role": "system",
            "content": "[历史摘要]\nin-memory",
            "metadata": {"compression": True},
        },
        {"seq": 12, "role": "assistant", "content": "after", "metadata": {}},
    ]

    resolved = resolve_compression_view(messages)

    assert [item["content"] for item in resolved] == ["[历史摘要]\nin-memory", "after"]
    assert resolved[0]["seq"] is None
    assert resolved[1]["seq"] == 12


def test_resolve_compression_view_tolerates_invalid_metadata_json():
    messages = [
        {"seq": 1, "role": "user", "content": "hello", "metadata": '{"compression": true'},
    ]

    resolved = resolve_compression_view(messages)

    assert resolved == messages


def test_load_history_into_context_preserves_seq():
    service = _make_runtime_service([
        {"seq": 7, "role": "user", "content": "hello", "metadata": {"x": 1}},
        {"seq": 8, "role": "assistant", "content": "world", "metadata": {}},
    ])
    context = AgentContext(session_id="s1")

    service.load_history_into_context(context, session_id="s1", limit=50)

    assert [message.seq for message in context.conversation_history] == [7, 8]
    assert context.conversation_history[0].metadata["x"] == 1


def test_load_history_into_context_keeps_react_intermediate_messages():
    service = _make_runtime_service([
        {"seq": 7, "role": "assistant", "content": "thought", "metadata": {"react_intermediate": True}},
        {"seq": 8, "role": "user", "content": "hello", "metadata": {}},
        {"seq": 9, "role": "assistant", "content": "world", "metadata": {}},
    ])
    context = AgentContext(session_id="s1")

    service.load_history_into_context(context, session_id="s1", limit=50)

    assert [message.seq for message in context.conversation_history] == [7, 8, 9]
    assert [message.content for message in context.conversation_history] == ["thought", "hello", "world"]


def test_build_context_injects_memory_indices_and_pipeline_exposes_memory_files():
    service = _make_runtime_service([])
    service._memory_store.search_memories = lambda **kwargs: [
        SimpleNamespace(
            name='用户偏好-最少代码',
            description='当前 session 中用户要求优先最少代码',
            scope='session',
            memory_type='preference',
            file_name='preference_用户偏好-最少代码.md',
            file_path='E:/Python/RAGSystem/backend-fastapi/data/memory/projects/backend-fastapi/sessions/s1/preference_用户偏好-最少代码.md',
        )
    ]
    context = service.build_context(session_id='s1', memory_query='最少代码')
    pipeline = _make_pipeline()

    prepared = pipeline.inspect_messages('sys', context)

    assert context.metadata['memory_indices']['project'] == '# project memory'
    assert context.metadata['memory_indices']['session'] == '# session memory'
    assert any('[Relevant Memory Files]' in item['content'] for item in prepared if item['role'] == 'system')


def test_pipeline_get_history_raw_uses_message_seq_only():
    pipeline = _make_pipeline()
    context = AgentContext(session_id="s1")
    context.conversation_history.append(
        Message(role="user", content="hello", metadata={"legacy": True}, seq=21)
    )

    history_raw = pipeline._get_history_raw(context)

    assert history_raw == [{
        "role": "user",
        "content": "hello",
        "metadata": {"legacy": True},
        "seq": 21,
    }]


def test_pipeline_write_back_context_preserves_seq():
    pipeline = _make_pipeline()
    context = AgentContext(session_id="s1")

    pipeline._write_back_context(context, [
        {"role": "system", "content": "[历史摘要]\n...", "metadata": {"compression": True}},
        {"role": "user", "content": "u", "metadata": {}, "seq": 31},
        {"role": "assistant", "content": "a", "metadata": {}, "seq": 32},
    ])

    assert [message.seq for message in context.conversation_history] == [None, 31, 32]
    assert context.get_history(limit=0)[1]["seq"] == 31


def test_prompt_materializer_text_observation_deduplicates_same_summary_and_content():
    materializer = PromptMaterializer()
    result = ToolExecutionResult(
        success=True,
        tool_name="call_agent",
        summary="kgqa_agent 并发调用成功",
        content="kgqa_agent 并发调用成功",
        output_type="text",
    )
    observation = materializer.materialize_tool_observation(
        result,
        SimpleNamespace(mode="inline", artifact_ttl_seconds=None),
        tool_name="call_agent",
        is_skills_tool=False,
        session_id="s1",
    )

    assert observation == "✅ kgqa_agent 并发调用成功"


def test_prompt_materializer_json_observation_exposes_child_agent_id():
    materializer = PromptMaterializer()
    result = ToolExecutionResult(
        success=True,
        tool_name="call_agent",
        summary="ok",
        content={"answer": "ok"},
        output_type="json",
        metadata={"child_agent_id": "child-123"},
    )
    observation = materializer.materialize_tool_observation(
        result,
        SimpleNamespace(mode="inline", artifact_ttl_seconds=None),
        tool_name="call_agent",
        is_skills_tool=False,
        session_id="s1",
    )

    assert "child_agent_id: child-123" in observation


    class _DemoFormatter(BaseObservationFormatter):
        name = "demo"
        priority = 1

        def can_handle(self, result: ToolExecutionResult, context: FormatContext) -> bool:
            return context.tool_name == "demo_tool"

        def format(self, result: ToolExecutionResult, context: FormatContext) -> str:
            return "demo"

    formatter_a = PromptMaterializer()
    formatter_b = PromptMaterializer()

    formatter_a.register_formatter(_DemoFormatter())

    assert "demo" in formatter_a.list_formatters()
    assert "demo" not in formatter_b.list_formatters()


def test_pipeline_records_compression_without_post_compression_trim():
    temp_dir = tempfile.mkdtemp(dir=Path(__file__).resolve().parent)
    collector = ObservationWindowCollector(
        storage_path=Path(temp_dir) / "observation_window.json",
        persist_interval_seconds=0.0,
    )
    collector.reset()

    class _SummaryAdapter:
        def chat_completion(self, **kwargs):
            del kwargs
            return SimpleNamespace(content="summary", error=None)

    pipeline = ContextPipeline(
        config=ContextConfig(
            max_tokens=40,
            compression_trigger_ratio=0.1,
            preserve_recent_turns=1,
        ),
        model_adapter=_SummaryAdapter(),
        get_llm_config_fn=lambda task_type=None: {"provider": "demo", "provider_type": "demo"},
        observation_window=collector,
    )

    context = AgentContext(session_id="s1")
    context.conversation_history.extend([
        Message(role="user", content="hello " * 20, metadata={}, seq=1),
        Message(role="assistant", content="world " * 20, metadata={}, seq=2),
        Message(role="user", content="again " * 20, metadata={}, seq=3),
        Message(role="assistant", content="reply " * 20, metadata={}, seq=4),
    ])

    try:
        pipeline.prepare_messages(
            system_prompt="system",
            context=context,
            current_session=[{"role": "user", "content": "current " * 30}],
        )

        report = collector.build_report()
        assert report["compression_stats"]["attempts"] == 1
        assert report["compression_stats"]["successes"] == 1
        assert report["trim_stats"]["events"] == 0
        assert report["trim_stats"]["trimmed_messages"] == 0
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_pipeline_does_not_trim_current_session_when_no_compression_happens():
    temp_dir = tempfile.mkdtemp(dir=Path(__file__).resolve().parent)
    collector = ObservationWindowCollector(
        storage_path=Path(temp_dir) / "observation_window.json",
        persist_interval_seconds=0.0,
    )
    collector.reset()

    pipeline = ContextPipeline(
        config=ContextConfig(
            max_tokens=40,
            compression_trigger_ratio=10.0,
            preserve_recent_turns=1,
        ),
        model_adapter=object(),
        get_llm_config_fn=lambda task_type=None: {},
        observation_window=collector,
    )

    context = AgentContext(session_id="s1")
    context.conversation_history.extend([
        Message(role="user", content="short", metadata={}, seq=1),
        Message(role="assistant", content="reply", metadata={}, seq=2),
    ])

    try:
        messages = pipeline.prepare_messages(
            system_prompt="system",
            context=context,
            current_session=[
                {"role": "user", "content": "x " * 200},
            ],
        )

        report = collector.build_report()
        assert report["compression_stats"]["attempts"] == 0
        assert report["trim_stats"]["events"] == 0
        assert report["trim_stats"]["trimmed_messages"] == 0
        assert messages == [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "short", "metadata": {}, "seq": 1},
            {"role": "assistant", "content": "reply", "metadata": {}, "seq": 2},
            {"role": "user", "content": "x " * 200},
        ]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_pipeline_falls_back_to_truncate_when_compression_summary_fails():
    pipeline = ContextPipeline(
        config=ContextConfig(
            max_tokens=40,
            compression_trigger_ratio=0.1,
            preserve_recent_turns=1,
        ),
        model_adapter=object(),
        get_llm_config_fn=lambda task_type=None: {},
    )
    context = AgentContext(session_id="s1")
    context.conversation_history.extend([
        Message(role="user", content="hello " * 20, metadata={}, seq=1),
        Message(role="assistant", content="world " * 20, metadata={}, seq=2),
        Message(role="user", content="again " * 20, metadata={}, seq=3),
        Message(role="assistant", content="reply " * 20, metadata={}, seq=4),
    ])

    result = pipeline.prepare_messages(
        system_prompt="system",
        context=context,
        current_session=[{"role": "user", "content": "current " * 30}],
    )
    # 降级后应包含 fallback 摘要标记
    fallback_msgs = [m for m in result if "LLM 摘要不可用" in (m.get("content") or "")]
    assert len(fallback_msgs) == 1
    assert fallback_msgs[0]["role"] == "assistant"


def test_token_counter_supports_content_blocks():
    counter = TokenCounter(model_name='claude-sonnet-4-5')

    total = counter.count_messages([
        {
            'role': 'user',
            'content': [
                {'type': 'text', 'text': 'hello'},
                {'type': 'text', 'text': 'world'},
            ],
        }
    ])

    assert total > 0


def test_pipeline_applies_anthropic_cache_policy_only_to_stable_prefix():
    class _Provider:
        supports_prompt_caching = True
        prompt_cache_style = 'anthropic'
        prompt_cache_min_tokens = 0

    class _Adapter:
        def get_provider(self, provider_name, provider_type=None):
            del provider_name, provider_type
            return _Provider()

    pipeline = ContextPipeline(
        config=ContextConfig(max_tokens=1000),
        model_adapter=_Adapter(),
        get_llm_config_fn=lambda task_type=None: {},
    )
    context = AgentContext(session_id='s1')
    context.conversation_history.extend([
        Message(role='assistant', content='[历史摘要]\nsummary', metadata={'compression': True}, seq=1),
        Message(role='user', content='old user', metadata={}, seq=2),
        Message(role='assistant', content='old answer', metadata={}, seq=3),
    ])

    messages = pipeline.prepare_messages(
        system_prompt='system rules',
        context=context,
        current_session=[{'role': 'user', 'content': 'current question'}],
        llm_config={'provider': 'anthropic', 'provider_type': 'anthropic'},
    )

    assert messages[0]['metadata']['prompt_cache']['style'] == 'anthropic'
    assert messages[1]['metadata']['prompt_cache']['style'] == 'anthropic'
    assert messages[2]['metadata']['prompt_cache']['style'] == 'anthropic'
    assert 'prompt_cache' not in (messages[3].get('metadata') or {})
    assert 'metadata' not in messages[-1] or 'prompt_cache' not in messages[-1].get('metadata', {})
