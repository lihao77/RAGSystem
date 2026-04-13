# -*- coding: utf-8 -*-

from types import SimpleNamespace

import pytest

from tools.bootstrap import bootstrap_tool_system
from tools.contracts.permission_modes import PermissionMode, PermissionPolicy
from tools.permission_manager import (
    add_auto_accept_pattern,
    clear_session_permission_override,
    get_permission_policy,
    set_permission_policy,
    set_session_permission_override,
    should_require_approval,
)
from tools.permissions import (
    TOOL_PERMISSIONS,
    RiskLevel,
    check_tool_permission,
    evaluate_tool_permission,
    get_tool_permission,
)


@pytest.fixture(autouse=True)
def _bootstrap_decorated_tools():
    """触发装饰器工具的自动发现和权限合并，模拟应用启动流程。"""
    bootstrap_tool_system()


@pytest.fixture(autouse=True)
def _reset_tool_permissions():
    """重建装饰器权限缓存，避免测试间手动覆盖污染。"""
    from tools.decorators import get_decorated_tools

    bootstrap_tool_system()
    for name, info in get_decorated_tools().items():
        TOOL_PERMISSIONS[name] = info["permission"]
    yield
    for name, info in get_decorated_tools().items():
        TOOL_PERMISSIONS[name] = info["permission"]


@pytest.fixture(autouse=True)
def _reset_permission_policy():
    """重置全局权限策略，避免测试间互相污染。"""
    set_permission_policy(PermissionPolicy())
    yield
    clear_session_permission_override('session-auto-accept')


def test_permission_policy_defaults_skip_all_approvals_to_false():
    policy = get_permission_policy()
    assert policy.skip_all_approvals is False


    allowed, error = check_tool_permission("activate_skill", caller="direct")

    assert allowed is True
    assert error is None

    permission = get_tool_permission("activate_skill")
    assert permission is not None
    assert permission.risk_level == RiskLevel.LOW
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
                return {"risk_level": "high"}
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


def test_memory_tools_are_enabled_via_effective_direct_tools():
    agent_config = SimpleNamespace(
        tools=SimpleNamespace(enabled_tools=[]),
        memory=SimpleNamespace(enabled=True, allowed_scopes=["team"], write_scopes=[], archive_scopes=[]),
        skills=None,
        delegation=None,
        mcp=None,
    )

    decision = evaluate_tool_permission("list_memory_index", agent_config=agent_config, caller="direct")

    assert decision.execution_allowed is True
    assert decision.deny_reason == ""


def test_memory_tools_respect_configured_subset():
    agent_config = SimpleNamespace(
        tools=SimpleNamespace(enabled_tools=[]),
        memory=SimpleNamespace(enabled=True, allowed_scopes=["team"], write_scopes=[], archive_scopes=[]),
        skills=None,
        delegation=None,
        mcp=None,
    )

    allowed, error = check_tool_permission("read_memory_entry", agent_config=agent_config, caller="direct")
    assert allowed is True
    assert error is None

    denied, denied_error = check_tool_permission("write_memory", agent_config=agent_config, caller="direct")
    assert denied is False
    assert denied_error == "Tool write_memory is not enabled for this agent"


def test_memory_tools_are_rejected_when_memory_disabled():
    agent_config = SimpleNamespace(
        tools=SimpleNamespace(enabled_tools=[]),
        memory=SimpleNamespace(enabled=False, allowed_scopes=[], write_scopes=[], archive_scopes=[]),
        skills=None,
        delegation=None,
        mcp=None,
    )

    allowed, error = check_tool_permission("list_memory_index", agent_config=agent_config, caller="direct")

    assert allowed is False
    assert error == "Tool list_memory_index is not enabled for this agent"


def test_permission_decision_distinguishes_exposure_and_execution():
    agent_config = SimpleNamespace(
        tools=SimpleNamespace(enabled_tools=[]),
        memory=SimpleNamespace(enabled=False, allowed_scopes=[], write_scopes=[], archive_scopes=[]),
        skills=None,
        delegation=None,
        mcp=None,
    )

    decision = evaluate_tool_permission("write_memory", agent_config=agent_config, caller="direct")

    assert decision.execution_allowed is False
    assert decision.deny_reason == "Tool write_memory is not enabled for this agent"


