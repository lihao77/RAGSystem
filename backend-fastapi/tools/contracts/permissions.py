"""Pure permission models for the tool system."""

from enum import Enum

from pydantic import BaseModel


class RiskLevel(str, Enum):
    """工具风险等级"""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ToolPermission(BaseModel):
    """工具权限配置"""

    tool_name: str
    risk_level: RiskLevel = RiskLevel.LOW
    requires_approval: bool = False
    description: str = ""
    allowed_roles: list = []
    allowed_callers: list = ["direct", "code_execution"]
    timeout_seconds: int = 60
