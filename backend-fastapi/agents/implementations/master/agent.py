# -*- coding: utf-8 -*-
"""
Master Agent V2 - 动态智能体编排器。
"""

import logging
from typing import Any, Dict, Optional

from agents.context.config import ContextConfig
from agents.context.observation_formatter import ObservationFormatter
from agents.context.pipeline import ContextPipeline
from agents.core import AgentContext, AgentResponse, BaseAgent

from .executor import AgentExecutor
from .prompting import (
    build_system_prompt,
    format_agent_result_summary,
    get_agent_display_name,
    get_available_agent_tools,
    handle_user_input_request,
    replace_placeholders,
)
from .runtime import execute_master

logger = logging.getLogger(__name__)


class MasterAgentV2(BaseAgent):
    """
    Master Agent V2 - 动态智能体编排器

    核心特性：
    1. **Agent 作为工具**: 将其他 Agent 视为可调用的工具
    2. **ReAct 模式**: 使用推理-行动循环，动态决定调用哪个 Agent
    3. **XML 流式输出**: 实时展示思考和回答过程
    4. **完全可观察**: 每次 Agent 调用都有明确的输入输出
    """
    def __init__(
        self,
        orchestrator,
        model_adapter=None,
        agent_config=None,
        system_config=None,
        available_tools=None,
        available_skills=None
    ):
        """
        初始化 Master Agent V2

        Args:
            orchestrator: AgentOrchestrator 实例（用于访问其他 Agent）
            model_adapter: Model 适配器
            agent_config: 智能体配置
            system_config: 系统配置
            available_tools: 可直接调用的工具列表（来自 agent_configs.yaml 的 tools 配置）
            available_skills: 可用的 Skills 列表（来自 agent_configs.yaml 的 skills 配置）
        """
        super().__init__(
            name='master_agent_v2',
            description='动态智能体编排器，将 Agent 当作工具使用',
            capabilities=[
                'dynamic_planning',
                'agent_coordination',
                'adaptive_execution'
            ],
            model_adapter=model_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.orchestrator = orchestrator
        self.agent_executor = AgentExecutor(orchestrator)
        self._publisher = None  # EventPublisher 实例（延迟创建）

        # 自动注入内置工具（Human-in-the-Loop：request_user_input）
        from agents.tools.builtin import get_builtin_tools_for_master
        self.available_tools = get_builtin_tools_for_master(available_tools or [])
        self.available_skills = available_skills or []

        # 从配置获取行为参数
        behavior_config = agent_config.custom_params.get('behavior', {}) if agent_config else {}
        self.max_rounds = behavior_config.get('max_rounds', 15)  # V2 可能需要更多轮次
        self.base_prompt = behavior_config.get('system_prompt', '')

        # 获取模型的上下文限制
        llm_config = self.get_llm_config()
        from agents.context.budget import compute_context_budget, DEFAULT_MAX_COMPLETION_TOKENS, MASTER_FALLBACK_MULTIPLIER
        # 兼容新旧字段名：优先使用 max_completion_tokens，回退到 max_tokens
        model_max_tokens = llm_config.get('max_completion_tokens') or llm_config.get('max_tokens', DEFAULT_MAX_COMPLETION_TOKENS)
        model_context_window = llm_config.get('max_context_tokens')

        max_context_tokens = compute_context_budget(
            model_context_window=model_context_window,
            max_completion_tokens=model_max_tokens,
            explicit_budget=behavior_config.get('max_context_tokens'),
            fallback_multiplier=MASTER_FALLBACK_MULTIPLIER,
        )

        # 初始化上下文组件（使用 ContextPipeline 统一入口）
        context_config = ContextConfig(
            max_tokens=max_context_tokens,
            model_name=llm_config.get('model_name'),
            compression_trigger_ratio=behavior_config.get('compression_trigger_ratio', 0.85),
            summarize_max_tokens=behavior_config.get('summarize_max_tokens', 300),
            preserve_recent_turns=behavior_config.get('preserve_recent_turns', 3),
        )
        self.context_pipeline = ContextPipeline(
            config=context_config,
            model_adapter=self.model_adapter,
            get_llm_config_fn=lambda task_type=None: self.get_llm_config(task_type=task_type),
            logger=self.logger,
        )

        # 初始化观察结果格式化器
        self.observation_formatter = ObservationFormatter(
            data_save_dir=behavior_config.get('data_save_dir', './static/temp_data')
        )

        # 注意：不在初始化时生成 Agent 工具列表
        # 因为此时其他 Agent 可能还未注册到 orchestrator
        # 延迟到 _get_available_agent_tools() 方法中动态获取

        logger.info(
            f"MasterAgentV2 初始化完成，"
            f"模型 max_tokens: {model_max_tokens}, "
            f"上下文预算: {max_context_tokens} tokens"
        )

    def _get_agent_display_name(self, agent_name: str) -> str:
        return get_agent_display_name(self, agent_name)


    def _replace_placeholders(self, data: Any, agent_results: Dict[int, Dict[str, Any]]) -> Any:
        return replace_placeholders(self, data, agent_results)


    def _format_agent_result_summary(self, result: Dict[str, Any]) -> str:
        return format_agent_result_summary(self, result)


    def _get_available_agent_tools(self):
        return get_available_agent_tools(self)


    def _handle_user_input_request(
        self,
        arguments: dict,
        event_bus,
        session_id: str,
        tool_call_id: str,
        publisher=None,
        parent_call_id: str = None,
    ):
        return handle_user_input_request(
            self,
            arguments=arguments,
            event_bus=event_bus,
            session_id=session_id,
            tool_call_id=tool_call_id,
            publisher=publisher,
            parent_call_id=parent_call_id,
        )


    def _build_system_prompt(self) -> str:
        return build_system_prompt(self)


    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        return execute_master(self, task, context)


    def stream_execute(self, task: str, context: AgentContext) -> AgentResponse:
        return self.execute(task, context)


    def execute_stream(self, task: str, context: AgentContext) -> AgentResponse:
        return self.execute(task, context)


    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        return True
