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

    def tool_call_start(self, **kwargs):
        self.calls.append(("tool_call_start", kwargs))

    def tool_call_end(self, **kwargs):
        self.calls.append(("tool_call_end", kwargs))

    def final_answer(self, *args, **kwargs):
        self.calls.append(("final_answer", {"args": args, "kwargs": kwargs}))

    def agent_end(self, **kwargs):
        self.calls.append(("agent_end", kwargs))

    def agent_call_end(self, **kwargs):
        self.calls.append(("agent_call_end", kwargs))

    def session_end(self, **kwargs):
        self.calls.append(("session_end", kwargs))

    def react_intermediate(self, **kwargs):
        self.calls.append(("react_intermediate", kwargs))

    def execution_waiting_start(self, **kwargs):
        self.calls.append(("execution_waiting_start", kwargs))

    def execution_waiting_end(self, **kwargs):
        self.calls.append(("execution_waiting_end", kwargs))

    def execution_waiting_timeout(self, **kwargs):
        self.calls.append(("execution_waiting_timeout", kwargs))


def _make_uninitialized_orchestrator() -> OrchestratorAgent:
    agent = OrchestratorAgent.__new__(OrchestratorAgent)
    agent.name = "orchestrator_agent"
    agent.display_name = "Orchestrator Agent"
    agent.logger = logging.getLogger("tests.orchestrator")
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


def test_handle_final_answer_publishes_execution_time_metadata(monkeypatch):
    agent = _make_uninitialized_orchestrator()
    publisher = _DummyPublisher()
    state = {
        "publisher": publisher,
        "rounds": 2,
        "tool_calls_history": [],
        "current_session": [],
    }

    monkeypatch.setattr("agents.core.base.time.time", lambda: 13.5)
    response = agent._handle_final_answer(
        "final answer",
        AgentContext(session_id="session-1"),
        state,
        10.0,
        0.7,
    )

    final_answer_call = next(item for item in publisher.calls if item[0] == "final_answer")
    assert final_answer_call[1]["kwargs"]["metadata"]["execution_time"] == 3.5
    assert final_answer_call[1]["kwargs"]["metadata"]["first_token_time"] == 0.7
    assert response.execution_time == 3.5
    assert response.metadata["execution_time"] == 3.5
    assert response.metadata["first_token_time"] == 0.7


def test_cleanup_execution_publishes_run_end_timing_metadata(monkeypatch):
    agent = _make_uninitialized_orchestrator()
    publisher = _DummyPublisher()
    state = {
        "publisher": publisher,
        "run_id": "run-1",
        "start_time": 10.0,
        "_first_token_time": 0.8,
        "_run_status": "success",
        "_run_summary": "done",
    }

    monkeypatch.setattr("agents.core.base.time.time", lambda: 13.25)
    agent._cleanup_execution(AgentContext(session_id="session-1"), state)

    run_end_call = next(item for item in publisher.calls if item[0] == "run_end")
    assert run_end_call[1]["metadata"]["execution_time"] == 3.25
    assert run_end_call[1]["metadata"]["first_token_time"] == 0.8
    assert run_end_call[1]["metadata"]["agent_name"] == "orchestrator_agent"

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
        assert observation == "读取成功\n\nhello"
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
    assert waiting_request.timeout_ms is None
    assert state["current_session"] == []




def test_handle_actions_captures_wait_timeout_from_task_output(monkeypatch):
    import tools.runtime.executor as tool_executor

    def fake_execute_tool(tool_name, arguments, **kwargs):
        del tool_name, arguments, kwargs
        return success_result(
            content={
                "background_task_id": "bg-2",
                "suggest_wait": True,
                "wait_timeout_ms": 42000,
            },
            summary="后台任务等待中",
            output_type="json",
            tool_name="task_output",
        )

    monkeypatch.setattr(tool_executor, "execute_tool", fake_execute_tool)

    agent = _PlaceholderAwareAgent()
    context = AgentContext(session_id="session-1")
    state = {
        "event_bus": None,
        "tool_calls_history": [],
        "current_session": [],
        "run_id": "run-2",
    }

    waiting_request = agent._handle_actions(
        [{"tool": "task_output", "arguments": {"task_id": "bg-2", "block": True}}],
        context,
        state,
        rounds=1,
        log_prefix="[test]",
    )

    assert waiting_request is not None
    assert waiting_request.background_task_ids == ["bg-2"]
    assert waiting_request.timeout_ms == 42000
    assert state["current_session"] == []


