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
    # 知识图谱查询工具（低风险）
    "query_knowledge_graph_with_nl": ToolPermission(
        tool_name="query_knowledge_graph_with_nl",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="自然语言查询知识图谱（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
    "search_knowledge_graph": ToolPermission(
        tool_name="search_knowledge_graph",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="搜索知识图谱实体（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
    "get_entity_relations": ToolPermission(
        tool_name="get_entity_relations",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="获取实体关系（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
    "get_graph_schema": ToolPermission(
        tool_name="get_graph_schema",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="获取图谱结构（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
    "compare_entities": ToolPermission(
        tool_name="compare_entities",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="比较实体（只读）",
        allowed_callers=["direct", "code_execution"]
    ),
    "aggregate_statistics": ToolPermission(
        tool_name="aggregate_statistics",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="聚合统计（只读）",
        allowed_callers=["direct", "code_execution"]
    ),

    # 时序/因果/空间分析（中风险）
    "analyze_temporal_pattern": ToolPermission(
        tool_name="analyze_temporal_pattern",
        risk_level=RiskLevel.MEDIUM,
        requires_approval=False,
        description="时序模式分析（可能耗时）",
        allowed_callers=["direct", "code_execution"]
    ),
    "find_causal_chain": ToolPermission(
        tool_name="find_causal_chain",
        risk_level=RiskLevel.MEDIUM,
        requires_approval=False,
        description="因果链分析（可能耗时）",
        allowed_callers=["direct", "code_execution"]
    ),
    "get_spatial_neighbors": ToolPermission(
        tool_name="get_spatial_neighbors",
        risk_level=RiskLevel.MEDIUM,
        requires_approval=False,
        description="空间邻近分析（可能耗时）",
        allowed_callers=["direct", "code_execution"]
    ),

    # Cypher 查询（高风险）
    "execute_cypher_query": ToolPermission(
        tool_name="execute_cypher_query",
        risk_level=RiskLevel.HIGH,
        requires_approval=True,
        description="执行 Cypher 查询（可能修改数据）",
        allowed_callers=["direct"]  # 禁止代码调用
    ),

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

    # 向量检索（低风险）
    "query_emergency_plan": ToolPermission(
        tool_name="query_emergency_plan",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="查询应急预案（只读）",
        allowed_callers=["direct", "code_execution"]
    ),

    # 几何数据（低风险）
    "get_entity_geometry": ToolPermission(
        tool_name="get_entity_geometry",
        risk_level=RiskLevel.LOW,
        requires_approval=False,
        description="获取实体几何数据（只读）",
        allowed_callers=["direct", "code_execution"]
    ),

    # Skills 系统工具（中风险）
    "load_skill_resource": ToolPermission(
        tool_name="load_skill_resource",
        risk_level=RiskLevel.MEDIUM,
        requires_approval=False,
        description="加载 Skill 资源文件",
        allowed_callers=["direct", "code_execution"]
    ),
    "execute_skill_script": ToolPermission(
        tool_name="execute_skill_script",
        risk_level=RiskLevel.HIGH,
        requires_approval=True,
        description="执行 Skill 脚本（可能执行任意代码）",
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
    "save_json_file": ToolPermission(
        tool_name="save_json_file",
        risk_level=RiskLevel.HIGH,
        requires_approval=True,
        description="保存 JSON 文件到磁盘",
        allowed_callers=["direct"]  # 文件写入，禁止代码调用
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


def is_tool_enabled(tool_name: str, agent_config) -> bool:
    """
    检查工具是否在智能体配置中启用

    Args:
        tool_name: 工具名称
        agent_config: 智能体配置对象

    Returns:
        bool: 是否启用
    """
    if not agent_config or not hasattr(agent_config, 'tools'):
        return False

    enabled_tools = agent_config.tools.enabled_tools if agent_config.tools else []
    return tool_name in enabled_tools


def check_tool_permission(
    tool_name: str,
    agent_config = None,
    user_role: str = None,
    caller: str = "direct"
) -> tuple[bool, Optional[str]]:
    """
    检查工具权限

    Args:
        tool_name: 工具名称
        agent_config: 智能体配置（可选）
        user_role: 用户角色（可选）
        caller: 调用来源（"direct" 或 "code_execution"）

    Returns:
        tuple: (是否允许, 错误消息)
    """
    # 1. 检查工具是否存在
    permission = get_tool_permission(tool_name)
    if not permission:
        return False, f"未知工具: {tool_name}"

    # 2. 检查 allowed_callers（新增）
    if caller not in permission.allowed_callers:
        return False, f"工具 {tool_name} 不允许从 {caller} 调用"

    # 3. 检查智能体配置
    if agent_config and not is_tool_enabled(tool_name, agent_config):
        return False, f"工具 {tool_name} 未在智能体配置中启用"

    # 4. 检查角色权限
    if permission.allowed_roles and user_role:
        if user_role not in permission.allowed_roles:
            return False, f"角色 {user_role} 无权使用工具 {tool_name}"

    return True, None
