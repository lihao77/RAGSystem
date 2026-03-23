# -*- coding: utf-8 -*-
import logging
import shutil
import tempfile
from types import MethodType, SimpleNamespace
from pathlib import Path

from agents.core import AgentContext, AgentResponse, BaseAgent
from agents.context.observation_policy import ObservationPolicy
from agents.context.prompt_materializer import PromptMaterializer
from agents.implementations.orchestrator.agent import OrchestratorAgent
from agents.artifacts import ArtifactStore
from tools.result_normalizer import ToolResultNormalizer
from tools.response_builder import success_result


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

    def _resolve_tool_references(self, arguments, tool_results, current_idx):
        from agents.implementations.react.agent import ReActAgent

        return ReActAgent._resolve_tool_references(self, arguments, tool_results, current_idx)

    def _format_tool_observation(self, result, **kwargs):
        del kwargs
        return str(result.content)


def test_base_handle_actions_passes_run_id_to_execute_tool(monkeypatch):
    from tools import tool_executor

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
    from tools import tool_executor

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
        {"tool": "read_document", "arguments": {"file_path": "{result_1.content.file_path}"}},
    ]

    agent._handle_actions(actions, context, state, rounds=1, log_prefix="[test]")

    assert captured_arguments[1][0] == "read_document"
    assert captured_arguments[1][1]["file_path"] == "E:/tmp/generated.json"