def test_handle_actions_keeps_completed_task_output_observation(monkeypatch):
    import tools.runtime.executor as tool_executor

    def fake_execute_tool(tool_name, arguments, **kwargs):
        del tool_name, arguments, kwargs
        return success_result(
            content={
                "task_id": "bg-3",
                "status": "completed",
                "completed": True,
                "output": {"result": 42},
            },
            summary="后台任务 bg-3 已完成，状态：completed",
            output_type="json",
            tool_name="task_output",
        )

    monkeypatch.setattr(tool_executor, "execute_tool", fake_execute_tool)

    agent = _PlaceholderAwareAgent()
    context = AgentContext(session_id="session-1")
    state = {
        "event_bus": None,
        "tool_calls_history": [],
        "current_session": [],
        "run_id": "run-3",
    }

    waiting_request = agent._handle_actions(
        [{"tool": "task_output", "arguments": {"task_id": "bg-3", "block": True}}],
        context,
        state,
        rounds=1,
        log_prefix="[test]",
    )

    assert waiting_request is None
    assert state["current_session"] == [
        {
            "role": "user",
            "content": "[task_output]\n{'task_id': 'bg-3', 'status': 'completed', 'completed': True, 'output': {'result': 42}}",
        }
    ]



def test_run_waiting_loop_emits_start_and_end_for_completed_task(monkeypatch):
    import threading
    import agents.task_registry as task_registry_module
    import tools.runtime.background_tasks as bg_tasks_module
    from agents.core.base import WaitingRequest

    class _DoneTask:
        status = 'completed'
        return_code = 0
        result_type = 'text'
        output_path = None
        completed_at = 123.0

        def is_done(self):
            return True

    class _Registry:
        def __init__(self):
            self.resolved = []
            self.cleared = []

        def add_task_pending_wait(self, task_id, wait_id, bg_wait_state):
            del task_id, wait_id, bg_wait_state
            return threading.Event()

        def resolve_task_wait(self, task_id, wait_id, payload):
            self.resolved.append((task_id, wait_id, payload))

        def clear_task_waiting(self, task_id, wait_id):
            self.cleared.append((task_id, wait_id))

    class _BackgroundManager:
        def get_task(self, task_id):
            assert task_id == 'bg-1'
            return _DoneTask()

        def get_task_snapshot(self, task_id):
            assert task_id == 'bg-1'
            return {
                'status': 'completed',
                'return_code': 0,
                'result_type': 'text',
                'output_path': None,
                'completed_at': 123.0,
            }

    registry = _Registry()
    monkeypatch.setattr(task_registry_module, 'get_task_registry', lambda: registry)
    monkeypatch.setattr(bg_tasks_module, 'get_background_task_manager', lambda: _BackgroundManager())
    monkeypatch.setattr('agents.core.base.time.time', lambda: 10.0)

    agent = _PlaceholderAwareAgent()
    agent.context_pipeline = SimpleNamespace(config=ContextConfig())
    publisher = _DummyPublisher()
    state = {
        'publisher': publisher,
        'current_session': [],
        'run_id': 'run-1',
        '_execution': {'task_id': 'task-1'},
    }

    agent._run_waiting_loop(
        WaitingRequest(background_task_ids=['bg-1'], run_id='run-1'),
        AgentContext(session_id='session-1'),
        state,
        rounds=2,
        log_prefix='[test]',
    )

    start_call = next(item for item in publisher.calls if item[0] == 'execution_waiting_start')
    end_call = next(item for item in publisher.calls if item[0] == 'execution_waiting_end')
    assert start_call[1]['run_id'] == 'run-1'
    assert start_call[1]['background_task_ids'] == ['bg-1']
    assert start_call[1]['pending_task_ids'] == ['bg-1']
    assert end_call[1]['run_id'] == 'run-1'
    assert end_call[1]['completed_task_ids'] == ['bg-1']
    assert end_call[1]['pending_task_ids'] == []
    assert end_call[1]['wake_reason'] == 'completed_early'
    assert end_call[1]['status'] == 'completed'
    assert state['current_session']
    assert registry.cleared


