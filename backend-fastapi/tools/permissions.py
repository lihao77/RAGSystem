"""
工具权限管理系统
"""

from typing import Dict, Optional

from tools.contracts.permissions import RiskLevel, ToolPermission
from tools.runtime.exposure import get_tool_exposure_decision
from tools.runtime.mcp_gateway import is_mcp_tool, parse_mcp_tool_name
from tools.runtime.models import PermissionDecision
from tools.tool_registry import get_tool_registry

# 工具权限配置表
# 已迁移到 @tool() 装饰器的工具权限在启动时通过 _merge_decorated_permissions() 注入。
TOOL_PERMISSIONS: Dict[str, ToolPermission] = {
}


def _merge_decorated_permissions() -> None:
    """将装饰器注册的权限合并到 TOOL_PERMISSIONS（不覆盖已有手动注册）。"""
    import logging
    from tools.decorators import get_decorated_tools
    _logger = logging.getLogger(__name__)
    decorated = get_decorated_tools()
    for tool_name, tool_info in decorated.items():
        if tool_name not in TOOL_PERMISSIONS:
            TOOL_PERMISSIONS[tool_name] = tool_info["permission"]
            _logger.info("合并装饰器工具权限: %s", tool_name)


def get_tool_permission(tool_name: str) -> Optional[ToolPermission]:
    """
    获取工具权限配置

    Args:
        tool_name: 工具名称

    Returns:
        ToolPermission: 权限配置，不存在则返回 None
    """
    permission = TOOL_PERMISSIONS.get(tool_name)
    if permission is not None:
        return permission

    permission = _build_default_permission(tool_name)
    if permission is not None:
        TOOL_PERMISSIONS[tool_name] = permission
    return permission


def _build_default_permission(tool_name: str) -> Optional[ToolPermission]:
    """为已注册但未显式配置的基础工具生成保守默认权限。"""
    tool = _TOOL_REGISTRY.get_tool_by_name(tool_name)
    if not tool:
        return None

    function_def = tool.get("function", {})
    source = function_def.get("source", "decorator")
    category = _TOOL_REGISTRY.get_tool_category(tool_name)
    risk_level = _infer_default_risk_level(tool_name, source, category)

    return ToolPermission(
        tool_name=tool_name,
        risk_level=risk_level,
        description=function_def.get("description", "") or f"Tool {tool_name}",
        allowed_callers=list(function_def.get("allowed_callers", ["direct", "code_execution"])),
    )


def _infer_default_risk_level(tool_name: str, source: str, category: str) -> RiskLevel:
    """基于工具来源和类别推断默认风险等级。"""
    if source == "document" and tool_name in {"write_file", "edit_file"}:
        return RiskLevel.HIGH
    if category in {"data", "execution"}:
        return RiskLevel.MEDIUM
    return RiskLevel.LOW


def register_mcp_tool_permission(
    tool_name: str,
    risk_level: str = "medium",
    description: str = "",
    allowed_callers: list = None
) -> None:
    """
    动态注册 MCP 工具权限（在工具发现后调用）

    Args:
        tool_name: 完整工具名，如 "mcp__filesystem__read_file"
        risk_level: 风险等级字符串 "low" / "medium" / "high"
        description: 工具描述
        allowed_callers: 允许的调用来源列表
    """
    if allowed_callers is None:
        allowed_callers = ["direct", "code_execution"]

    level_map = {"low": RiskLevel.LOW, "medium": RiskLevel.MEDIUM, "high": RiskLevel.HIGH}
    level = level_map.get(risk_level.lower(), RiskLevel.MEDIUM)

    TOOL_PERMISSIONS[tool_name] = ToolPermission(
        tool_name=tool_name,
        risk_level=level,
        description=description,
        allowed_callers=allowed_callers
    )


def unregister_mcp_tool_permissions(server_name: str) -> None:
    """
    移除指定 MCP Server 的所有工具权限

    Args:
        server_name: MCP Server 名称
    """
    prefix = f"mcp__{server_name}__"
    keys_to_remove = [k for k in TOOL_PERMISSIONS if k.startswith(prefix)]
    for key in keys_to_remove:
        del TOOL_PERMISSIONS[key]


