# -*- coding: utf-8 -*-
import logging
import shutil
import tempfile
from types import MethodType, SimpleNamespace
from pathlib import Path

from agents.core import AgentContext, AgentResponse, BaseAgent
from agents.context.config import ContextConfig
from agents.context.observation_policy import ObservationPolicy
from agents.context.prompt_materializer import PromptMaterializer
from agents.implementations.orchestrator.agent import OrchestratorAgent
from agents.artifacts import ArtifactStore
from tools.runtime.result_normalizer import ToolResultNormalizer
from tools.runtime.response_builder import success_result


class _DummyPublisher:
    def __init__(self):
        self.calls = []

    def run_start(self, **kwargs):
        self.calls.append(("run_start", kwargs))

    def agent_call_start(self, **kwargs):
        self.calls.append(("agent_call_start", kwargs))

    def agent_start(self, *args, **kwargs):
        self.calls.append(("agent_start", {"args": args, "kwargs": kwargs}))

    def agent_error(self, **kwargs):
        self.calls.append(("agent_error", kwargs))

    def run_end(self, **kwargs):
        self.calls.append(("run_end", kwargs))


def _make_uninitialized_orchestrator() -> OrchestratorAgent:
    agent = OrchestratorAgent.__new__(OrchestratorAgent)
    agent.name = "orchestrator_agent"
    agent.display_name = "Orchestrator Agent"
    agent.logger = logging.getLogger("tests.orchestrator")
    agent.max_rounds = 15
    agent._publisher = None
    return agent


def test_orchestrator_prepare_execution_state_preserves_start_time():
    agent = _make_uninitialized_orchestrator()

    def _resolve_event_bus(self, context):
        del context
        return None

    def _ensure_publisher(self, context, **kwargs):
        del context, kwargs
        self._publisher = _DummyPublisher()
        return self._publisher

    agent._resolve_event_bus = MethodType(_resolve_event_bus, agent)
    agent._ensure_publisher = MethodType(_ensure_publisher, agent)

    context = SimpleNamespace(metadata={}, session_id="session-1")
    state = agent._prepare_execution_state("test task", context, 12.5)

    assert state["start_time"] == 12.5
    assert state["call_id"].startswith("call_")
    assert state["run_id"]


def test_prepare_execution_state_injects_current_attachments_into_current_session():
    agent = _make_uninitialized_orchestrator()

    def _resolve_event_bus(self, context):
        del context
        return None

    def _ensure_publisher(self, context, **kwargs):
        del context, kwargs
        return None

    agent._resolve_event_bus = MethodType(_resolve_event_bus, agent)
    agent._ensure_publisher = MethodType(_ensure_publisher, agent)

    context = SimpleNamespace(
        metadata={
            'current_attachments': [
                {
                    'file_id': 'file-1',
                    'mime': 'image/png',
                    'original_name': 'demo.png',
                    'stored_path': '/tmp/demo.png',
                    'kind': 'image',
                },
                {
                    'file_id': 'file-2',
                    'mime': 'text/plain',
                    'original_name': 'notes.txt',
                    'stored_path': '/tmp/notes.txt',
                    'kind': 'file',
                    'size': 128,
                },
            ]
        },
        session_id='session-1',
    )

    state = agent._prepare_execution_state('look at image and file', context, 1.0)

    assert state['current_session'] == [
        {
            'role': 'user',
            'content': 'look at image and file\n\n[普通文件附件引用]\n- file_id=file-2 | name=notes.txt | mime=text/plain | size=128 | file_path=/tmp/notes.txt',
            'metadata': {
                'attachments': [
                    {
                        'file_id': 'file-1',
                        'mime': 'image/png',
                        'original_name': 'demo.png',
                        'stored_path': '/tmp/demo.png',
                        'kind': 'image',
                    }
                ],
                'file_references': [
                    {
                        'file_id': 'file-2',
                        'mime': 'text/plain',
                        'original_name': 'notes.txt',
                        'stored_path': '/tmp/notes.txt',
                        'kind': 'file',
                        'size': 128,
                    }
                ],
            },
        }
    ]


def test_orchestrator_handle_execution_error_tolerates_incomplete_state():
    agent = _make_uninitialized_orchestrator()
    agent._publisher = _DummyPublisher()

    response = agent._handle_execution_error(
        RuntimeError("boom"),
        AgentContext(session_id="session-1"),
        {},
        1.0,
    )

    assert response.success is False
    assert response.error == "boom"


