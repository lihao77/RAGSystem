# -*- coding: utf-8 -*-
"""
会话相关 Pydantic 模型。
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class CreateSessionRequest(BaseModel):
    """创建会话请求。"""
    session_id: Optional[str] = Field(None, description='指定会话 ID（可选，不提供则自动生成）')
    user_id: Optional[str] = Field(None, description='用户 ID（可选）')
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)


class SessionInfo(BaseModel):
    """会话信息。"""
    session_id: str
    user_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class MessageInfo(BaseModel):
    """消息信息。"""
    id: Optional[str] = None
    seq: Optional[int] = None
    session_id: str
    role: str
    content: str
    metadata: Optional[Dict[str, Any]] = None
    created_at: Optional[str] = None


class RollbackRequest(BaseModel):
    """回退请求。"""
    after_seq: Optional[int] = Field(None, description='回退到该序号之后的消息（该条保留）')
    after_message_id: Optional[str] = Field(None, description='回退到该消息 ID 之后的消息')


class RollbackAndRetryRequest(BaseModel):
    """回退并重试请求。"""
    after_seq: int = Field(..., description='回退到第 N 条（该条保留，之后删除）')
    modify_user_message: Optional[str] = Field(None, description='修改用户问题后重试（可选）')
    user_id: Optional[str] = None


class UpdateMessageRequest(BaseModel):
    """更新消息请求。"""
    content: str = Field(..., description='新的消息内容')


class RecoverSessionRequest(BaseModel):
    """从检查点恢复会话请求。"""
    checkpoint_id: Optional[str] = Field(None, description='检查点 ID（可选，不指定则使用最新）')
    agent_name: Optional[str] = Field(None, description='指定智能体（可选）')
