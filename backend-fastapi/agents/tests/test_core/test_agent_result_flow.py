# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.core import AgentResponse
from agents.core.context import AgentContext
from agents.implementations.orchestrator.executor import AgentExecutor
from agents.implementations.orchestrator.prompting import format_agent_result_summary, replace_placeholders
from agents.implementations.orchestrator.tool_router import route_direct_tool
from tools.response_builder import error_result, success_result
from tools.result_schema import ToolExecutionResult


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

    def execute(self, task, context):
        del context
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
    from tools import tool_executor

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


def test_agent_executor_returns_tool_execution_result_for_success():
    child_agent = _StubChildAgent(
        AgentResponse(
            success=True,
            content="delegated answer",
            execution_time=1.25,
            tool_calls=[{"tool": "search"}, {"tool": "chart"}],
        )
    )
    executor = AgentExecutor(SimpleNamespace(agents={"demo_agent": child_agent}))
    context = AgentContext(session_id="session-1")

    result = executor.execute_agent(
        agent_name="demo_agent",
        task="collect data",
        context=context,
        context_hint="focus on 2024",
    )

    assert isinstance(result, ToolExecutionResult)
    assert result.success is True
    assert result.tool_name == "demo_agent"
    assert result.content == "delegated answer"
    assert result.metadata == {
        "agent_name": "demo_agent",
        "execution_time": 1.25,
        "tool_calls": 2,
    }
    assert "耗时 1.25s" in result.summary
    assert child_agent.tasks == ["collect data\n\n【上下文提示】focus on 2024"]


def test_agent_executor_returns_tool_execution_result_for_failure():
    child_agent = _StubChildAgent(
        AgentResponse(
            success=False,
            error="boom",
        )
    )
    executor = AgentExecutor(SimpleNamespace(agents={"demo_agent": child_agent}))
    context = AgentContext(session_id="session-1")

    result = executor.execute_agent(
        agent_name="demo_agent",
        task="collect data",
        context=context,
    )

    assert isinstance(result, ToolExecutionResult)
    assert result.success is False
    assert result.tool_name == "demo_agent"
    assert result.content == "Agent 'demo_agent' 执行失败: boom"


def test_agent_executor_stream_returns_native_result_after_stream_events():
    child_agent = _StubStreamingChildAgent(
        response=None,
        stream_events=[
            {"type": "thinking", "content": "step 1"},
            {"type": "final_answer", "content": "streamed answer"},
        ],
    )
    executor = AgentExecutor(SimpleNamespace(agents={"demo_agent": child_agent}))
    context = AgentContext(session_id="session-1")

    events = list(
        executor.execute_agent_stream(
            agent_name="demo_agent",
            task="collect data",
            context=context,
            context_hint="focus on 2024",
        )
    )

    assert events[0] == {"type": "thinking", "content": "step 1"}
    assert events[1] == {"type": "final_answer", "content": "streamed answer"}
    assert isinstance(events[2], ToolExecutionResult)
    assert events[2].success is True
    assert events[2].tool_name == "demo_agent"
    assert events[2].content == "streamed answer"
    assert events[2].metadata == {"agent_name": "demo_agent"}
    assert child_agent.tasks == ["collect data\n\n【上下文提示】focus on 2024"]


def test_agent_executor_stream_falls_back_to_execute_agent_native_result():
    child_agent = _StubChildAgent(
        AgentResponse(
            success=True,
            content={"name": "delegated-skill"},
            execution_time=0.5,
        )
    )
    executor = AgentExecutor(SimpleNamespace(agents={"demo_agent": child_agent}))
    context = AgentContext(session_id="session-1")

    events = list(
        executor.execute_agent_stream(
            agent_name="demo_agent",
            task="collect data",
            context=context,
        )
    )

    assert len(events) == 1
    assert isinstance(events[0], ToolExecutionResult)
    assert events[0].success is True
    assert events[0].tool_name == "demo_agent"
    assert events[0].content == {"name": "delegated-skill"}
    assert events[0].output_type == "json"
