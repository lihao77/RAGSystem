# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.core import AgentResponse
from agents.core.context import AgentContext
from agents.implementations.orchestrator.executor import AgentExecutor
from agents.implementations.orchestrator.prompting import format_agent_result_summary
from agents.implementations.orchestrator.tool_router import (
    route_agent_delegation,
    route_direct_tool,
    route_user_input_request,
)
from tools.response_builder import error_result, success_result
from tools.result_schema import ToolExecutionResult


class _FakeLogger:
    def info(self, *args, **kwargs):
        del args, kwargs

    def warning(self, *args, **kwargs):
        del args, kwargs

    def error(self, *args, **kwargs):
        del args, kwargs


class _FakePublisher:
    def __init__(self):
        self.agent_start_calls = []
        self.agent_end_calls = []

    def agent_call_start(self, **kwargs):
        self.agent_start_calls.append(kwargs)

    def agent_call_end(self, **kwargs):
        self.agent_end_calls.append(kwargs)


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


class _FakeExecutor:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def execute_agent(self, **kwargs):
        self.calls.append(kwargs)
        return self.result


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


class _CapturingContext(AgentContext):
    def __init__(self):
        super().__init__(session_id="session-1")
        self.merged = []

    def merge(self, child_context, result):
        self.merged.append((child_context, result))
        super().merge(child_context, result)


def _build_agent(agent_result):
    formatter = _FakeObservationFormatter()
    return SimpleNamespace(
        logger=_FakeLogger(),
        _publisher=_FakePublisher(),
        _format_tool_observation=formatter,
        agent_executor=_FakeExecutor(agent_result),
        _get_agent_display_name=lambda agent_name: agent_name,
        _test_formatter=formatter,
    )


def test_route_agent_delegation_rejects_legacy_dict_result():
    agent_result = {
        "success": True,
        "data": {
            "results": "delegated answer",
        },
    }
    agent = _build_agent(agent_result)
    context = _CapturingContext()

    routed = route_agent_delegation(
        agent=agent,
        action={"tool": "invoke_agent_demo_agent", "arguments": {"task": "do work"}},
        context=context,
        event_bus=None,
        publisher=agent._publisher,
        run_id="run-1",
        rounds=1,
        idx=1,
        orchestrator_call_id="orchestrator-1",
        global_agent_order=1,
        log_prefix="[test]",
    )

    assert isinstance(routed["result"], ToolExecutionResult)
    assert routed["result"].success is False
    assert routed["observation"] == "[demo_agent]\nformatted"
    assert isinstance(agent._test_formatter.calls[0]["result"], ToolExecutionResult)
    assert agent._publisher.agent_end_calls[0]["result"] == "Agent 返回了非标准结果类型: dict"
    assert agent._publisher.agent_end_calls[0]["success"] is False


def test_route_agent_delegation_supports_tool_execution_result_success():
    agent_result = success_result(
        content={"answer": "done"},
        summary="done summary",
        output_type="json",
        metadata={"source": "native"},
        tool_name="demo_agent",
    )
    agent = _build_agent(agent_result)
    context = _CapturingContext()

    routed = route_agent_delegation(
        agent=agent,
        action={"tool": "invoke_agent_demo_agent", "arguments": {"task": "do work"}},
        context=context,
        event_bus=None,
        publisher=agent._publisher,
        run_id="run-1",
        rounds=1,
        idx=1,
        orchestrator_call_id="orchestrator-1",
        global_agent_order=1,
        log_prefix="[test]",
    )

    assert routed["result"] is agent_result
    assert routed["observation"] == "[demo_agent]\nformatted"
    assert agent._test_formatter.calls[0]["result"] is agent_result
    assert agent._publisher.agent_end_calls[0]["result"] == '{"answer": "done"}'
    assert agent._publisher.agent_end_calls[0]["success"] is True


def test_route_agent_delegation_supports_tool_execution_result_error():
    agent_result = error_result("delegated failed", tool_name="demo_agent")
    agent = _build_agent(agent_result)
    context = _CapturingContext()

    route_agent_delegation(
        agent=agent,
        action={"tool": "invoke_agent_demo_agent", "arguments": {"task": "do work"}},
        context=context,
        event_bus=None,
        publisher=agent._publisher,
        run_id="run-1",
        rounds=1,
        idx=1,
        orchestrator_call_id="orchestrator-1",
        global_agent_order=1,
        log_prefix="[test]",
    )

    assert agent._test_formatter.calls[0]["result"] is agent_result
    assert agent._publisher.agent_end_calls[0]["result"] == "delegated failed"
    assert agent._publisher.agent_end_calls[0]["success"] is False


def test_route_agent_delegation_falls_back_to_native_error_when_executor_returns_none():
    agent = _build_agent(None)
    context = _CapturingContext()

    routed = route_agent_delegation(
        agent=agent,
        action={"tool": "invoke_agent_demo_agent", "arguments": {"task": "do work"}},
        context=context,
        event_bus=None,
        publisher=agent._publisher,
        run_id="run-1",
        rounds=1,
        idx=1,
        orchestrator_call_id="orchestrator-1",
        global_agent_order=1,
        log_prefix="[test]",
    )

    assert isinstance(routed["result"], ToolExecutionResult)
    assert routed["result"].success is False
    assert routed["result"].content == "Agent 未返回结果"


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


def test_route_user_input_request_returns_native_result():
    fake_agent = SimpleNamespace(
        _handle_user_input_request=lambda **kwargs: "user-value",
        _publisher=None,
    )
    context = AgentContext(session_id="session-1")

    routed = route_user_input_request(
        agent=fake_agent,
        action={"arguments": {"prompt": "demo"}},
        context=context,
        event_bus=None,
        publisher=None,
        run_id="run-1",
        rounds=1,
        idx=1,
        orchestrator_call_id="orchestrator-1",
    )

    assert isinstance(routed["result"], ToolExecutionResult)
    assert routed["result"].success is True
    assert routed["result"].tool_name == "request_user_input"
    assert routed["result"].content == "user-value"


def test_format_agent_result_summary_supports_tool_execution_result_text_truncation():
    agent = SimpleNamespace(logger=_FakeLogger())
    result = success_result(
        content="x" * 501,
        summary="fallback summary",
        output_type="text",
        tool_name="demo_agent",
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
