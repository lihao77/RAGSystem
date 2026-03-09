"""
工具权限管理系统
"""

from enum import Enum
from typing import Dict, Optional
from pydantic import BaseModel


class RiskLevel(str, Enum):
    """工具风险等级"""
    LOW = "low"          # 低风险：只读操作，无副作用
    MEDIUM = "medium"    # 中风险：可能影响性能或返回大量数据
    HIGH = "high"        # 高风险：写操作、删除操作、执行外部命令


class ToolPermission(BaseModel):
    """工具权限配置"""
    tool_name: str
    risk_level: RiskLevel = RiskLevel.LOW
    requires_approval: bool = False
    description: str = ""
    allowed_roles: list = []  # 允许的角色列表（空表示所有角色）
    allowed_callers: list = ["direct", "code_execution"]  # 允许的调用来源


# 工具权限配置表
TOOL_PERMISSIONS: Dict[str, ToolPermission] = {
    # 数据处理（高风险）
    "process_data_file": ToolPermission(
        tool_name="process_data_file",
        risk_level=RiskLevel.HIGH,
        requires_approval=True,
        description="处理数据文件（可能修改文件系统）",
        allowed_callers=["direct"]  # 禁止代码调用
    ),
    "transform_data": ToolPermission(
        tool_name="transform_data",
        risk_level=RiskLevel.HIGH,
        requires_approval=True,
        description="数据转换（可能修改数据）",
        allowed_callers=["direct"]  # 禁止代码调用
    ),

    # 可视化（低风险）
    "generate_chart": ToolPermission(
        tool_name="generate_chart",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="生成图表（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
    "generate_map": ToolPermission(
        tool_name="generate_map",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="生成地图（只读）",
        allowed_callers=["direct", "code_execution"]
    ),

    # Skills 系统工具（低/中风险）
    "activate_skill": ToolPermission(
        tool_name="activate_skill",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="激活 Skill 并加载主文件（只读）",
        allowed_callers=["direct"]
    ),
    "load_skill_resource": ToolPermission(
        tool_name="load_skill_resource",
        risk_level=RiskLevel.MEDIUM,
        requires_approval=False,
        description="加载 Skill 资源文件",
        allowed_callers=["direct"]
    ),
    "execute_skill_script": ToolPermission(
        tool_name="execute_skill_script",
        risk_level=RiskLevel.MEDIUM,
        requires_approval=False,
        description="执行 Skill 脚本（在隔离虚拟环境中运行）",
        allowed_callers=["direct"]  # 禁止代码调用
    ),

    # PTC 代码执行（中风险）
    "execute_code": ToolPermission(
        tool_name="execute_code",
        risk_level=RiskLevel.MEDIUM,
        requires_approval=False,
        description="执行 Python 代码进行工具编排",
        allowed_callers=["direct"]  # 防止递归调用
    ),

    # 文档处理工具
    "read_document": ToolPermission(
        tool_name="read_document",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="读取文档文件（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
    "chunk_document": ToolPermission(
        tool_name="chunk_document",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="文档分块（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
    "extract_structured_data": ToolPermission(
        tool_name="extract_structured_data",
        risk_level=RiskLevel.MEDIUM,
        requires_approval=False,
        description="从文本提取结构化数据",
        allowed_callers=["direct", "code_execution"]
    ),
    "merge_extracted_data": ToolPermission(
        tool_name="merge_extracted_data",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="合并提取结果（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
    # 向后兼容旧工具名
    "save_json_file": ToolPermission(
        tool_name="save_json_file",
        risk_level=RiskLevel.HIGH,
        requires_approval=True,
        description="写入 JSON 文件到磁盘（已弃用，请使用 write_file）",
        allowed_callers=["direct"]
    ),
    "write_file": ToolPermission(
        tool_name="write_file",
        risk_level=RiskLevel.HIGH,
        requires_approval=True,
        description="写入文本文件到磁盘",
        allowed_callers=["direct", "code_execution"]
    ),
    "read_file": ToolPermission(
        tool_name="read_file",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="读取文件内容（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
}


def get_tool_permission(tool_name: str) -> Optional[ToolPermission]:
    """
    获取工具权限配置

    Args:
        tool_name: 工具名称

    Returns:
        ToolPermission: 权限配置，不存在则返回 None
    """
    return TOOL_PERMISSIONS.get(tool_name)


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


_SKILLS_SYSTEM_TOOLS = {'activate_skill', 'load_skill_resource', 'execute_skill_script'}


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

    # Skills 系统工具是动态注入的，不在 enabled_tools 列表里
    # 只要智能体启用了任意 Skill，这三个工具就自动可用
    if tool_name in _SKILLS_SYSTEM_TOOLS:
        skills_config = getattr(agent_config, 'skills', None)
        if skills_config:
            enabled_skills = getattr(skills_config, 'enabled_skills', [])
            return bool(enabled_skills)
        return False

    if not hasattr(agent_config, 'tools'):
        return False

    enabled_tools = agent_config.tools.enabled_tools if agent_config.tools else []
    return tool_name in enabled_tools


def is_mcp_server_enabled_for_agent(tool_name: str, agent_config) -> bool:
    """检查 MCP 工具所属 server 是否已在智能体配置中启用。"""
    if not agent_config:
        return False

    from mcp.converter import parse_mcp_tool_name

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
        from mcp.converter import is_mcp_tool, parse_mcp_tool_name
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

    from mcp.converter import is_mcp_tool as _is_mcp
    if agent_config:
        if _is_mcp(tool_name):
            if not is_mcp_server_enabled_for_agent(tool_name, agent_config):
                return False, f"MCP tool {tool_name} is not enabled for this agent"
        elif not is_tool_enabled(tool_name, agent_config):
            return False, f"Tool {tool_name} is not enabled for this agent"

    if permission.allowed_roles and user_role and user_role not in permission.allowed_roles:
        return False, f"Role {user_role} cannot use tool {tool_name}"

    return True, None