def test_task_registry_keeps_multi_target_wait_until_all_targets_complete():
    from agents.task_registry import BackgroundWaitState, TaskRegistry

    registry = TaskRegistry()
    task_id = registry.register_task(
        session_id='session-1',
        run_id='run-1',
        task='demo',
        status='running',
        execution_kind='agent_run',
    )
    wait_state = BackgroundWaitState(
        wait_id='wait-1',
        task_ids=['bg-1', 'bg-2'],
        pending_task_ids=['bg-1', 'bg-2'],
    )
    evt = registry.add_task_pending_wait(task_id, 'wait-1', wait_state)

    assert registry.resolve_task_wait(task_id, 'wait-1', {
        'background_task_id': 'bg-1',
        'status': 'failed',
    }) is True
    assert evt.is_set()
    partial = registry.get_task_wait_result(task_id, 'wait-1')
    assert partial['status'] == 'partial'
    assert partial['completed_task_ids'] == ['bg-1']
    assert wait_state.pending_task_ids == ['bg-2']
    assert registry.find_task_by_wait_target('bg-2') == (task_id, 'wait-1')

    evt.clear()
    assert registry.resolve_task_wait(task_id, 'wait-1', {
        'background_task_id': 'bg-2',
        'status': 'completed',
    }) is True
    final = registry.get_task_wait_result(task_id, 'wait-1')
    assert final['status'] == 'failed'
    assert final['completed_task_ids'] == ['bg-1', 'bg-2']
    assert wait_state.pending_task_ids == []
    assert registry.find_task_by_wait_target('bg-2') is None