def test_mcp_permission_rejects_disabled_server(monkeypatch):
    monkeypatch.delitem(TOOL_PERMISSIONS, "mcp__demo__search", raising=False)

    class _FakeStore:
        def get_server(self, server_name):
            if server_name == "demo":
                return {"risk_level": "medium"}
            return None

    import mcp.config_store as config_store_module

    monkeypatch.setattr(config_store_module, "get_mcp_config_store", lambda: _FakeStore())

    agent_config = SimpleNamespace(mcp=SimpleNamespace(enabled_servers=[]))
    allowed, error = check_tool_permission("mcp__demo__search", agent_config=agent_config, caller="direct")

    assert allowed is False
    assert error == "MCP tool mcp__demo__search is not enabled for this agent"


def test_permission_mode_matrix():
    low_permission = get_tool_permission("activate_skill")
    medium_permission = get_tool_permission("execute_skill_script")
    high_permission = get_tool_permission("execute_bash")

    assert low_permission is not None
    assert medium_permission is not None
    assert high_permission is not None
    assert low_permission.risk_level == RiskLevel.LOW
    assert medium_permission.risk_level == RiskLevel.MEDIUM
    assert high_permission.risk_level == RiskLevel.HIGH

    cases = [
        (PermissionMode.STRICT, low_permission, True, "严格模式：low 风险工具需要审批"),
        (PermissionMode.STRICT, medium_permission, True, "严格模式：medium 风险工具需要审批"),
        (PermissionMode.STRICT, high_permission, True, "严格模式：high 风险工具需要审批"),
        (PermissionMode.STANDARD, low_permission, False, ""),
        (PermissionMode.STANDARD, medium_permission, True, "标准模式：medium 风险工具需要审批"),
        (PermissionMode.STANDARD, high_permission, True, "标准模式：high 风险工具需要审批"),
        (PermissionMode.RELAXED, low_permission, False, ""),
        (PermissionMode.RELAXED, medium_permission, False, ""),
        (PermissionMode.RELAXED, high_permission, True, "宽松模式：高风险工具需要审批"),
        (PermissionMode.DANGEROUSLY_SKIP_PERMISSIONS, low_permission, False, "dangerously_skip_permissions 模式，跳过审批"),
        (PermissionMode.DANGEROUSLY_SKIP_PERMISSIONS, medium_permission, False, "dangerously_skip_permissions 模式，跳过审批"),
        (PermissionMode.DANGEROUSLY_SKIP_PERMISSIONS, high_permission, False, "dangerously_skip_permissions 模式，跳过审批"),
    ]

    for mode, permission, expected_requires, expected_reason in cases:
        set_permission_policy(PermissionPolicy(mode=mode))
        requires, reason = should_require_approval(permission.tool_name, permission, {})
        assert requires is expected_requires
        assert reason == expected_reason


def test_strict_mode_allows_auto_accept_override():
    permission = get_tool_permission("execute_bash")
    assert permission is not None
    assert permission.risk_level == RiskLevel.HIGH

    set_permission_policy(PermissionPolicy(mode=PermissionMode.STRICT))
    add_auto_accept_pattern("tool_name", "execute_bash")

    requires, reason = should_require_approval("execute_bash", permission, {})

    assert requires is False
    assert "自动接受" in reason


def test_session_override_auto_accept_patterns_take_effect():
    permission = get_tool_permission("execute_bash")
    assert permission is not None

    set_permission_policy(PermissionPolicy(mode=PermissionMode.STRICT))
    set_session_permission_override(
        'session-auto-accept',
        PermissionPolicy(
            mode=PermissionMode.STRICT,
            auto_accept_patterns=[
                {
                    'pattern_type': 'tool_name',
                    'pattern_value': 'execute_bash',
                    'description': 'session scoped allow',
                }
            ],
        ),
    )

    requires, reason = should_require_approval(
        'execute_bash',
        permission,
        {},
        session_id='session-auto-accept',
    )

    assert requires is False
    assert "自动接受" in reason