def sync_mcp_tool_permissions(
    server_name: str,
    mcp_tools: list,
    risk_level: str = "medium",
) -> None:
    """根据当前发现到的 MCP 工具列表，重建指定 server 的工具权限。"""
    unregister_mcp_tool_permissions(server_name)

    for tool in mcp_tools or []:
        original_tool_name = getattr(tool, 'name', None)
        if not original_tool_name:
            continue

        description = getattr(tool, 'description', '') or f"MCP 工具 ({server_name}/{original_tool_name})"
        register_mcp_tool_permission(
            tool_name=f"mcp__{server_name}__{original_tool_name}",
            risk_level=risk_level,
            description=description
        )


_TOOL_REGISTRY = get_tool_registry()


def is_tool_enabled(tool_name: str, agent_config) -> bool:
    return get_tool_exposure_decision(tool_name, agent_config).visible


def is_mcp_server_enabled_for_agent(tool_name: str, agent_config) -> bool:
    """检查 MCP 工具所属 server 是否已在智能体配置中启用。"""
    if not agent_config:
        return False

    parsed = parse_mcp_tool_name(tool_name)
    if not parsed:
        return False

    server_name, _ = parsed
    mcp_config = getattr(agent_config, 'mcp', None)
    enabled_servers = getattr(mcp_config, 'enabled_servers', []) if mcp_config else []
    return server_name in enabled_servers


def evaluate_tool_permission(
    tool_name: str,
    agent_config=None,
    user_role: str = None,
    caller: str = "direct",
) -> PermissionDecision:
    """
    三态权限评估：返回 PermissionDecision。
    execution_allowed=True  → allow
    execution_allowed=False → deny（deny_reason 非空）
    """
    permission = get_tool_permission(tool_name)
    if not permission:
        from mcp.config_store import get_mcp_config_store

        if is_mcp_tool(tool_name):
            parsed = parse_mcp_tool_name(tool_name)
            if parsed:
                server_name, _ = parsed
                srv_cfg = get_mcp_config_store().get_server(server_name)
                if srv_cfg:
                    register_mcp_tool_permission(
                        tool_name,
                        risk_level=srv_cfg.get("risk_level", "medium"),
                        description=f"MCP tool ({server_name})"
                    )
                    permission = get_tool_permission(tool_name)

    if not permission:
        return PermissionDecision(
            tool_name=tool_name,
            execution_allowed=False,
            deny_reason=f"Unknown tool: {tool_name}",
            resolved_from=["permission_registry"],
        )

    if caller not in permission.allowed_callers:
        return PermissionDecision(
            tool_name=tool_name,
            execution_allowed=False,
            deny_reason=f"Tool {tool_name} is not allowed from caller {caller}",
            risk_level=permission.risk_level.value,
            resolved_from=["permission_registry"],
        )

    if agent_config:
        exposure = get_tool_exposure_decision(tool_name, agent_config)
        if not exposure.visible:
            if is_mcp_tool(tool_name):
                deny_reason = f"MCP tool {tool_name} is not enabled for this agent"
            else:
                deny_reason = f"Tool {tool_name} is not enabled for this agent"
            return PermissionDecision(
                tool_name=tool_name,
                execution_allowed=False,
                deny_reason=deny_reason,
                risk_level=permission.risk_level.value,
                resolved_from=[exposure.source, "permission_registry"],
            )

    if permission.allowed_roles and user_role and user_role not in permission.allowed_roles:
        return PermissionDecision(
            tool_name=tool_name,
            execution_allowed=False,
            deny_reason=f"Role {user_role} cannot use tool {tool_name}",
            risk_level=permission.risk_level.value,
            resolved_from=["permission_registry"],
        )

    return PermissionDecision(
        tool_name=tool_name,
        execution_allowed=True,
        risk_level=permission.risk_level.value,
        resolved_from=["permission_registry"],
    )


def check_tool_permission(
    tool_name: str,
    agent_config=None,
    user_role: str = None,
    caller: str = "direct"
) -> tuple[bool, Optional[str]]:
    """Check tool permission."""
    decision = evaluate_tool_permission(
        tool_name=tool_name,
        agent_config=agent_config,
        user_role=user_role,
        caller=caller,
    )
    return decision.execution_allowed, (decision.deny_reason or None)
