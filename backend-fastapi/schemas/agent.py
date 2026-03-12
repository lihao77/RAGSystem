# -*- coding: utf-8 -*-
"""
Agent 相关 Pydantic 模型。
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class AgentInfo(BaseModel):
    """智能体信息。"""
    name: str
    description: Optional[str] = None
    capabilities: Optional[List[str]] = None
    tools: Optional[List[str]] = None


class CreateAgentRequest(BaseModel):
    """创建智能体请求。"""
    agent_name: str = Field(..., description='智能体名称')
    display_name: Optional[str] = None
    description: Optional[str] = None
    default_entry: Optional[bool] = None
    custom_params: Optional[Dict[str, Any]] = None
    llm: Optional[Dict[str, Any]] = None


class AgentConfigResponse(BaseModel):
    """智能体配置响应。"""
    agent_name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    default_entry: Optional[bool] = None
    custom_params: Optional[Dict[str, Any]] = None
    llm: Optional[Dict[str, Any]] = None
