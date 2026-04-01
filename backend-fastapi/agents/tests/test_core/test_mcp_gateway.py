# -*- coding: utf-8 -*-

from tools.runtime.mcp_gateway import execute_mcp_tool, is_mcp_tool, parse_mcp_tool_name
from tools.runtime.models import ToolUseContext


class _FakeMCPService:
    def __init__(self):
        self.calls = []

    def call_tool(self, server_name, tool_name, arguments, *, session_id=None, run_id=None, request_id=None):
        self.calls.append(
            {
                "server_name": server_name,
                "tool_name": tool_name,
                "arguments": arguments,
                "session_id": session_id,
                "run_id": run_id,
                "request_id": request_id,
            }
        )
        return {"ok": True}


def test_mcp_gateway_name_helpers_parse_expanded_names():
    assert is_mcp_tool("mcp__demo__search") is True
    assert parse_mcp_tool_name("mcp__demo__search") == ("demo", "search")
    assert parse_mcp_tool_name("mcp__demo") is None
    assert parse_mcp_tool_name("demo__search") is None
    assert is_mcp_tool("mcp__demo") is False


def test_mcp_gateway_executes_via_service_with_observability_fallback(monkeypatch):
    import services.mcp_service as mcp_service_module
    import tools.runtime.mcp_gateway as mcp_gateway_module

    fake_service = _FakeMCPService()
    monkeypatch.setattr(mcp_service_module, "get_mcp_service", lambda: fake_service)
    monkeypatch.setattr(
        mcp_gateway_module,
        "get_current_execution_observability_fields",
        lambda: {"session_id": "obs-session", "run_id": "obs-run", "request_id": "obs-request"},
    )

    context = ToolUseContext(
        tool_name="mcp__demo__search",
        arguments={"query": "flood"},
    )
    result = execute_mcp_tool(context)

    assert result == {"ok": True}
    assert fake_service.calls == [
        {
            "server_name": "demo",
            "tool_name": "search",
            "arguments": {"query": "flood"},
            "session_id": "obs-session",
            "run_id": "obs-run",
            "request_id": "obs-request",
        }
    ]


def test_mcp_gateway_prefers_explicit_runtime_fields(monkeypatch):
    import services.mcp_service as mcp_service_module
    import tools.runtime.mcp_gateway as mcp_gateway_module

    fake_service = _FakeMCPService()
    monkeypatch.setattr(mcp_service_module, "get_mcp_service", lambda: fake_service)
    monkeypatch.setattr(
        mcp_gateway_module,
        "get_current_execution_observability_fields",
        lambda: {"session_id": "obs-session", "run_id": "obs-run", "request_id": "obs-request"},
    )

    context = ToolUseContext(
        tool_name="mcp__demo__search",
        arguments={"query": "rain"},
        session_id="explicit-session",
        run_id="explicit-run",
        request_id="explicit-request",
    )
    execute_mcp_tool(context)

    assert fake_service.calls[0]["session_id"] == "explicit-session"
    assert fake_service.calls[0]["run_id"] == "explicit-run"
    assert fake_service.calls[0]["request_id"] == "explicit-request"


def test_mcp_gateway_rejects_invalid_tool_name():
    context = ToolUseContext(
        tool_name="search",
        arguments={"query": "rain"},
    )
    result = execute_mcp_tool(context)

    assert result.success is False
    assert result.tool_name == "search"
    assert "无效的 MCP 工具名" in result.summary
