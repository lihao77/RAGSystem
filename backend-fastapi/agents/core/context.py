# -*- coding: utf-8 -*-
"""
智能体上下文 (AgentContext)
"""

from typing import Dict, List, Any, Optional
from datetime import datetime

from .models import Message


class AgentContext:
    """
    智能体上下文。

    管理智能体执行过程中的对话历史和元数据，支持分层结构（fork 子上下文）。
    """

    def __init__(
        self,
        session_id: str,
        user_id: Optional[str] = None,
        parent: Optional['AgentContext'] = None,
        llm_override: Optional[Dict[str, Any]] = None
    ):
        self.session_id = session_id
        self.user_id = user_id
        # 请求级 LLM 覆盖：前端通过 llm-select-trigger 选择的模型
        self.llm_override = llm_override

        self.conversation_history: List[Message] = []
        self.metadata: Dict[str, Any] = {}

        if parent:
            self.parent = parent
            self.level = parent.level + 1
            if llm_override is None and getattr(parent, 'llm_override', None):
                self.llm_override = parent.llm_override
        else:
            self.parent = None
            self.level = 0

        self.created_at = datetime.now()

    def fork(self) -> 'AgentContext':
        """派生子上下文"""
        return AgentContext(
            session_id=self.session_id,
            user_id=self.user_id,
            parent=self,
            llm_override=getattr(self, 'llm_override', None)
        )

    def add_message(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict] = None,
        seq: Optional[int] = None,
    ):
        """添加消息到对话历史"""
        self.conversation_history.append(Message(
            role=role,
            content=content,
            metadata=metadata or {},
            seq=seq,
        ))

    def get_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """获取对话历史"""
        msgs = self.conversation_history[-limit:] if limit > 0 else self.conversation_history
        return [
            {
                'role': msg.role,
                'content': msg.content,
                'timestamp': msg.timestamp.isoformat(),
                'metadata': msg.metadata,
                'seq': msg.seq,
            }
            for msg in msgs
        ]

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（用于序列化）"""
        return {
            'session_id': self.session_id,
            'user_id': self.user_id,
            'level': self.level,
            'conversation_history': self.get_history(limit=0),
            'metadata': self.metadata,
            'created_at': self.created_at.isoformat()
        }