def test_run_waiting_loop_does_not_end_on_partial_background_completion(monkeypatch):
    import agents.task_registry as task_registry_module
    import tools.runtime.background_tasks as bg_tasks_module
    from agents.core.base import WaitingRequest

    class _Event:
        def __init__(self):
            self.wait_calls = 0

        def wait(self, timeout=None):
            del timeout
            self.wait_calls += 1
            return self.wait_calls == 1

        def clear(self):
            pass

    class _Registry:
        def __init__(self):
            self.event = _Event()
            self.cleared = []

        def add_task_pending_wait(self, task_id, wait_id, bg_wait_state):
            del task_id, wait_id, bg_wait_state
            return self.event

        def get_task_wait_result(self, task_id, wait_id):
            del task_id, wait_id
            return {
                'status': 'partial',
                'completed_task_ids': ['bg-1'],
                'completed_payloads': [
                    {'background_task_id': 'bg-1', 'status': 'completed'},
                ],
                'pending_task_ids': ['bg-2'],
            }

        def resolve_task_wait(self, task_id, wait_id, payload):
            del task_id, wait_id, payload

        def clear_task_waiting(self, task_id, wait_id):
            self.cleared.append((task_id, wait_id))

    class _Task:
        def __init__(self, status):
            self.status = status
            self.return_code = 0
            self.result_type = 'text'
            self.output_path = None
            self.completed_at = 123.0

        def is_done(self):
            return self.status == 'completed'

    class _BackgroundManager:
        def __init__(self):
            self.poll_count = 0

        def get_task(self, task_id):
            if task_id == 'bg-1':
                return _Task('completed' if self.poll_count > 0 else 'running')
            if task_id == 'bg-2':
                return _Task('completed' if self.poll_count > 0 else 'running')
            return None

        def get_task_snapshot(self, task_id):
            assert task_id in {'bg-1', 'bg-2'}
            return {
                'status': 'completed',
                'return_code': 0,
                'result_type': 'text',
                'output_path': None,
                'completed_at': 123.0,
            }

    bg_manager = _BackgroundManager()

    def _polling_manager():
        return bg_manager

    registry = _Registry()
    monkeypatch.setattr(task_registry_module, 'get_task_registry', lambda: registry)
    monkeypatch.setattr(bg_tasks_module, 'get_background_task_manager', _polling_manager)

    original_poll = BaseAgent._poll_background_tasks

    def _counting_poll(self, bg_manager_arg, *args, **kwargs):
        result = original_poll(self, bg_manager_arg, *args, **kwargs)
        bg_manager.poll_count += 1
        return result

    monkeypatch.setattr(BaseAgent, '_poll_background_tasks', _counting_poll)

    agent = _PlaceholderAwareAgent()
    agent.context_pipeline = SimpleNamespace(config=ContextConfig())
    publisher = _DummyPublisher()
    state = {
        'publisher': publisher,
        'current_session': [],
        'run_id': 'run-1',
        '_execution': {'task_id': 'task-1'},
    }

    observed = agent._run_waiting_loop(
        WaitingRequest(background_task_ids=['bg-1', 'bg-2'], run_id='run-1'),
        AgentContext(session_id='session-1'),
        state,
        rounds=2,
        log_prefix='[test]',
    )

    end_calls = [item for item in publisher.calls if item[0] == 'execution_waiting_end']
    assert len(end_calls) == 1
    assert end_calls[0][1]['completed_task_ids'] == ['bg-1', 'bg-2']
    assert end_calls[0][1]['pending_task_ids'] == []
    assert observed == ['bg-1', 'bg-2']
    assert '<task-id>bg-1</task-id>' in state['current_session'][0]['content']
    assert '<task-id>bg-2</task-id>' in state['current_session'][0]['content']


def test_run_waiting_loop_reports_failed_background_task_status(monkeypatch):
    import threading
    import agents.task_registry as task_registry_module
    import tools.runtime.background_tasks as bg_tasks_module
    from agents.core.base import WaitingRequest

    class _FailedTask:
        status = 'failed'
        return_code = 1
        result_type = 'text'
        output_path = None
        completed_at = 123.0

        def is_done(self):
            return True

    class _Registry:
        def add_task_pending_wait(self, task_id, wait_id, bg_wait_state):
            del task_id, wait_id, bg_wait_state
            return threading.Event()

        def resolve_task_wait(self, task_id, wait_id, payload):
            del task_id, wait_id, payload

        def clear_task_waiting(self, task_id, wait_id):
            del task_id, wait_id

    class _BackgroundManager:
        def get_task(self, task_id):
            assert task_id == 'bg-failed'
            return _FailedTask()

        def get_task_snapshot(self, task_id):
            assert task_id == 'bg-failed'
            return {
                'status': 'failed',
                'return_code': 1,
                'result_type': 'text',
                'output_path': None,
                'completed_at': 123.0,
            }

    monkeypatch.setattr(task_registry_module, 'get_task_registry', lambda: _Registry())
    monkeypatch.setattr(bg_tasks_module, 'get_background_task_manager', lambda: _BackgroundManager())
    monkeypatch.setattr('agents.core.base.time.time', lambda: 10.0)

    agent = _PlaceholderAwareAgent()
    agent.context_pipeline = SimpleNamespace(config=ContextConfig())
    publisher = _DummyPublisher()
    state = {
        'publisher': publisher,
        'current_session': [],
        'run_id': 'run-1',
        '_execution': {'task_id': 'task-1'},
    }

    observed = agent._run_waiting_loop(
        WaitingRequest(background_task_ids=['bg-failed'], run_id='run-1'),
        AgentContext(session_id='session-1'),
        state,
        rounds=2,
        log_prefix='[test]',
    )

    end_call = next(item for item in publisher.calls if item[0] == 'execution_waiting_end')
    assert end_call[1]['status'] == 'failed'
    assert observed == ['bg-failed']
    content = state['current_session'][0]['content']
    assert '<status>failed</status>' in content
    assert '执行失败' in content


