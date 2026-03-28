"""
工具权限管理系统
"""

from typing import Dict, Optional

from tools.contracts.permissions import RiskLevel, ToolPermission
from tools.runtime.mcp_gateway import is_mcp_tool, parse_mcp_tool_name
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
        requires_approval=False,
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
    requires_approval: bool = False,
    description: str = "",
    allowed_callers: list = None
) -> None:
    """
    动态注册 MCP 工具权限（在工具发现后调用）

    Args:
        tool_name: 完整工具名，如 "mcp__filesystem__read_file"
        risk_level: 风险等级字符串 "low" / "medium" / "high"
        requires_approval: 是否需要用户审批
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
        requires_approval=requires_approval,
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
    requires_approval: bool = False
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
            requires_approval=requires_approval,
            description=description
        )


_TOOL_REGISTRY = get_tool_registry()


def _get_effective_direct_tool_names(agent_config) -> set[str]:
    if not agent_config or not hasattr(agent_config, 'tools'):
        return set()

    enabled_tools = set(agent_config.tools.enabled_tools if agent_config.tools else [])
    memory_config = getattr(agent_config, 'memory', None)
    if memory_config:
        allowed_scopes = set(getattr(memory_config, 'allowed_scopes', []) or [])
        write_scopes = set(getattr(memory_config, 'write_scopes', []) or [])
        archive_scopes = set(getattr(memory_config, 'archive_scopes', []) or [])
        if allowed_scopes:
            enabled_tools.update({'list_memory_index', 'read_memory_entry'})
        if write_scopes:
            enabled_tools.add('write_memory')
        if archive_scopes:
            enabled_tools.add('archive_memory')
    return enabled_tools


def is_tool_enabled(tool_name: str, agent_config) -> bool:
    """
    检查工具是否在智能体配置中启用

    Args:
        tool_name: 工具名称
        agent_config: 智能体配置对象

    Returns:
        bool: 是否启用
    """
    if not agent_config:
        return False

    # builtin / agent 工具由独立配置域控制，不属于 tools.enabled_tools
    source = _TOOL_REGISTRY.get_tool_source(tool_name)
    if source in {"builtin", "agent"}:
        if source == "agent":
            delegation = getattr(agent_config, 'delegation', None)
            enabled_agents = getattr(delegation, 'enabled_agents', []) if delegation else []
            return bool(enabled_agents)
        return True

    # Skills 系统工具是动态注入的，不在 enabled_tools 列表里
    # 只要智能体启用了任意 Skill，这三个工具就自动可用
    if tool_name in _TOOL_REGISTRY.get_skill_tool_names():
        skills_config = getattr(agent_config, 'skills', None)
        if skills_config:
            enabled_skills = getattr(skills_config, 'enabled_skills', [])
            return bool(enabled_skills)
        return False

    return tool_name in _get_effective_direct_tool_names(agent_config)


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


def check_tool_permission(
    tool_name: str,
    agent_config=None,
    user_role: str = None,
    caller: str = "direct"
) -> tuple[bool, Optional[str]]:
    """Check tool permission."""
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
                        requires_approval=srv_cfg.get("requires_approval", False),
                        description=f"MCP tool ({server_name})"
                    )
                    permission = get_tool_permission(tool_name)

        if not permission:
            return False, f"Unknown tool: {tool_name}"

    if caller not in permission.allowed_callers:
        return False, f"Tool {tool_name} is not allowed from caller {caller}"

    if agent_config:
        if is_mcp_tool(tool_name):
            if not is_mcp_server_enabled_for_agent(tool_name, agent_config):
                return False, f"MCP tool {tool_name} is not enabled for this agent"
        elif not is_tool_enabled(tool_name, agent_config):
            return False, f"Tool {tool_name} is not enabled for this agent"

    if permission.allowed_roles and user_role and user_role not in permission.allowed_roles:
        return False, f"Role {user_role} cannot use tool {tool_name}"

    return True, None
