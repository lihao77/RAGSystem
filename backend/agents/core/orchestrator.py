# -*- coding: utf-8 -*-
"""
智能体编排器 - 负责智能体的选择、调度和协作
"""

from typing import Dict, List, Any, Optional
import time
import logging

from runtime.dependencies import get_runtime_dependency

from .base import BaseAgent, AgentExecutionError
from .context import AgentContext
from .models import AgentResponse
from .registry import AgentRegistry, get_registry

logger = logging.getLogger(__name__)


class AgentOrchestrator:
    """
    智能体编排器：注册与发现、任务路由、多智能体协作、上下文管理、结果聚合
    """

    def __init__(
        self,
        model_adapter=None,
        registry: Optional[AgentRegistry] = None
    ):
        self.model_adapter = model_adapter
        self.llm_adapter = model_adapter
        self.registry = registry or get_registry()
        self.logger = logging.getLogger(self.__class__.__name__)

    def register_agent(self, agent: BaseAgent):
        self.registry.register(agent)
        self.logger.info(f"已注册智能体: {agent.name}")

    def route_task(
        self,
        task: str,
        context: Optional[AgentContext] = None,
        preferred_agent: Optional[str] = None
    ) -> Optional[BaseAgent]:
        if preferred_agent:
            agent = self.registry.get(preferred_agent)
            if agent and agent.can_handle(task, context):
                self.logger.info(f"使用指定智能体: {agent.name}")
                return agent
            self.logger.warning(f"指定的智能体 '{preferred_agent}' 不可用")

        master_agent = self.registry.get('master_agent_v2')
        if master_agent:
            self.logger.info("使用 MasterAgent V2 作为统一入口")
            return master_agent

        self.logger.warning("MasterAgent V2 未注册，使用降级路由")
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
        if context is None:
            import uuid
            context = AgentContext(session_id=str(uuid.uuid4()))

        context.add_message(role='user', content=task)
        agent = self.route_task(task, context, preferred_agent)

        if agent is None:
            return AgentResponse(
                success=False,
                error="未找到合适的智能体来处理此任务",
                agent_name="orchestrator"
            )

        try:
            start_time = time.time()
            agent.before_execute(task, context)
            result = agent.execute(task, context)
            result.execution_time = time.time() - start_time
            result.agent_name = agent.name
            agent.after_execute(task, context, result)
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
        if context is None:
            import uuid
            context = AgentContext(session_id=str(uuid.uuid4()))

        results = []
        if mode == 'sequential':
            for task_info in tasks:
                task_desc = task_info.get('task', '')
                preferred_agent = task_info.get('agent')
                result = self.execute(
                    task=task_desc,
                    context=context,
                    preferred_agent=preferred_agent
                )
                results.append(result)
                if not result.success:
                    self.logger.warning(f"任务失败: {task_desc}")
        elif mode == 'parallel':
            raise NotImplementedError("并行模式尚未实现")
        else:
            raise ValueError(f"不支持的协作模式: {mode}")
        return results

    def get_agent_info(self, agent_name: str) -> Optional[Dict[str, Any]]:
        agent = self.registry.get(agent_name)
        return agent.get_info() if agent else None

    def list_agents(self) -> List[Dict[str, Any]]:
        return self.registry.list_agents()

    @property
    def agents(self) -> Dict[str, BaseAgent]:
        return self.registry._agents


_global_orchestrator: Optional[AgentOrchestrator] = None


def get_orchestrator(model_adapter=None) -> AgentOrchestrator:
    del model_adapter
    global _global_orchestrator
    return get_runtime_dependency(
        fallback_name='agent_orchestrator',
        fallback_factory=lambda: None,
        legacy_getter=lambda: _global_orchestrator,
        container_resolver=lambda container: container.get_agent_runtime_service().get_orchestrator(),
        require_container=True,
    )