def test_append_waiting_observation_returns_notification_with_output_path():
    from tools.runtime.background_tasks import get_background_task_manager

    temp_dir = Path(tempfile.mkdtemp(prefix="waiting_replay_", dir=Path(__file__).parent))
    try:
        bg_manager = get_background_task_manager()
        bg_manager._tasks.clear()
        bg_manager._processes.clear()

        task = bg_manager.spawn_bash(
            "printf 'start\ndone\n'",
            bash_executable=None,
            cwd=temp_dir,
            output_dir=temp_dir,
            session_id="session-1",
        )
        for _ in range(100):
            current = bg_manager.get_task(task.task_id)
            if current and current.is_done():
                break
            import time as _time
            _time.sleep(0.02)

        agent = _PlaceholderAwareAgent()

        class _Registry:
            def clear_task_waiting(self, *args, **kwargs):
                pass

        publisher = _DummyPublisher()
        state = {
            "publisher": publisher,
            "current_session": [],
        }
        bg_wait_state = SimpleNamespace(
            completed_task_ids=[task.task_id],
            pending_task_ids=[],
            task_ids=[task.task_id],
            wake_reason='completed',
        )

        observation = agent._append_waiting_observation(
            "wait-1",
            "task-1",
            _Registry(),
            bg_manager,
            state,
            bg_wait_state,
            [],
            1,
        )

        assert observation
        assert f"<task-id>{task.task_id}</task-id>" in observation
        assert "<output-file>" in observation
        assert "<task-notification>" in observation
        assert state["current_session"] == [{"role": "user", "content": observation}]
        react_calls = [item for item in publisher.calls if item[0] == "react_intermediate"]
        assert len(react_calls) == 1
        assert react_calls[0][1]["content"] == observation
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_append_waiting_observation_closes_pending_tool_call(monkeypatch):
    class _Registry:
        def clear_task_waiting(self, *args, **kwargs):
            pass

    class _BackgroundManager:
        def get_task_snapshot(self, task_id):
            assert task_id == 'bg-closed'
            return {
                'status': 'completed',
                'return_code': 0,
                'result_type': 'text',
                'output_path': None,
                'completed_at': 123.0,
            }

    monkeypatch.setattr('agents.core.base.time.time', lambda: 12.0)

    agent = _PlaceholderAwareAgent()
    publisher = _DummyPublisher()
    state = {
        'publisher': publisher,
        'current_session': [],
    }
    pending_result = success_result(
        content={
            'background_task_id': 'bg-closed',
            'suggest_wait': True,
        },
        summary='后台任务已启动',
        output_type='json',
        tool_name='execute_bash',
    )
    bg_wait_state = SimpleNamespace(
        completed_task_ids=['bg-closed'],
        pending_task_ids=[],
        task_ids=['bg-closed'],
        wake_reason='completed',
    )

    agent._append_waiting_observation(
        'wait-1',
        'task-1',
        _Registry(),
        _BackgroundManager(),
        state,
        bg_wait_state,
        [
            {
                'tool_name': 'execute_bash',
                'tool_call_id': 'tool-1',
                'parent_call_id': 'call-1',
                'result': pending_result,
                'current_session_id': 'session-1',
                'tool_started_at': 10.0,
                'agent_display_name': 'Test Agent',
            }
        ],
        3,
    )

    end_call = next(item for item in publisher.calls if item[0] == 'tool_call_end')
    assert end_call[1]['call_id'] == 'tool-1'
    assert end_call[1]['tool_name'] == 'execute_bash'
    assert end_call[1]['success'] is True
    assert end_call[1]['round'] == 3
    assert end_call[1]['execution_time'] == 2.0
    assert '<task-id>bg-closed</task-id>' in end_call[1]['result_preview']


