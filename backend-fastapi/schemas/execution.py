# -*- coding: utf-8 -*-
"""
执行相关 Pydantic 模型。
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ExecuteRequest(BaseModel):
    """同步执行请求。"""
    task: str = Field(..., description='任务描述', min_length=1)
    session_id: Optional[str] = Field(None, description='会话 ID（可选，不提供则自动生成）')
    user_id: Optional[str] = Field(None, description='用户 ID（可选）')
    agent: Optional[str] = Field(None, description='指定智能体名称（可选）')


class StreamExecuteRequest(BaseModel):
    """流式执行请求。"""
    task: str = Field(..., description='任务描述', min_length=1)
    session_id: Optional[str] = Field(None, description='会话 ID（可选，不提供则自动生成）')
    user_id: Optional[str] = Field(None, description='用户 ID（可选）')
    selected_llm: Optional[str] = Field(
        None,
        description='前端选择的 LLM，格式: provider|provider_type|model_name',
        alias='selectedLLM',
    )

    model_config = {'populate_by_name': True}


class StreamReconnectRequest(BaseModel):
    """流式重连请求。"""
    session_id: str = Field(..., description='会话 ID')


class StreamStopRequest(BaseModel):
    """停止流式执行请求。"""
    session_id: str = Field(..., description='会话 ID')


class CollaborateTask(BaseModel):
    """协作任务项。"""
    task: str
    agent: Optional[str] = None


class CollaborateRequest(BaseModel):
    """多智能体协作请求。"""
    tasks: List[CollaborateTask] = Field(..., description='任务列表', min_length=1)
    session_id: Optional[str] = None
    user_id: Optional[str] = None
    mode: str = Field('sequential', description='执行模式: sequential 或 parallel')


class ExecutionResult(BaseModel):
    """执行结果。"""
    answer: Optional[str] = None
    agent_name: Optional[str] = None
    execution_time: Optional[float] = None
    tool_calls: Optional[List[Any]] = None
    metadata: Optional[Dict[str, Any]] = None
    session_id: Optional[str] = None


class ApprovalRequest(BaseModel):
    """工具审批请求。"""
    approved: bool = False
    message: str = ''


class UserInputRequest(BaseModel):
    """用户输入请求。"""
    value: str = ''