class _BrokenErrorHandlerAgent(BaseAgent):
    def __init__(self):
        super().__init__(name="broken", description="broken")
        self.logger = logging.getLogger("tests.broken")

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        return self._execute_react_task(task, context)

    def _build_system_prompt(self) -> str:
        return "test"

    def _prepare_execution_state(self, task, context, start_time):
        del task, context, start_time
        raise RuntimeError("prepare failed")

    def _handle_execution_error(self, error, context, state, start_time):
        del error, context, state, start_time
        raise RuntimeError("secondary failure")


def test_base_execute_react_task_falls_back_when_error_handler_raises():
    agent = _BrokenErrorHandlerAgent()

    response = agent.execute("task", AgentContext(session_id="session-1"))

    assert response.success is False
    assert response.error == "prepare failed"


def test_base_format_tool_observation_prefers_policy_materializer_chain():
    tmp_dir = Path(tempfile.mkdtemp(prefix="react_runtime_", dir=Path(__file__).parent))
    agent = SimpleNamespace(
        result_normalizer=ToolResultNormalizer(),
        observation_policy=ObservationPolicy(
            max_context_tokens=8000,
            inline_text_limit=100,
            inline_json_limit=100,
            summarize_limit=200,
        ),
        prompt_materializer=PromptMaterializer(
            artifact_store=ArtifactStore(base_dir=str(tmp_dir / "temp_data")),
            large_data_threshold=200,
        ),
    )

    try:
        observation = BaseAgent._format_tool_observation(
            agent,
            success_result("hello", summary="读取成功", tool_name="read_file"),
            tool_name="read_file",
            session_id="session-1",
        )
        assert observation == "✅ 读取成功\n\nhello"
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


class _PlaceholderAwareAgent(BaseAgent):
    def __init__(self):
        super().__init__(name="placeholder_aware", description="placeholder aware")
        self.logger = logging.getLogger("tests.placeholder_aware")
        self.agent_config = None
        self._publisher = None

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        del task, context
        raise NotImplementedError

    def _resolve_references(self, arguments, results_snapshot, current_idx):
        del current_idx
        from tools.refs.result_references import resolve_result_path, stringify_result_value, result_primary_content

        resolved = {}
        for key, value in arguments.items():
            if isinstance(value, str) and value.startswith("{") and value.endswith("}") and value[1:-1].lower().startswith("result_"):
                placeholder = value[1:-1]
                prefix, _, path = placeholder.partition(".")
                result_idx = int(prefix.lower().replace("result_", ""))
                resolved_value = (
                    result_primary_content(results_snapshot[result_idx])
                    if not path
                    else resolve_result_path(
                        results_snapshot[result_idx],
                        path,
                        prefer_primary_content_root=True,
                        case_insensitive=True,
                    )
                )
                resolved[key] = stringify_result_value(resolved_value) if not path else resolved_value
            else:
                resolved[key] = value
        return resolved

    def _format_tool_observation(self, result, **kwargs):
        del kwargs
        return str(result.content)


def test_base_handle_actions_passes_run_id_to_execute_tool(monkeypatch):
    import tools.runtime.executor as tool_executor

    captured_kwargs = []

    def fake_execute_tool(tool_name, arguments, **kwargs):
        del tool_name, arguments
        captured_kwargs.append(kwargs)
        return success_result(
            content="ok",
            summary="ok",
            output_type="text",
            tool_name="write_file",
        )

    monkeypatch.setattr(tool_executor, "execute_tool", fake_execute_tool)

    agent = _PlaceholderAwareAgent()
    context = AgentContext(session_id="session-1")
    context.metadata["run_id"] = "run-direct-1"
    state = {
        "event_bus": None,
        "tool_calls_history": [],
        "current_session": [],
    }
    actions = [
        {"tool": "write_file", "arguments": {"content": "demo"}},
    ]

    agent._handle_actions(actions, context, state, rounds=1, log_prefix="[test]")

    assert captured_kwargs[0]["session_id"] == "session-1"
    assert captured_kwargs[0]["run_id"] == "run-direct-1"


