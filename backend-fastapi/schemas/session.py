# -*- coding: utf-8 -*-
"""
会话相关 Pydantic 模型。
"""

import os
from typing import Any, Dict, List, Optional

try:
    from pydantic import BaseModel, Field, field_validator
    _PYDANTIC_V2 = True
except ImportError:
    from pydantic import BaseModel, Field, validator as field_validator
    _PYDANTIC_V2 = False


def normalize_workspace_root(value: Any) -> Optional[str]:
    """规范化并校验 session.metadata.workspace_root。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('metadata.workspace_root 必须是字符串或 null')
    normalized = value.strip()
    if not normalized:
        raise ValueError('metadata.workspace_root 不能为空字符串')
    if not os.path.isabs(normalized):
        raise ValueError('metadata.workspace_root 必须是绝对路径')
    return normalized


def normalize_entry_agent(value: Any) -> Optional[str]:
    """规范化并校验 session.metadata.entry_agent。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('metadata.entry_agent 必须是字符串或 null')
    normalized = value.strip()
    if not normalized:
        raise ValueError('metadata.entry_agent 不能为空字符串')
    return normalized


def normalize_session_metadata(value: Any) -> Dict[str, Any]:
    """规范化 session metadata。"""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError('metadata 必须是对象')

    metadata = dict(value)
    if 'workspace_root' in metadata:
        metadata['workspace_root'] = normalize_workspace_root(metadata.get('workspace_root'))
    if 'entry_agent' in metadata:
        metadata['entry_agent'] = normalize_entry_agent(metadata.get('entry_agent'))
    return metadata


class CreateSessionRequest(BaseModel):
    """创建会话请求。"""
    session_id: Optional[str] = Field(None, description='指定会话 ID（可选，不提供则自动生成）')
    user_id: Optional[str] = Field(None, description='用户 ID（可选）')
    metadata: Optional[Dict[str, Any]] = Field(
        default_factory=dict,
        description='会话级元数据；支持 metadata.workspace_root 指定当前会话的 workspace 根目录（绝对路径），支持 metadata.entry_agent 指定当前会话的默认入口 Agent',
    )

    if _PYDANTIC_V2:
        @field_validator('metadata', mode='before')
        @classmethod
        def _validate_metadata(cls, value: Any) -> Dict[str, Any]:
            return normalize_session_metadata(value)
    else:
        @field_validator('metadata', pre=True, allow_reuse=True)
        def _validate_metadata(cls, value: Any) -> Dict[str, Any]:
            return normalize_session_metadata(value)


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