def test_run_hidden_keepalive_skips_when_provider_keepalive_disabled():
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


def test_pending_notifications_drain_into_current_session():
    """session 级通知队列应在 drain 时注入 current_session（对标 Claude Code enqueuePendingNotification）。"""
    agent = _PlaceholderAwareAgent()
    publisher = _DummyPublisher()

    class _Registry:
        def drain_session_notifications(self, session_id):
            assert session_id == "session-1"
            return [
                {
                    "background_task_id": "bg-9",
                    "status": "completed",
                    "output_path": "E:/tmp/bg_9.log",
                    "summary": "后台任务 bg-9 已完成",
                }
            ]

    import agents.task_registry as task_registry_module
    original_getter = task_registry_module.get_task_registry
    task_registry_module.get_task_registry = lambda: _Registry()
    try:
        context = AgentContext(session_id="session-1")
        state = {
            "publisher": publisher,
            "current_session": [],
        }

        agent._drain_pending_notifications(context, state, 3)

        assert len(state["current_session"]) == 1
        content = state["current_session"][0]["content"]
        assert "<task-notification>" in content
        assert "<task-id>bg-9</task-id>" in content
        assert "<output-file>E:/tmp/bg_9.log</output-file>" in content
        assert "<status>completed</status>" in content
        react_calls = [item for item in publisher.calls if item[0] == "react_intermediate"]
        assert len(react_calls) == 1
        assert react_calls[0][1]["round"] == 3
    finally:
        task_registry_module.get_task_registry = original_getter


def test_pending_notifications_skip_ids_already_observed_by_waiting_loop():
    agent = _PlaceholderAwareAgent()
    publisher = _DummyPublisher()

    class _Registry:
        def drain_session_notifications(self, session_id):
            assert session_id == "session-1"
            return [
                {
                    "background_task_id": "bg-waited",
                    "status": "completed",
                    "output_path": "E:/tmp/bg_waited.log",
                },
                {
                    "background_task_id": "bg-other",
                    "status": "completed",
                    "output_path": "E:/tmp/bg_other.log",
                },
            ]

    import agents.task_registry as task_registry_module
    original_getter = task_registry_module.get_task_registry
    task_registry_module.get_task_registry = lambda: _Registry()
    try:
        context = AgentContext(session_id="session-1")
        state = {
            "publisher": publisher,
            "current_session": [],
        }

        agent._drain_pending_notifications(
            context,
            state,
            3,
            exclude_background_task_ids=["bg-waited"],
        )

        assert len(state["current_session"]) == 1
        content = state["current_session"][0]["content"]
        assert "<task-id>bg-other</task-id>" in content
        assert "bg-waited" not in content
    finally:
        task_registry_module.get_task_registry = original_getter


def test_cross_run_notifications_drain_at_run_start():
    """上次 run 结束后到达的通知应在下次 run 开头被消费。"""
    agent = _PlaceholderAwareAgent()
    publisher = _DummyPublisher()

    class _Registry:
        def drain_session_notifications(self, session_id):
            assert session_id == "session-1"
            return [
                {
                    "background_task_id": "bg-cross-run",
                    "status": "completed",
                    "output_path": "E:/tmp/bg_cross.log",
                }
            ]

    import agents.task_registry as task_registry_module
    original_getter = task_registry_module.get_task_registry
    task_registry_module.get_task_registry = lambda: _Registry()
    try:
        context = AgentContext(session_id="session-1")
        state = {
            "publisher": publisher,
            "current_session": [],
        }

        agent._drain_pending_notifications(context, state, 1)

        assert len(state["current_session"]) == 1
        content = state["current_session"][0]["content"]
        assert "<task-id>bg-cross-run</task-id>" in content
        assert "<output-file>E:/tmp/bg_cross.log</output-file>" in content
    finally:
        task_registry_module.get_task_registry = original_getter


