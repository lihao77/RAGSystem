# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.core import AgentResponse
from agents.core.context import AgentContext
from agents.implementations.orchestrator.prompting import format_agent_result_summary, replace_placeholders
from agents.implementations.orchestrator.tool_router import route_direct_tool
from services.agent_execution_service import AgentExecutionService
from tools.runtime.response_builder import error_result, success_result
from tools.contracts.result_models import ToolExecutionResult


class _FakeLogger:
    def info(self, *args, **kwargs):
        del args, kwargs

    def warning(self, *args, **kwargs):
        del args, kwargs

    def error(self, *args, **kwargs):
        del args, kwargs


class _FakeObservationFormatter:
    def __init__(self):
        self.calls = []

    def __call__(self, result, tool_name=None, session_id=None, is_skills_tool=False):
        self.calls.append(
            {
                "result": result,
                "tool_name": tool_name,
                "session_id": session_id,
                "is_skills_tool": is_skills_tool,
            }
        )
        return "formatted"


class _StubChildAgent:
    def __init__(self, response):
        self.response = response
        self.tasks = []
        self.contexts = []

    def execute(self, task, context):
        self.contexts.append(context)
        self.tasks.append(task)
        return self.response


class _StubStreamingChildAgent(_StubChildAgent):
    def __init__(self, response, stream_events):
        super().__init__(response)
        self.stream_events = stream_events

    def execute_stream(self, task, context):
        del context
        self.tasks.append(task)
        for event in self.stream_events:
            yield event


class _FakeOrchestratorAgent:
    logger = _FakeLogger()

    def _replace_placeholders(self, data, agent_results):
        return replace_placeholders(self, data, agent_results)


class _FakeReActAgent:
    logger = _FakeLogger()

    @staticmethod
    def _safe_json_dumps(obj):
        import json
        return json.dumps(obj, ensure_ascii=False)


def test_route_direct_tool_passes_run_id_to_execute_tool(monkeypatch):
    from tools.runtime import executor as tool_executor

    captured = {}

    def fake_execute_tool(tool_name, arguments, **kwargs):
        captured["tool_name"] = tool_name
        captured["arguments"] = arguments
        captured.update(kwargs)
        return success_result(
            content="ok",
            summary="ok",
            output_type="text",
            tool_name=tool_name,
        )

    monkeypatch.setattr(tool_executor, "execute_tool", fake_execute_tool)

    agent = SimpleNamespace(
        logger=_FakeLogger(),
        name="orchestrator_agent",
        available_tools=[{"function": {"name": "write_file"}}],
        agent_config=None,
        _format_tool_observation=lambda result, **kwargs: "formatted",
    )
    context = AgentContext(session_id="session-1")
    context.metadata["run_id"] = "run-route-1"

    routed = route_direct_tool(
        agent=agent,
        action={"tool": "write_file", "arguments": {"content": "demo"}},
        context=context,
        event_bus=None,
        publisher=None,
        run_id="run-route-1",
        rounds=1,
        idx=1,
        orchestrator_call_id="orchestrator-1",
        log_prefix="[test]",
    )

    assert routed["result"].success is True
    assert captured["tool_name"] == "write_file"
    assert captured["arguments"] == {"content": "demo"}
    assert captured["session_id"] == "session-1"
    assert captured["run_id"] == "run-route-1"
    assert captured["parent_call_id"] == "orchestrator-1"
    assert captured["current_agent_name"] == "orchestrator_agent"


def test_master_placeholder_supports_tool_execution_result_and_failure_message():
    fake_agent = _FakeOrchestratorAgent()
    payload = {
        "task": "技能 {result_1.content.name}，失败 {result_2}",
    }
    agent_results = {
        1: success_result(
            content={"name": "demo-skill"},
            summary="ok",
            output_type="json",
            tool_name="get_skill_info",
        ),
        2: error_result(
            "boom",
            tool_name="demo_tool",
        ),
    }

    resolved = replace_placeholders(fake_agent, payload, agent_results)

    assert "demo-skill" in resolved["task"]
    assert "[Agent 2 执行失败: boom]" in resolved["task"]


def test_master_placeholder_supports_call_agent_result_content_path():
    fake_agent = _FakeOrchestratorAgent()
    payload = {
        "task": "引用路径 {result_1.content.name}",
    }
    agent_results = {
        1: success_result(
            content={"name": "delegated-skill"},
            summary="ok",
            output_type="json",
            tool_name="call_agent",
            metadata={"agent_name": "demo_agent"},
        )
    }

    resolved = replace_placeholders(fake_agent, payload, agent_results)

    assert "delegated-skill" in resolved["task"]


