# -*- coding: utf-8 -*-
"""
智能体基类 - 所有智能体的抽象基类
"""

from abc import ABC, abstractmethod
from typing import Dict, List, Any, Optional, Set
from dataclasses import dataclass, field
from datetime import datetime
import logging
import copy
import uuid

logger = logging.getLogger(__name__)


@dataclass
class AgentResponse:
    """智能体响应"""
    success: bool
    content: str = ""                      # 文本内容
    data: Optional[Dict[str, Any]] = None  # 结构化数据
    metadata: Dict[str, Any] = field(default_factory=dict)  # 元数据
    error: Optional[str] = None            # 错误信息

    # 执行信息
    agent_name: str = ""                   # 执行的智能体名称
    execution_time: float = 0.0            # 执行时间（秒）
    tool_calls: List[Dict] = field(default_factory=list)  # 工具调用记录
    
    # 评估指标 (Context Self-Management)
    metrics: Dict[str, Any] = field(default_factory=dict)  # 如 usefulness_score


    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            'success': self.success,
            'content': self.content,
            'data': self.data,
            'metadata': self.metadata,
            'error': self.error,
            'agent_name': self.agent_name,
            'execution_time': self.execution_time,
            'tool_calls': self.tool_calls
        }


@dataclass
class Message:
    """消息"""
    role: str                              # user, assistant, system
    content: str
    timestamp: datetime = field(default_factory=datetime.now)
    metadata: Dict[str, Any] = field(default_factory=dict)


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
        parent: Optional['AgentContext'] = None
    ):
        self.session_id = session_id
        self.user_id = user_id
        
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
        else:
            self.shared_data: Dict[str, Any] = initial_data or {}
            self.blackboard: Dict[str, Any] = {}   # 结构化黑板 {key: {'value': v, 'tags': [], 'timestamp': t}}
            self.parent = None
            self.level = 0

        # 执行跟踪
        self.agent_stack: List[str] = []  # 智能体调用栈
        self.created_at = datetime.now()

    def fork(self) -> 'AgentContext':
        """
        派生子上下文 (Create Child Context)
        
        用于子智能体执行，拥有独立的 conversation_history，但共享 session_id 和 blackboard。
        """
        child = AgentContext(
            session_id=self.session_id,
            user_id=self.user_id,
            parent=self
        )
        # 复制当前的 agent_stack
        child.agent_stack = list(self.agent_stack)
        return child

    def merge(self, child_context: 'AgentContext', result: AgentResponse):
        """
        合并子上下文 (Merge Child Context)
        
        将子智能体的关键结果合并回当前上下文。
        注意：默认不合并子智能体的详细对话历史，只保留结果。
        """
        # 1. 自动同步黑板数据 (因为是引用共享，其实已经同步了，这里做触发器处理)
        pass 
        
        # 2. 记录子任务执行元数据
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

    def add_message(self, role: str, content: str, metadata: Optional[Dict] = None):
        """添加消息到对话历史"""
        message = Message(
            role=role,
            content=content,
            metadata=metadata or {}
        )
        self.conversation_history.append(message)

    def get_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """
        获取对话历史

        Args:
            limit: 返回最近 N 条消息

        Returns:
            消息列表，格式：[{'role': 'user', 'content': '...'}]
        """
        recent_messages = self.conversation_history[-limit:] if limit > 0 else self.conversation_history
        return [
            {
                'role': msg.role,
                'content': msg.content,
                'timestamp': msg.timestamp.isoformat()
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


from .context_manager import ContextManager, ContextConfig

class BaseAgent(ABC):
    """
    智能体基类

    所有智能体必须继承此类并实现 execute 方法
    """

    def __init__(
        self,
        name: str,
        description: str,
        capabilities: Optional[List[str]] = None,
        model_adapter = None,
        agent_config = None,
        system_config = None
    ):
        """
        初始化智能体

        Args:
            name: 智能体名称（唯一标识）
            description: 智能体描述
            capabilities: 能力列表
            model_adapter: Model 适配器实例
            agent_config: 智能体独立配置（AgentConfig 实例）
            system_config: 系统全局配置（用于降级）
        """
        self.name = name
        self.description = description
        self.capabilities = capabilities or []
        self.model_adapter = model_adapter
        # 兼容旧属性名 (已废弃，建议使用 model_adapter)
        self.llm_adapter = model_adapter
        self.logger = logging.getLogger(f"Agent.{name}")

        # 配置管理
        self.agent_config = agent_config  # 智能体独立配置
        self.system_config = system_config  # 系统全局配置

        # 上下文管理器 (Unified Infrastructure)
        # 每个 Agent 都可以使用这个管理器来管理自己的 Local Context
        self.context_manager = ContextManager()

        # 工具列表（子类可以重写）
        self.tools: List[Dict[str, Any]] = []

    @abstractmethod
    def execute(
        self,
        task: str,
        context: AgentContext
    ) -> AgentResponse:
        """
        执行任务（子类必须实现）

        Args:
            task: 任务描述
            context: 执行上下文

        Returns:
            AgentResponse
        """
        pass

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务（子类可以重写）

        默认实现：基于关键词匹配

        Args:
            task: 任务描述
            context: 上下文（可选）

        Returns:
            True 表示可以处理，False 表示不能处理
        """
        # 默认返回 True，子类可以重写实现更复杂的逻辑
        return True

    def before_execute(self, task: str, context: AgentContext):
        """
        执行前钩子（子类可以重写）

        用于执行前的准备工作，如验证参数、初始化资源等
        """
        self.logger.info(f"[{self.name}] 开始执行任务: {task}")
        context.push_agent(self.name)

    def after_execute(self, task: str, context: AgentContext, result: AgentResponse):
        """
        执行后钩子（子类可以重写）

        用于执行后的清理工作，如释放资源、记录日志等
        """
        context.pop_agent()
        self.logger.info(
            f"[{self.name}] 任务完成: success={result.success}, "
            f"time={result.execution_time:.2f}s"
        )

    def get_info(self) -> Dict[str, Any]:
        """
        获取智能体信息

        Returns:
            包含名称、描述、能力等信息的字典
        """
        info = {
            'name': self.name,
            'description': self.description,
            'capabilities': self.capabilities,
            'tools': [tool.get('function', {}).get('name') for tool in self.tools]
        }

        # 添加配置信息
        if self.agent_config:
            info['config'] = {
                'enabled': self.agent_config.enabled,
                'llm': self.agent_config.llm.to_dict(),
                'custom_params': self.agent_config.custom_params
            }

        return info

    def get_llm_config(self) -> Dict[str, Any]:
        """
        获取 LLM 配置（优先使用智能体配置，否则使用系统配置）

        Returns:
            LLM 配置字典，包含 provider, model_name, temperature 等
        """
        config = {}
        
        # 1. 尝试从 AgentConfig 获取
        if self.agent_config and self.agent_config.llm:
             # merge_with_default 应该处理好优先级
             config = self.agent_config.llm.merge_with_default(self.system_config)
             
        # 2. 如果没有 AgentConfig，尝试从 system_config 获取
        elif self.system_config:
            # 适配 backend/config/models.py 的 LLMConfig
            llm_config = getattr(self.system_config, 'llm', None)
            if llm_config:
                config = {
                    'provider': getattr(llm_config, 'provider', None),
                    'provider_type': getattr(llm_config, 'provider_type', None),
                    'model_name': getattr(llm_config, 'model_name', None),
                    'temperature': getattr(llm_config, 'temperature', 0.7),
                    'max_tokens': getattr(llm_config, 'max_tokens', 4096)
                }

        # 3. 默认值
        if not config:
            self.logger.warning(f"[{self.name}] 未配置 LLM，使用默认配置")
            config = {
                'temperature': 0.7,
                'max_tokens': 4096
            }
            
        # 确保 provider 存在 (用于 model_adapter)
        if 'provider' not in config or not config['provider']:
            # 如果没有指定 provider，尝试从 adapter 获取默认的
            # 但这里我们只是返回配置，具体调用时 adapter 会处理
            pass
            
        return config

    def get_custom_param(self, key: str, default: Any = None) -> Any:
        """
        获取自定义参数

        Args:
            key: 参数键
            default: 默认值

        Returns:
            参数值
        """
        if self.agent_config and self.agent_config.custom_params:
            return self.agent_config.custom_params.get(key, default)
        return default

    def is_tool_enabled(self, tool_name: str) -> bool:
        """
        检查工具是否启用

        Args:
            tool_name: 工具名称

        Returns:
            是否启用
        """
        if self.agent_config and self.agent_config.tools:
            enabled_tools = self.agent_config.tools.enabled_tools
            # 如果列表为空，表示启用所有工具
            return not enabled_tools or tool_name in enabled_tools
        return True  # 默认启用所有工具

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__}(name='{self.name}')>"


class AgentExecutionError(Exception):
    """智能体执行错误"""

    def __init__(self, agent_name: str, message: str, original_error: Optional[Exception] = None):
        self.agent_name = agent_name
        self.message = message
        self.original_error = original_error
        super().__init__(f"[{agent_name}] {message}")
