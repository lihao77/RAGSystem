# -*- coding: utf-8 -*-
"""
智能体上下文 (AgentContext) - 分层与黑板机制
"""

from typing import Dict, List, Any, Optional
from datetime import datetime
import uuid

from .models import Message, AgentResponse


class AgentContext:
    """
    智能体上下文 (Hierarchical & Scoped)

    管理智能体执行过程中的状态、历史和共享数据。
    支持分层结构 (Parent-Child) 和黑板机制 (Blackboard)。
    """

    def __init__(
        self,
        session_id: str,
        user_id: Optional[str] = None,
        initial_data: Optional[Dict[str, Any]] = None,
        parent: Optional['AgentContext'] = None,
        llm_override: Optional[Dict[str, Any]] = None
    ):
        self.session_id = session_id
        self.user_id = user_id
        # 请求级 LLM 覆盖：前端通过 llm-select-trigger 选择的模型
        self.llm_override = llm_override

        # 核心上下文数据
        self.conversation_history: List[Message] = []
        self.intermediate_results: Dict[str, Any] = {}
        self.metadata: Dict[str, Any] = {}

        # 共享内存 (Blackboard) - 如果有父节点，则共享父节点的黑板
        if parent:
            self.shared_data = parent.shared_data  # 引用共享
            self.blackboard = parent.blackboard    # 引用共享
            self.parent = parent
            self.level = parent.level + 1
            if llm_override is None and getattr(parent, 'llm_override', None):
                self.llm_override = parent.llm_override
        else:
            self.shared_data: Dict[str, Any] = initial_data or {}
            self.blackboard: Dict[str, Any] = {}   # 结构化黑板
            self.parent = None
            self.level = 0

        # 执行跟踪
        self.agent_stack: List[str] = []  # 智能体调用栈
        self.created_at = datetime.now()

    def fork(self) -> 'AgentContext':
        """派生子上下文 (Create Child Context)"""
        child = AgentContext(
            session_id=self.session_id,
            user_id=self.user_id,
            parent=self,
            llm_override=getattr(self, 'llm_override', None)
        )
        child.agent_stack = list(self.agent_stack)
        return child

    def merge(self, child_context: 'AgentContext', result: AgentResponse):
        """合并子上下文 (Merge Child Context)"""
        if result.success:
            self.metadata[f"subtask_{child_context.current_agent()}_{uuid.uuid4().hex[:4]}"] = {
                "agent": child_context.current_agent(),
                "metrics": result.metrics,
                "timestamp": datetime.now().isoformat()
            }

    # --- Blackboard Methods ---

    def publish(self, key: str, value: Any, tags: List[str] = None):
        """发布信息到黑板"""
        self.blackboard[key] = {
            'value': value,
            'tags': tags or [],
            'publisher': self.current_agent(),
            'timestamp': datetime.now().isoformat()
        }

    def get_blackboard(self, key: str, default: Any = None) -> Any:
        """获取黑板信息"""
        entry = self.blackboard.get(key)
        return entry['value'] if entry else default

    def search_blackboard(self, tag: str) -> List[Any]:
        """按标签搜索黑板信息"""
        results = []
        for key, entry in self.blackboard.items():
            if tag in entry.get('tags', []):
                results.append(entry['value'])
        return results

    # --- Original Methods ---

    def add_message(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict] = None,
        seq: Optional[int] = None,
    ):
        """添加消息到对话历史"""
        message = Message(
            role=role,
            content=content,
            metadata=metadata or {},
            seq=seq,
        )
        self.conversation_history.append(message)

    def get_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """获取对话历史"""
        recent_messages = self.conversation_history[-limit:] if limit > 0 else self.conversation_history
        return [
            {
                'role': msg.role,
                'content': msg.content,
                'timestamp': msg.timestamp.isoformat(),
                'metadata': msg.metadata,
                'seq': msg.seq,
            }
            for msg in recent_messages
        ]

    def store_result(self, key: str, value: Any):
        """存储中间结果"""
        self.intermediate_results[key] = value

    def get_result(self, key: str, default: Any = None) -> Any:
        """获取中间结果"""
        return self.intermediate_results.get(key, default)

    def has_result(self, key: str) -> bool:
        """检查是否存在结果"""
        return key in self.intermediate_results

    def set_shared_data(self, key: str, value: Any):
        """设置共享数据"""
        self.shared_data[key] = value

    def get_shared_data(self, key: str, default: Any = None) -> Any:
        """获取共享数据"""
        return self.shared_data.get(key, default)

    def push_agent(self, agent_name: str):
        """智能体入栈"""
        self.agent_stack.append(agent_name)

    def pop_agent(self):
        """智能体出栈"""
        if self.agent_stack:
            return self.agent_stack.pop()
        return None

    def current_agent(self) -> Optional[str]:
        """获取当前智能体"""
        return self.agent_stack[-1] if self.agent_stack else None

    def clear_history(self):
        """清空对话历史"""
        self.conversation_history.clear()

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（用于序列化）"""
        return {
            'session_id': self.session_id,
            'user_id': self.user_id,
            'level': getattr(self, 'level', 0),
            'conversation_history': self.get_history(limit=0),
            'intermediate_results': self.intermediate_results,
            'shared_data': self.shared_data,
            'blackboard': getattr(self, 'blackboard', {}),
            'metadata': self.metadata,
            'agent_stack': self.agent_stack,
            'created_at': self.created_at.isoformat()
        }