def test_format_agent_result_summary_supports_tool_execution_result_text_truncation():
    agent = SimpleNamespace(logger=_FakeLogger())
    result = success_result(
        content="x" * 501,
        summary="fallback summary",
        output_type="text",
        tool_name="call_agent",
    )

    summary = format_agent_result_summary(agent, result)

    assert summary == ("x" * 500) + "..."


class _StubRuntimeService:
    def __init__(self, agent):
        self.agent = agent
        self.created_runs = []
        self.updated_child_runs = []

    def create_execution_orchestrator(self, session_id=None):
        del session_id
        return SimpleNamespace(agents={"demo_agent": self.agent})

    def build_context(
        self,
        *,
        session_id,
        user_id=None,
        limit=200,
        run_id=None,
        request_id=None,
        llm_override=None,
        thread_key='root',
        parent_run_id=None,
        parent_call_id=None,
        call_id=None,
    ):
        del limit, request_id, llm_override
        context = AgentContext(session_id=session_id, user_id=user_id)
        context.metadata.update({
            'run_id': run_id,
            'thread_key': thread_key,
            'parent_run_id': parent_run_id,
            'parent_call_id': parent_call_id,
            'call_id': call_id,
        })
        return context

    def get_conversation_store(self):
        return SimpleNamespace(
            create_run=self._create_run,
            get_child_agent=self._get_child_agent,
            update_child_agent_last_run=self._update_child_agent_last_run,
        )

    def _create_run(self, **kwargs):
        self.created_runs.append(kwargs)
        return kwargs

    def _get_child_agent(self, *, session_id, child_agent_id):
        return {
            'session_id': session_id,
            'child_agent_id': child_agent_id,
            'agent_name': 'demo_agent',
            'thread_key': f'child:{child_agent_id}',
            'status': 'active',
        }

    def _update_child_agent_last_run(self, **kwargs):
        self.updated_child_runs.append(kwargs)
        return True


def test_agent_execution_service_returns_tool_execution_result_for_success():
    child_agent = _StubChildAgent(
        AgentResponse(
            success=True,
            content="delegated answer",
            execution_time=1.25,
            tool_calls=[{"tool": "search"}, {"tool": "chart"}],
        )
    )
    service = AgentExecutionService(runtime_service=_StubRuntimeService(child_agent))

    result = service.execute_agent_call(
        agent_name="demo_agent",
        task="collect data",
        session_id="session-1",
        context_hint="focus on 2024",
        child_agent_id="child-demo",
        source='agent_call',
    )

    assert isinstance(result, ToolExecutionResult)
    assert result.success is True
    assert result.tool_name == "demo_agent"
    assert result.content == "delegated answer"
    assert result.metadata["agent_name"] == "demo_agent"
    assert result.metadata["child_agent_id"] == "child-demo"
    assert result.metadata["thread_key"] == "child:child-demo"
    assert result.metadata["tool_calls"] == 2
    assert child_agent.tasks == ["collect data\n\n【上下文提示】focus on 2024"]


def test_agent_execution_service_returns_tool_execution_result_for_failure():
    child_agent = _StubChildAgent(
        AgentResponse(
            success=False,
            error="boom",
        )
    )
    service = AgentExecutionService(runtime_service=_StubRuntimeService(child_agent))

    result = service.execute_agent_call(
        agent_name="demo_agent",
        task="collect data",
        session_id="session-1",
        source='agent_call',
    )

    assert isinstance(result, ToolExecutionResult)
    assert result.success is False
    assert result.tool_name == "demo_agent"
    assert result.content == "boom"


def test_agent_execution_service_creates_run_with_child_agent_and_parent_links():
    child_agent = _StubChildAgent(AgentResponse(success=True, content="ok"))
    runtime = _StubRuntimeService(child_agent)
    service = AgentExecutionService(runtime_service=runtime)

    service.execute_agent_call(
        agent_name="demo_agent",
        task="collect data",
        session_id="session-1",
        child_agent_id="child-1",
        parent_run_id="run-parent",
        parent_call_id="call-parent",
        call_id="call-child-visible",
        source='agent_call',
        entrypoint='send_message',
    )

    assert runtime.created_runs[0]["thread_key"] == "child:child-1"
    assert runtime.created_runs[0]["child_agent_id"] == "child-1"
    assert runtime.created_runs[0]["parent_run_id"] == "run-parent"
    assert runtime.created_runs[0]["parent_call_id"] == "call-parent"
    assert child_agent.contexts[0].metadata["call_id"] == "call-child-visible"
    assert runtime.updated_child_runs[0]["child_agent_id"] == "child-1"