def test_base_handle_actions_resolves_same_round_tool_placeholders(monkeypatch):
    import tools.runtime.executor as tool_executor

    captured_arguments = []

    def fake_execute_tool(tool_name, arguments, **kwargs):
        del kwargs
        captured_arguments.append((tool_name, arguments))
        if tool_name == "write_file":
            return success_result(
                content={"file_path": "E:/tmp/generated.json"},
                summary="ok",
                output_type="json",
                tool_name=tool_name,
            )
        return success_result(
            content="read ok",
            summary="ok",
            output_type="text",
            tool_name=tool_name,
        )

    monkeypatch.setattr(tool_executor, "execute_tool", fake_execute_tool)

    agent = _PlaceholderAwareAgent()
    context = AgentContext(session_id="session-1")
    state = {
        "event_bus": None,
        "tool_calls_history": [],
        "current_session": [],
    }
    actions = [
        {"tool": "write_file", "arguments": {"content": '{"name":"demo"}'}},
        {"tool": "read_file", "arguments": {"file_path": "{result_1.content.file_path}"}},
    ]

    agent._handle_actions(actions, context, state, rounds=1, log_prefix="[test]")

    assert captured_arguments[1][0] == "read_file"
    assert captured_arguments[1][1]["file_path"] == "E:/tmp/generated.json"


def test_handle_actions_returns_waiting_request_when_tool_suggests_wait(monkeypatch):
    import tools.runtime.executor as tool_executor

    def fake_execute_tool(tool_name, arguments, **kwargs):
        del tool_name, arguments, kwargs
        return success_result(
            content={
                "background_task_id": "bg-1",
                "suggest_wait": True,
            },
            summary="后台任务已启动",
            output_type="json",
            tool_name="execute_bash",
        )

    monkeypatch.setattr(tool_executor, "execute_tool", fake_execute_tool)

    agent = _PlaceholderAwareAgent()
    context = AgentContext(session_id="session-1")
    state = {
        "event_bus": None,
        "tool_calls_history": [],
        "current_session": [],
        "run_id": "run-1",
    }

    waiting_request = agent._handle_actions(
        [{"tool": "execute_bash", "arguments": {"command": "sleep 1"}}],
        context,
        state,
        rounds=1,
        log_prefix="[test]",
    )

    assert waiting_request is not None
    assert waiting_request.background_task_ids == ["bg-1"]
    assert waiting_request.run_id == "run-1"


def test_run_hidden_keepalive_respects_disabled_config():
    agent = _PlaceholderAwareAgent()
    chat_calls = []
    agent.model_adapter = SimpleNamespace(
        chat_completion=lambda **kwargs: chat_calls.append(kwargs),
    )
    agent.context_pipeline = SimpleNamespace(
        config=ContextConfig(
            allow_provider_keepalive=False,
            hidden_keepalive_token_budget=11,
        ),
        prepare_execution_messages=lambda **kwargs: SimpleNamespace(messages=[]),
        _session_cache=lambda context: context.metadata.setdefault("_cache", {}),
    )
    agent.get_llm_config = lambda context, task_type=None: {"provider": "demo", "model_name": "x"}
    agent._build_system_prompt = lambda: "system"

    context = AgentContext(session_id="session-1")
    state = {"current_session": []}

    agent._run_hidden_keepalive(context, state, "[test]")

    assert chat_calls == []
    assert context.metadata.get("_cache") is None


def test_run_hidden_keepalive_uses_context_budget_and_refreshes_cache():
    agent = _PlaceholderAwareAgent()
    chat_calls = []
    agent.model_adapter = SimpleNamespace(
        chat_completion=lambda **kwargs: chat_calls.append(kwargs) or SimpleNamespace(error=None),
    )
    agent.context_pipeline = SimpleNamespace(
        config=ContextConfig(
            allow_provider_keepalive=True,
            hidden_keepalive_token_budget=11,
        ),
        prepare_execution_messages=lambda **kwargs: SimpleNamespace(messages=[{"role": "system", "content": "s"}]),
        _session_cache=lambda context: context.metadata.setdefault("_cache", {}),
    )
    agent.get_llm_config = lambda context, task_type=None: {
        "provider": "demo",
        "model_name": "x",
        "provider_type": "test",
    }
    agent._build_system_prompt = lambda: "system"

    context = AgentContext(session_id="session-1")
    state = {"current_session": []}

    agent._run_hidden_keepalive(context, state, "[test]")

    assert len(chat_calls) == 1
    assert chat_calls[0]["max_tokens"] == 11
    assert context.metadata["_cache"]["t"] > 0


def test_waiting_enabled_false_skips_waiting_loop_gate():
    agent = _PlaceholderAwareAgent()
    agent.context_pipeline = SimpleNamespace(config=ContextConfig(waiting_enabled=False))

    waiting_request = SimpleNamespace(background_task_ids=["bg-1"])
    should_wait = (
        agent.context_pipeline.config.waiting_enabled
        and waiting_request
        and waiting_request.background_task_ids
    )

    assert should_wait is False
