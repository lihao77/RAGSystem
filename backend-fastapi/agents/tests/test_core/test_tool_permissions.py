# -*- coding: utf-8 -*-

from types import SimpleNamespace

import pytest

from tools.bootstrap import bootstrap_tool_system
from tools.permissions import (
    TOOL_PERMISSIONS,
    RiskLevel,
    check_tool_permission,
    get_tool_permission,
    _merge_decorated_permissions,
)


@pytest.fixture(autouse=True)
def _bootstrap_decorated_tools():
    """触发装饰器工具的自动发现和权限合并，模拟应用启动流程。"""
    bootstrap_tool_system()


def test_activate_skill_has_registered_permission():
    allowed, error = check_tool_permission("activate_skill", caller="direct")

    assert allowed is True
    assert error is None

    permission = get_tool_permission("activate_skill")
    assert permission is not None
    assert permission.risk_level == RiskLevel.LOW
    assert permission.requires_approval is False
    assert permission.allowed_callers == ["direct"]


def test_registered_tool_can_fall_back_to_default_permission(monkeypatch):
    monkeypatch.delitem(TOOL_PERMISSIONS, "activate_skill", raising=False)

    permission = get_tool_permission("activate_skill")
    assert permission is not None
    assert permission.tool_name == "activate_skill"
    assert permission.risk_level == RiskLevel.LOW
    assert permission.allowed_callers == ["direct"]

    allowed, error = check_tool_permission("activate_skill", caller="direct")
    assert allowed is True
    assert error is None


def test_mcp_permission_checks_enabled_servers_and_config_store_fallback(monkeypatch):
    monkeypatch.delitem(TOOL_PERMISSIONS, "mcp__demo__search", raising=False)

    class _FakeStore:
        def get_server(self, server_name):
            if server_name == "demo":
                return {"risk_level": "high", "requires_approval": True}
            return None

    import mcp.config_store as config_store_module

    monkeypatch.setattr(config_store_module, "get_mcp_config_store", lambda: _FakeStore())

    agent_config = SimpleNamespace(mcp=SimpleNamespace(enabled_servers=["demo"]))
    allowed, error = check_tool_permission("mcp__demo__search", agent_config=agent_config, caller="direct")

    assert allowed is True
    assert error is None

    permission = get_tool_permission("mcp__demo__search")
    assert permission is not None
    assert permission.risk_level == RiskLevel.HIGH
    assert permission.requires_approval is True


def test_memory_tools_are_enabled_via_effective_direct_tools():
    agent_config = SimpleNamespace(
        tools=SimpleNamespace(enabled_tools=[]),
        memory=SimpleNamespace(enabled=True, enabled_tools=[]),
        skills=None,
        delegation=None,
        mcp=None,
    )

    allowed, error = check_tool_permission("list_memory_index", agent_config=agent_config, caller="direct")

    assert allowed is True
    assert error is None


def test_memory_tools_respect_configured_subset():
    agent_config = SimpleNamespace(
        tools=SimpleNamespace(enabled_tools=[]),
        memory=SimpleNamespace(enabled=True, enabled_tools=["read_memory_entry"]),
        skills=None,
        delegation=None,
        mcp=None,
    )

    allowed, error = check_tool_permission("read_memory_entry", agent_config=agent_config, caller="direct")
    assert allowed is True
    assert error is None

    denied, denied_error = check_tool_permission("list_memory_index", agent_config=agent_config, caller="direct")
    assert denied is False
    assert denied_error == "Tool list_memory_index is not enabled for this agent"


def test_memory_tools_are_rejected_when_memory_disabled():
    agent_config = SimpleNamespace(
        tools=SimpleNamespace(enabled_tools=[]),
        memory=SimpleNamespace(enabled=False, enabled_tools=[]),
        skills=None,
        delegation=None,
        mcp=None,
    )

    allowed, error = check_tool_permission("list_memory_index", agent_config=agent_config, caller="direct")

    assert allowed is False
    assert error == "Tool list_memory_index is not enabled for this agent"


def test_mcp_permission_rejects_disabled_server(monkeypatch):
    monkeypatch.delitem(TOOL_PERMISSIONS, "mcp__demo__search", raising=False)

    class _FakeStore:
        def get_server(self, server_name):
            if server_name == "demo":
                return {"risk_level": "medium", "requires_approval": False}
            return None

    import mcp.config_store as config_store_module

    monkeypatch.setattr(config_store_module, "get_mcp_config_store", lambda: _FakeStore())

    agent_config = SimpleNamespace(mcp=SimpleNamespace(enabled_servers=[]))
    allowed, error = check_tool_permission("mcp__demo__search", agent_config=agent_config, caller="direct")

    assert allowed is False
    assert error == "MCP tool mcp__demo__search is not enabled for this agent"
