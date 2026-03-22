# -*- coding: utf-8 -*-

import pytest

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
    from tools.auto_discovery import discover_decorated_tools
    from tools.tool_registry import get_tool_registry

    decorated = discover_decorated_tools()
    _merge_decorated_permissions()

    if decorated:
        registry = get_tool_registry()
        contracts = [info["contract"] for info in decorated.values()]
        registry.register_extra_contracts(contracts)


def test_assess_flood_risk_has_registered_permission():
    allowed, error = check_tool_permission("assess_flood_risk", caller="direct")

    assert allowed is True
    assert error is None

    permission = get_tool_permission("assess_flood_risk")
    assert permission is not None
    assert permission.risk_level == RiskLevel.LOW
    assert permission.requires_approval is False
    assert permission.allowed_callers == ["direct", "code_execution"]


def test_registered_tool_can_fall_back_to_default_permission(monkeypatch):
    monkeypatch.delitem(TOOL_PERMISSIONS, "assess_flood_risk", raising=False)

    permission = get_tool_permission("assess_flood_risk")
    assert permission is not None
    assert permission.tool_name == "assess_flood_risk"
    assert permission.risk_level == RiskLevel.LOW
    assert permission.allowed_callers == ["direct", "code_execution"]

    allowed, error = check_tool_permission("assess_flood_risk", caller="direct")
    assert allowed is True
    assert error is None
