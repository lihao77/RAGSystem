# -*- coding: utf-8 -*-
"""
MCP Server 配置模型
"""

from typing import Dict, List, Literal, Optional
from pydantic import BaseModel, Field


class MCPServerConfig(BaseModel):
    """单个 MCP Server 配置"""
    name: str = Field(..., description="唯一标识，如 'filesystem'")
    display_name: str = Field(default="", description="显示名称")
    transport: Literal["stdio", "sse", "streamable_http"] = Field(
        default="stdio", description="传输方式"
    )
    # stdio 模式
    command: Optional[str] = Field(default=None, description="启动命令，如 'npx'")
    args: List[str] = Field(default_factory=list, description="命令参数")
    env: Dict[str, str] = Field(default_factory=dict, description="环境变量")
    # SSE/HTTP 模式
    url: Optional[str] = Field(default=None, description="Server URL")
    headers: Dict[str, str] = Field(default_factory=dict, description="HTTP 请求头")
    # 通用
    enabled: bool = Field(default=True, description="是否启用")
    auto_connect: bool = Field(default=True, description="启动时自动连接")
    timeout: int = Field(default=30, ge=1, le=300, description="超时（秒）")
    risk_level: str = Field(default="medium", description="默认风险等级")
    requires_approval: bool = Field(default=False, description="是否需要用户审批")


class MCPConfig(BaseModel):
    """MCP 总配置"""
    servers: Dict[str, MCPServerConfig] = Field(default_factory=dict)