def test_session_notification_queue_basic_operations():
    """session 级通知队列的入队/消费/幂等性。"""
    from agents.task_registry import TaskRegistry

    registry = TaskRegistry()
    # 入队应成功
    assert registry.add_session_notification("session-1", {"bg": 1}) is True
    assert registry.add_session_notification("session-1", {"bg": 2}) is True
    # drain 应拿到两条
    notifications = registry.drain_session_notifications("session-1")
    assert len(notifications) == 2
    assert notifications[0]["bg"] == 1
    assert notifications[1]["bg"] == 2
    # 再 drain 应为空
    assert registry.drain_session_notifications("session-1") == []
    # 空 session_id 应返回 False
    assert registry.add_session_notification("", {"bg": 3}) is False


def test_peek_session_notifications():
    """peek 不消费队列内容。"""
    from agents.task_registry import TaskRegistry

    registry = TaskRegistry()
    assert registry.peek_session_notifications("session-1") is False
    registry.add_session_notification("session-1", {"bg": 1})
    assert registry.peek_session_notifications("session-1") is True
    # peek 不消费
    assert registry.peek_session_notifications("session-1") is True
    # drain 后变空
    registry.drain_session_notifications("session-1")
    assert registry.peek_session_notifications("session-1") is False


def test_is_session_idle():
    """session idle 判断与并发控制对齐。"""
    from agents.task_registry import TaskRegistry
    import threading

    registry = TaskRegistry()
    assert registry.is_session_idle("session-1") is True

    # 注册一个活跃任务
    registry.register_task(
        session_id="session-1",
        run_id="run-1",
        task="test",
        thread=threading.current_thread(),
        cancel_event=threading.Event(),
        status="running",
        execution_kind="agent_run",
        concurrency_key="session:session-1",
    )
    assert registry.is_session_idle("session-1") is False

    # 结束任务后恢复空闲
    task_id = registry.get_task_id_by_session("session-1")
    registry.finish_task(task_id, status="completed")
    assert registry.is_session_idle("session-1") is True


def test_notification_trigger_skips_when_session_busy():
    """session 有活跃 run 时，自动触发应跳过。"""
    from agents.task_registry import TaskRegistry
    from execution.notification_trigger import _do_auto_run
    import threading

    registry = TaskRegistry()
    registry.add_session_notification("session-1", {"bg": 1})

    # 注册活跃任务
    registry.register_task(
        session_id="session-1",
        run_id="run-1",
        task="test",
        thread=threading.current_thread(),
        cancel_event=threading.Event(),
        status="running",
        execution_kind="agent_run",
        concurrency_key="session:session-1",
    )

    import agents.task_registry as task_registry_module
    original_getter = task_registry_module.get_task_registry
    task_registry_module.get_task_registry = lambda: registry
    try:
        _do_auto_run("session-1")
        # 通知应仍在队列（未被消费，因为 session 忙）
        assert registry.peek_session_notifications("session-1") is True
    finally:
        task_registry_module.get_task_registry = original_getter


def test_notification_trigger_build_xml():
    """通知 XML 构建格式验证。"""
    from execution.notification_trigger import _build_notification_xml

    xml = _build_notification_xml({
        "background_task_id": "abc-123",
        "status": "completed",
        "output_path": "/tmp/bg_abc.log",
        "return_code": 0,
        "result_type": "bash_output",
    })
    assert "<task-notification>" in xml
    assert "<task-id>abc-123</task-id>" in xml
    assert "<output-file>/tmp/bg_abc.log</output-file>" in xml
    assert "<status>completed</status>" in xml
    assert "<return-code>0</return-code>" in xml
