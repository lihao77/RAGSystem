# -*- coding: utf-8 -*-
"""
智能体编排器 - 负责智能体的选择、调度和协作
"""

from typing import Dict, List, Any, Optional
import time
import logging
from .base import BaseAgent, AgentContext, AgentResponse, AgentExecutionError
from .registry import AgentRegistry, get_registry

logger = logging.getLogger(__name__)


class AgentOrchestrator:
    """
    智能体编排器

    核心功能：
    1. 智能体注册和发现
    2. 任务路由（选择最合适的智能体）
    3. 多智能体协作
    4. 上下文管理
    5. 结果聚合
    """

    def __init__(
        self,
        llm_adapter = None,
        registry: Optional[AgentRegistry] = None
    ):
        """
        初始化编排器

        Args:
            llm_adapter: LLM 适配器（用于降级路由）
            registry: 智能体注册表（默认使用全局注册表）
        """
        self.llm_adapter = llm_adapter
        self.registry = registry or get_registry()
        self.logger = logging.getLogger(self.__class__.__name__)

    def register_agent(self, agent: BaseAgent):
        """
        注册智能体

        Args:
            agent: 智能体实例
        """
        self.registry.register(agent)
        self.logger.info(f"已注册智能体: {agent.name}")

    def route_task(
        self,
        task: str,
        context: Optional[AgentContext] = None,
        preferred_agent: Optional[str] = None
    ) -> Optional[BaseAgent]:
        """
        任务路由 - 选择最合适的智能体

        统一入口策略：所有任务优先通过 MasterAgent 处理

        Args:
            task: 任务描述
            context: 上下文
            preferred_agent: 首选智能体名称（用于测试或特殊场景）

        Returns:
            选中的智能体，如果没有合适的返回 None
        """
        # 1. 如果明确指定智能体（用于测试或特殊场景）
        if preferred_agent:
            agent = self.registry.get(preferred_agent)
            if agent and agent.can_handle(task, context):
                self.logger.info(f"使用指定智能体: {agent.name}")
                return agent
            self.logger.warning(f"指定的智能体 '{preferred_agent}' 不可用")

        # 2. 统一入口：优先使用 MasterAgent
        master_agent = self.registry.get('master_agent')
        if master_agent:
            self.logger.info(f"使用 MasterAgent 作为统一入口")
            return master_agent

        # 3. 降级方案：如果没有 MasterAgent，查找能处理任务的智能体
        self.logger.warning("MasterAgent 未注册，使用降级路由")
        capable_agents = self.registry.find_capable_agents(task, context)
        if capable_agents:
            agent = capable_agents[0]
            self.logger.info(f"降级使用智能体: {agent.name}")
            return agent

        self.logger.error(f"未找到能处理任务的智能体: {task}")
        return None

    def execute(
        self,
        task: str,
        context: Optional[AgentContext] = None,
        preferred_agent: Optional[str] = None
    ) -> AgentResponse:
        """
        执行任务

        流程：
        1. 创建或使用现有上下文
        2. 选择智能体
        3. 执行任务
        4. 返回结果

        Args:
            task: 任务描述
            context: 执行上下文（可选，不提供则自动创建）
            preferred_agent: 首选智能体名称

        Returns:
            AgentResponse
        """
        # 创建上下文
        if context is None:
            import uuid
            context = AgentContext(session_id=str(uuid.uuid4()))

        # 添加用户消息到历史
        context.add_message(role='user', content=task)

        # 选择智能体
        agent = self.route_task(task, context, preferred_agent)

        if agent is None:
            return AgentResponse(
                success=False,
                error="未找到合适的智能体来处理此任务",
                agent_name="orchestrator"
            )

        # 执行任务
        try:
            start_time = time.time()

            # 前置钩子
            agent.before_execute(task, context)

            # 执行
            result = agent.execute(task, context)

            # 记录执行时间
            result.execution_time = time.time() - start_time
            result.agent_name = agent.name

            # 后置钩子
            agent.after_execute(task, context, result)

            # 添加助手消息到历史
            if result.content:
                context.add_message(
                    role='assistant',
                    content=result.content,
                    metadata={'agent': agent.name}
                )

            return result

        except Exception as e:
            self.logger.error(f"执行任务失败: {e}", exc_info=True)
            return AgentResponse(
                success=False,
                error=str(e),
                agent_name=agent.name
            )

    def collaborate(
        self,
        tasks: List[Dict[str, Any]],
        context: Optional[AgentContext] = None,
        mode: str = 'sequential'
    ) -> List[AgentResponse]:
        """
        多智能体协作

        Args:
            tasks: 任务列表，每个任务格式：
                   {'task': '任务描述', 'agent': '智能体名称(可选)'}
            context: 共享上下文
            mode: 协作模式
                  - 'sequential': 串行执行（默认）
                  - 'parallel': 并行执行（未来支持）

        Returns:
            AgentResponse 列表
        """
        # 创建上下文
        if context is None:
            import uuid
            context = AgentContext(session_id=str(uuid.uuid4()))

        results = []

        if mode == 'sequential':
            # 串行执行
            for task_info in tasks:
                task_desc = task_info.get('task', '')
                preferred_agent = task_info.get('agent')

                result = self.execute(
                    task=task_desc,
                    context=context,
                    preferred_agent=preferred_agent
                )
                results.append(result)

                # 如果某个任务失败，可以选择继续或终止
                if not result.success:
                    self.logger.warning(f"任务失败: {task_desc}")
                    # 这里可以根据配置决定是否继续

        elif mode == 'parallel':
            # 并行执行（未来实现）
            raise NotImplementedError("并行模式尚未实现")

        else:
            raise ValueError(f"不支持的协作模式: {mode}")

        return results

    def get_agent_info(self, agent_name: str) -> Optional[Dict[str, Any]]:
        """获取智能体信息"""
        agent = self.registry.get(agent_name)
        return agent.get_info() if agent else None

    def list_agents(self) -> List[Dict[str, Any]]:
        """列出所有可用智能体"""
        return self.registry.list_agents()

    @property
    def agents(self) -> Dict[str, 'BaseAgent']:
        """
        获取所有已注册的智能体字典（只读）

        Returns:
            Dict[str, BaseAgent]: 智能体名称到实例的映射
        """
        return self.registry._agents


# 全局单例
_global_orchestrator: Optional[AgentOrchestrator] = None


def get_orchestrator(llm_adapter = None) -> AgentOrchestrator:
    """
    获取全局智能体编排器

    Args:
        llm_adapter: LLM 适配器（仅在首次调用时设置）

    Returns:
        AgentOrchestrator 单例
    """
    global _global_orchestrator
    if _global_orchestrator is None:
        _global_orchestrator = AgentOrchestrator(llm_adapter=llm_adapter)
    return _global_orchestrator
