# -*- coding: utf-8 -*-
"""
Master Agent V2 - 动态智能体编排器

设计理念：将 Agent 当作工具，通过 ReAct 模式动态调用
"""

import logging
import json
import time
from typing import Dict, List, Any, Optional, Generator

from agents.core import BaseAgent, AgentContext, AgentResponse, InterruptedError, parse_llm_json
from agents.context import ContextConfig, ObservationFormatter, ContextPipeline
from .function_definitions import get_agent_tools
from .executor import AgentExecutor, parse_agent_invocation
from agents.events import get_session_event_bus, EventPublisher

logger = logging.getLogger(__name__)


class MasterAgentV2(BaseAgent):
    """
    Master Agent V2 - 动态智能体编排器

    核心特性：
    1. **Agent 作为工具**: 将其他 Agent 视为可调用的工具
    2. **ReAct 模式**: 使用推理-行动循环，动态决定调用哪个 Agent
    3. **完全可观察**: 每次 Agent 调用都有明确的输入输出
    4. **灵活编排**: 不依赖预设的 DAG，根据任务进展实时决策

    与 Master V1 的区别：
    - V1: 预先分析任务 → 生成 DAG → 按计划执行 → 整合结果
    - V2: 分析任务 → 调用 Agent → 观察结果 → 决定下一步 → ... → 生成答案

    优势：
    - 更灵活：可以根据中间结果调整策略
    - 更自主：Master 自己决定何时调用哪个 Agent
    - 更可靠：每一步都可观察，易于调试
    """

    # 输出格式定义（与 ReAct Agent 类似）
    RESPONSE_SCHEMA = {
        "type": "object",
        "properties": {
            "thought": {
                "type": "string",
                "description": "当前的思考过程和决策理由"
            },
            "actions": {
                "type": "array",
                "description": "要执行的 Agent 调用列表（可以一次调用多个独立的 Agent）",
                "items": {
                    "type": "object",
                    "properties": {
                        "tool": {"type": "string", "description": "Agent 工具名称（如 invoke_agent_qa_agent）"},
                        "arguments": {"type": "object", "description": "Agent 参数"}
                    }
                }
            },
            "final_answer": {
                "type": "string",
                "description": "如果已经有足够信息，提供最终答案；否则为null"
            }
        },
        "required": ["thought"]
    }

    def __init__(
        self,
        orchestrator,
        model_adapter=None,
        agent_config=None,
        system_config=None
    ):
        """
        初始化 Master Agent V2

        Args:
            orchestrator: AgentOrchestrator 实例（用于访问其他 Agent）
            model_adapter: Model 适配器
            agent_config: 智能体配置
            system_config: 系统配置
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

        # 初始化上下文管理器 (使用 ContextPipeline 统一入口)
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
        """
        获取 Agent 的友好显示名称

        Args:
            agent_name: Agent 技术名称（如 'kgqa_agent'）

        Returns:
            str: 友好显示名称（如 '知识图谱问答智能体'）
        """
        # 尝试从 orchestrator 获取智能体实例
        agent = self.orchestrator.agents.get(agent_name)

        # 如果智能体存在且有配置，从配置中获取 display_name
        if agent and hasattr(agent, 'agent_config') and agent.agent_config:
            display_name = agent.agent_config.display_name
            if display_name:
                return display_name

        # 降级：直接返回技术名称
        return agent_name

    def _replace_placeholders(self, data: Any, agent_results: Dict[int, Dict[str, Any]]) -> Any:
        """
        递归替换数据中的占位符（优化版）

        支持的占位符格式:
        - {result_1}, {result_2}, ... - 引用第N个Agent的完整结果
        - {result1}, {result2}, ...   - 简化格式（兼容）

        优化：
        1. 预检：快速判断是否包含占位符，避免无用递归
        2. 缓存：避免重复替换相同的字符串

        Args:
            data: 要处理的数据（可以是字符串、字典、列表等）
            agent_results: Agent结果字典 {1: result1, 2: result2, ...}

        Returns:
            替换后的数据
        """
        import re

        # 🎯 优化 1：预检 - 快速判断是否包含占位符
        # 避免对不包含占位符的数据进行递归遍历
        data_str = str(data)
        if '{result' not in data_str:
            return data  # 提前返回，节省递归开销

        if isinstance(data, str):
            # 字符串：查找并替换所有占位符
            # 匹配 {result_N} 或 {resultN}
            pattern = r'\{result_?(\d+)\}'

            def replace_func(match):
                idx = int(match.group(1))
                if idx not in agent_results:
                    self.logger.warning(f"占位符 {match.group(0)} 引用的结果不存在")
                    return match.group(0)  # 保持原样

                result = agent_results[idx]
                if not result.get('success'):
                    return f"[Agent {idx} 执行失败: {result.get('error', '未知错误')}]"

                # 提取结果内容
                data_dict = result.get('data', {})
                results = data_dict.get('results', '')

                # 如果是字符串，直接返回
                if isinstance(results, str):
                    return results
                # 如果是字典或列表，转为 JSON 字符串
                elif isinstance(results, (dict, list)):
                    return json.dumps(results, ensure_ascii=False, indent=2)
                else:
                    return str(results)

            return re.sub(pattern, replace_func, data)

        elif isinstance(data, dict):
            # 字典：递归处理每个值
            return {key: self._replace_placeholders(value, agent_results) for key, value in data.items()}

        elif isinstance(data, list):
            # 列表：递归处理每个元素
            return [self._replace_placeholders(item, agent_results) for item in data]

        else:
            # 其他类型：直接返回
            return data

    def _format_agent_result_summary(self, result: Dict[str, Any]) -> str:
        """
        格式化 Agent 执行结果为摘要文本

        Args:
            result: Agent 执行结果

        Returns:
            str: 结果摘要（完整内容或截断）
        """
        if not result.get('success'):
            error = result.get('error', '未知错误')
            return f"执行失败: {error}"

        # 提取结果内容
        data = result.get('data', {})
        results = data.get('results', '')

        # 🎯 优先使用完整的 results（这是子 Agent 的 final_answer）
        if isinstance(results, str) and results:
            # 如果内容较短（≤500字符），返回完整内容
            if len(results) <= 500:
                return results
            # 否则截断
            return results[:500] + "..."
        elif isinstance(results, dict):
            # 字典结果：显示键数量
            return f"返回了 {len(results)} 个字段"
        elif isinstance(results, list):
            # 列表结果：显示元素数量
            return f"返回了 {len(results)} 条记录"
        else:
            # 降级：使用 summary
            summary = data.get('summary', '')
            return summary if summary else "执行成功"

    def _get_available_agent_tools(self):
        """
        动态获取可用的 Agent 工具列表

        延迟到执行时获取，确保其他 Agent 已经注册
        """
        return get_agent_tools(self.orchestrator.agents)

    def _build_system_prompt(self) -> str:
        """构建系统提示词"""
        # 动态获取 Agent 工具列表（延迟获取，确保其他 Agent 已注册）
        available_agent_tools = self._get_available_agent_tools()

        # 构建 Agent 工具说明
        agent_tools_desc_lines = []
        for tool in available_agent_tools:
            func = tool['function']
            name = func['name']
            desc = func['description']

            agent_tools_desc_lines.append(f"\n### {name}")
            agent_tools_desc_lines.append(f"{desc}")

        agent_tools_desc = "\n".join(agent_tools_desc_lines)

        # 构造示例（使用第一个可用的 Agent 工具）
        example_tool_name = available_agent_tools[0]['function']['name'] if available_agent_tools else "invoke_agent_qa_agent"

        parallel_example = f"""```json
{{
  "thought": "分析用户任务，决定调用哪个 Agent 来处理",
  "actions": [
    {{
      "tool": "{example_tool_name}",
      "arguments": {{
        "task": "要委托给 Agent 的具体任务描述",
        "context_hint": "可选的上下文提示"
      }}
    }}
  ],
  "final_answer": null
}}
```"""

        return f"""{self.base_prompt}

## 可用的 Agent 工具

你可以调用以下 Agent 来完成不同类型的任务：

{agent_tools_desc}

## 工作方式（ReAct 模式）

你是一个智能体编排器，通过**推理-行动-观察**的循环来完成复杂任务：

1. **Thought（推理）**: 分析当前情况，决定下一步调用哪个 Agent
2. **Action（行动）**: 调用选定的 Agent 工具
3. **Observation（观察）**: 观察 Agent 的执行结果
4. **重复**: 根据观察结果决定是否需要调用其他 Agent，或生成最终答案

**输出格式**:

```json
{{
  "thought": "我的思考过程...",
  "actions": [
    {{
      "tool": "Agent工具名称",
      "arguments": {{"task": "具体任务描述", "context_hint": "上下文提示"}}
    }}
  ],
  "final_answer": null  // 如果还没有最终答案
}}
```

**重要规则：**

1. **只能使用上面"可用的 Agent 工具"部分列出的工具**
2. **thought 必须简洁**（不超过100字）
   - 说明为什么选择这个 Agent
   - 说明期望 Agent 完成什么任务
3. **可以一次调用多个 Agent**（如果它们之间没有依赖）
4. **链式调用**：如果 Agent B 依赖 Agent A 的结果，可以在同一轮中链式调用
   - 使用占位符 {{result_1}} 引用第1个 Agent 的结果
   - 使用占位符 {{result_2}} 引用第2个 Agent 的结果
   - 以此类推
5. **当你有足够信息回答用户问题时，在 final_answer 中给出答案**
6. **如果 Agent 返回错误，在下一轮 thought 中分析原因并调整策略**

**决策指南：**

- 如果任务涉及知识图谱查询、数据分析 → 调用 invoke_agent_qa_agent
- 如果需要执行预定义的工作流 → 调用 invoke_agent_workflow_agent
- 如果任务很简单（如问候、闲聊） → 直接生成 final_answer，不调用 Agent
- 如果需要多个步骤 → 按顺序调用相应的 Agent，每次观察结果后再决定下一步

**示例**:
{parallel_example}

只返回 JSON，不要有其他内容。
"""

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """
        执行任务（通过事件总线发布事件，实现真正的解耦）

        不再使用 yield 返回事件，所有事件通过事件总线发布
        """
        start_time = time.time()

        # ✨ 获取会话级事件总线并创建事件发布器
        event_bus = get_session_event_bus(context.session_id)

        import uuid
        # 生成 MasterAgent 自己的 call_id（唯一，贯穿整个执行）
        master_call_id = f"call_{uuid.uuid4()}"
        run_id = context.metadata.get('run_id') or str(uuid.uuid4())

        # 从 context 获取 parent_call_id（如果 MasterAgent 被其他智能体调用）
        parent_call_id = None
        if hasattr(context, 'metadata'):
            parent_call_id = context.metadata.get('parent_call_id')

        self._publisher = EventPublisher(
            agent_name=self.name,
            session_id=context.session_id,
            trace_id=context.metadata.get('trace_id'),
            span_id=context.metadata.get('span_id'),
            call_id=master_call_id,
            parent_call_id=parent_call_id,
            event_bus=event_bus
        )

        # 2. 发布运行开始事件 (Run)
        self._publisher.run_start(run_id=run_id, metadata={"task": task})

        # 3. 发布 MasterAgent 自己的 CALL_AGENT_START 事件
        self._publisher.agent_call_start(
            call_id=master_call_id,
            agent_name=self.name,
            description=task
        )

        # 4. 发布 Agent 开始事件（保留原有的 agent_start）
        self._publisher.agent_start(task, metadata={
            "agent_name": self.name,
            "display_name": "MasterAgent V2",
            "max_rounds": self.max_rounds,
            "run_id": run_id,
            "call_id": master_call_id
        })

        try:
            # 构建当次执行的消息列表（从 task 开始）
            current_session = [{"role": "user", "content": task}]

            rounds = 0
            agent_calls_history = []
            global_agent_order = 0  # 🎯 全局 Agent 调用计数器

            while rounds < self.max_rounds:
                rounds += 1
                # 检查中断
                self._check_interrupt(context)

                # 获取 LLM 配置（含请求级 context.llm_override），用于调用与日志前缀
                llm_config = self.get_llm_config(context)
                log_prefix = self._log_prefix(llm_config, "MasterV2")

                self.logger.info(f"{log_prefix} 第 {rounds} 轮推理")

                # 应用上下文管理
                managed_messages = self.context_pipeline.prepare_messages(
                    system_prompt=self._build_system_prompt(),
                    context=context,
                    current_session=current_session,
                    publisher=self._publisher,
                )
                self.logger.info(f"{log_prefix} {self.context_pipeline.format_summary(managed_messages)}")

                # 发送上下文用量事件
                if self._publisher:
                    from agents.events.bus import EventType
                    current_tokens = self.context_pipeline._token_counter.count_messages(managed_messages)
                    self._publisher._publish(EventType.CONTEXT_USAGE, {
                        'used_tokens': current_tokens,
                        'max_tokens': self.context_pipeline.config.max_tokens,
                        'round': rounds
                    })

                # 调用 LLM（使用 JSON mode）
                response = self.model_adapter.chat_completion(
                    messages=managed_messages,
                    provider=llm_config.get('provider'),
                    model=llm_config.get('model_name'),
                    provider_type=llm_config.get('provider_type'),
                    temperature=llm_config.get('temperature', 0.3),
                    max_tokens=llm_config.get('max_tokens'),
                    response_format={"type": "json_object"},
                    cancel_event=context.metadata.get('cancel_event')
                )

                # 检查中断
                self._check_interrupt(context)

                if response.error:
                    # ✨ 使用事件发布器发布错误
                    self._publisher.agent_error(
                        error=f"LLM 调用失败: {response.error}",
                        error_type="LLMError"
                    )
                    # ✨ 发布运行结束事件，确保 SSE 流正确终止
                    self._publisher.run_end(
                        run_id=run_id,
                        status="error",
                        summary=f"LLM 调用失败: {response.error}"
                    )
                    return AgentResponse(
                        success=False,
                        error=f"LLM 调用失败: {response.error}",
                        agent_name=self.name,
                        execution_time=time.time() - start_time
                    )

                # 解析 JSON 响应（使用 base 提供的 parse_llm_json，支持代码块、前后缀等）
                content = (response.content or "").strip()
                output, parse_err = parse_llm_json(content)
                if output is None:
                    raw_preview = content[:500]
                    self.logger.warning(
                        f"{log_prefix} JSON 解析失败: {parse_err}，原始响应预览: {raw_preview!r}"
                    )
                    if content:
                        output = {
                            "thought": "模型返回了非 JSON 格式，已作为直接回复处理。",
                            "actions": [],
                            "final_answer": content
                        }
                        self.logger.info(f"{log_prefix} 已降级为纯文本回复 (长度 {len(content)} 字符)")
                    else:
                        self._publisher.agent_error(
                            error=f"LLM 返回无效的 JSON 或空响应: {parse_err}",
                            error_type="JSONDecodeError"
                        )
                        return AgentResponse(
                            success=False,
                            error=f"LLM 返回无效的 JSON 或空响应: {parse_err}",
                            agent_name=self.name,
                            execution_time=time.time() - start_time
                        )

                thought = output.get('thought', '')
                actions = output.get('actions', [])
                final_answer = output.get('final_answer')

                self.logger.info(f"{log_prefix} Thought: {thought[:100]}...")

                # ✨ 发布结构化思考事件（携带轮次信息，便于前端分组展示）
                self._publisher.thought_structured(
                    thought=thought,
                    actions=[a.get('tool') for a in actions] if actions else [],
                    reasoning=f"第 {rounds} 轮推理",
                    round=rounds,
                )

                # 🎯 如果有 Agent 调用，需要先发送 subtask_start，再发送 thought
                # 但如果没有 Agent 调用，则不需要 subtask_start
                # 为了简化，我们在执行 Agent 调用的循环中发送 thought_structured

                # 添加 assistant 消息
                current_session.append({
                    "role": "assistant",
                    "content": response.content
                })

                # 🔄 持久化中间 assistant 消息（final_answer 有独立路径）
                if not final_answer:
                    self._publisher.react_intermediate(
                        role="assistant", content=response.content,
                        round=rounds, msg_type="thought"
                    )

                # 检查是否有最终答案
                if final_answer:
                    self.logger.info(f"{log_prefix} 得到最终答案")

                    # ✨ 发布最终答案事件（通过事件总线流式输出）
                    self._publisher.final_answer(final_answer)

                    # ✨ 发布 MasterAgent 自己的 CALL_AGENT_END 事件
                    self._publisher.agent_call_end(
                        call_id=master_call_id,
                        agent_name=self.name,
                        result=final_answer,
                        success=True
                    )

                    # ✨ 发布Agent结束和运行结束事件
                    self._publisher.agent_end(final_answer, execution_time=time.time() - start_time)
                    self._publisher.run_end(run_id=run_id, status="success", summary=f"任务完成，共 {rounds} 轮推理，{len(agent_calls_history)} 次Agent调用")

                    return AgentResponse(
                        success=True,
                        content=final_answer,
                        agent_name=self.name,
                        execution_time=time.time() - start_time,
                        metadata={
                            'rounds': rounds,
                            'agent_calls': len(agent_calls_history)
                        }
                    )

                # 执行 Agent 调用
                if actions and len(actions) > 0:
                    self.logger.info(f"{log_prefix} 执行 {len(actions)} 个 Agent 调用")

                    observations = []
                    agent_results = {}

                    for idx, action in enumerate(actions, 1):
                        # 每个 Agent 调用前检查中断
                        self._check_interrupt(context)

                        tool_name = action.get('tool')
                        arguments = action.get('arguments', {})

                        if not tool_name:
                            continue

                        # 🎯 替换占位符（如 {result_1}, {result_2} 等）
                        # 这样可以实现链式调用，Agent B 可以引用 Agent A 的结果
                        original_arguments = arguments.copy()
                        arguments = self._replace_placeholders(arguments, agent_results)

                        # 如果发生了替换，记录日志
                        if original_arguments != arguments:
                            self.logger.info(f"{log_prefix} 占位符替换: {original_arguments} -> {arguments}")

                        # 解析出 Agent 名称
                        agent_name = parse_agent_invocation(tool_name)
                        if not agent_name:
                            error_msg = f"无效的 Agent 工具名称: {tool_name}"
                            self.logger.warning(f"{log_prefix} {error_msg}")
                            observations.append(f"**Agent 调用 {idx}**: 失败\n错误: {error_msg}")
                            continue

                        # 🎯 使用全局计数器确保每个 Agent 有唯一的 order
                        global_agent_order += 1
                        current_order = global_agent_order

                        # 提取参数
                        agent_task = arguments.get('task', '')
                        context_hint = arguments.get('context_hint')

                        self.logger.info(f"{log_prefix} [{idx}/{len(actions)}] 调用 Agent: {agent_name} (全局顺序: {current_order}, 轮次: {rounds}-{idx})")
                        self.logger.info(f"{log_prefix} 任务: {agent_task[:100]}...")

                        # 🎯 使用新版 call_id（原 task_id）
                        call_id = f"call_{run_id}_{rounds}_{idx}"
                        agent_display_name = self._get_agent_display_name(agent_name)

                        # ✨ 发布 AgentCall 开始事件（parent_call_id 指向 MasterAgent 的 call_id）
                        self._publisher.agent_call_start(
                            call_id=call_id,
                            agent_name=agent_name,
                            description=agent_task,
                            parent_call_id=master_call_id,  # ✨ 关联到 MasterAgent 的调用
                            order=current_order,
                            round=rounds,
                            round_index=idx
                        )

                        # 🎯 派生子上下文 (Context Forking)
                        # 为子 Agent 创建独立的执行环境，避免污染 Master 的上下文
                        child_context = context.fork()
                        self.logger.info(f"{log_prefix} 已派生子上下文 (Level {child_context.level})")

                        # ✨ 将 call_id 传递到子 Agent 的 context
                        if not hasattr(child_context, 'metadata'):
                            child_context.metadata = {}
                        child_context.metadata['call_id'] = call_id  # 子 Agent 应使用此 call_id（与 call.agent.start 一致）
                        child_context.metadata['parent_call_id'] = master_call_id  # 父调用指向 Master
                        child_context.metadata['run_id'] = run_id
                        child_context.metadata['task_order'] = current_order
                        # 传播 cancel_event 到子上下文
                        cancel_event = context.metadata.get('cancel_event')
                        if cancel_event:
                            child_context.metadata['cancel_event'] = cancel_event

                        # 执行 Agent（不再流式yield，但仍需收集结果）
                        agent_start = time.time()

                        # 🎯 调用子Agent执行（子Agent会自己发布事件到事件总线）
                        agent_result = self.agent_executor.execute_agent(
                            agent_name=agent_name,
                            task=agent_task,
                            context=child_context,  # 使用子上下文
                            context_hint=context_hint
                        )

                        elapsed_time = time.time() - agent_start

                        # 使用收集到的最终结果
                        if agent_result is None:
                            agent_result = {
                                "success": False,
                                "error": "Agent 未返回结果"
                            }
                        
                        # 🎯 合并子上下文 (Context Merging)
                        # 将子 Agent 的关键结果合并回 Master 上下文
                        try:
                            response_obj = AgentResponse(
                                success=agent_result.get('success', False),
                                content=agent_result.get('data', {}).get('results', ''),
                                metadata=agent_result.get('data', {}).get('metadata', {}),
                                error=agent_result.get('error'),
                                agent_name=agent_name
                            )
                            context.merge(child_context, response_obj)
                            self.logger.info(f"{log_prefix} 子上下文已合并")
                        except Exception as e:
                            self.logger.warning(f"{log_prefix} 合并上下文失败: {e}")

                        result = agent_result

                        # ✨ 发布 AgentCall 结束事件
                        # result_summary = self._format_agent_result_summary(result)
                        self._publisher.agent_call_end(
                            call_id=call_id,
                            agent_name=agent_name,
                            result=result.get('data', {}).get('results', ''),
                            success=result.get('success', False),
                            parent_call_id=master_call_id,  # ✨ 关联到 MasterAgent 的调用
                            order=current_order
                        )

                        # 记录调用历史
                        agent_calls_history.append({
                            'agent_name': agent_name,
                            'task': agent_task,
                            'result': result
                        })

                        # 存储结果供后续引用
                        agent_results[idx] = result

                        # 格式化观察结果
                        observation = self.observation_formatter.format(
                            result,
                            tool_name=agent_name,
                            is_skills_tool=False
                        )
                        observations.append(f"**Agent {idx} ({agent_name})**:\n{observation}")

                    # 将所有结果作为 user 消息添加
                    combined_observations = "\n\n".join(observations)
                    current_session.append({
                        "role": "user",
                        "content": f"Agent 执行结果：\n\n{combined_observations}\n\n请基于以上结果继续分析并决定下一步行动。"
                    })

                    # 🔄 持久化中间 observation 消息
                    self._publisher.react_intermediate(
                        role="user", content=current_session[-1]["content"],
                        round=rounds, msg_type="observation"
                    )

                    continue
                else:
                    # 没有 Agent 调用但也没有最终答案
                    self.logger.warning(f"{log_prefix} 既没有调用 Agent 也没有给出最终答案")
                    current_session.append({
                        "role": "user",
                        "content": "请根据当前信息给出最终答案，或者说明需要调用哪个 Agent 获取更多信息。"
                    })

                    # 🔄 持久化兜底 observation 消息
                    self._publisher.react_intermediate(
                        role="user", content=current_session[-1]["content"],
                        round=rounds, msg_type="observation"
                    )

                    continue

            # 达到最大轮数（循环外无 log_prefix，用 display 名）
            self.logger.warning(f"{self._log_prefix(None, 'MasterV2')} 达到最大轮数 {self.max_rounds}")
            final_content = "抱歉，经过多轮分析后仍无法给出完整答案。建议重新描述问题或提供更多信息。"

            # ✨ 发布事件
            self._publisher.final_answer(final_content)

            # ✨ 发布 MasterAgent 自己的 CALL_AGENT_END 事件
            self._publisher.agent_call_end(
                call_id=master_call_id,
                agent_name=self.name,
                result=final_content,
                success=False  # 达到最大轮数视为失败
            )

            self._publisher.agent_end(final_content, execution_time=time.time() - start_time)
            self._publisher.session_end(summary=f"达到最大轮数 {self.max_rounds}")

            return AgentResponse(
                success=True,
                content=final_content,
                agent_name=self.name,
                execution_time=time.time() - start_time,
                metadata={
                    'rounds': rounds,
                    'max_rounds_reached': True,
                    'agent_calls': len(agent_calls_history)
                }
            )

        except InterruptedError as e:
            self.logger.info(f"任务被用户中断: {e}")

            # ✨ 发布 MasterAgent 自己的 CALL_AGENT_END 事件（中断）
            self._publisher.agent_call_end(
                call_id=master_call_id,
                agent_name=self.name,
                result="[已停止生成]",
                success=False
            )

            self._publisher.agent_error(error=str(e), error_type="InterruptedError")
            self._publisher.run_end(
                run_id=run_id,
                status="interrupted",
                summary=f"用户中断执行"
            )
            return AgentResponse(
                success=False,
                content="[已停止生成]",
                error="interrupted",
                agent_name=self.name,
                execution_time=time.time() - start_time
            )

        except Exception as e:
            self.logger.error(f"执行任务失败: {e}", exc_info=True)

            # ✨ 发布 MasterAgent 自己的 CALL_AGENT_END 事件（失败）
            self._publisher.agent_call_end(
                call_id=master_call_id,
                agent_name=self.name,
                result=str(e),
                success=False
            )

            # ✨ 发布错误事件
            self._publisher.agent_error(error=str(e), error_type="ExecutionError")
            # ✨ 发布运行结束事件，确保 SSE 流正确终止
            self._publisher.run_end(
                run_id=run_id,
                status="error",
                summary=f"执行失败: {e}"
            )
            return AgentResponse(
                success=False,
                error=str(e),
                agent_name=self.name,
                execution_time=time.time() - start_time
            )

    def stream_execute(self, task: str, context: AgentContext) -> AgentResponse:
        """
        流式执行任务（向后兼容方法）

        注意：不再使用 yield 返回事件，所有事件通过事件总线发布
        前端应使用 SSEAdapter 订阅事件总线
        """
        return self.execute(task, context)

    def execute_stream(self, task: str, context: AgentContext) -> AgentResponse:
        """
        流式执行任务（向后兼容方法）

        注意：不再使用 yield 返回事件，所有事件通过事件总线发布
        前端应使用 SSEAdapter 订阅事件总线
        """
        return self.execute(task, context)

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        Master V2 作为统一入口，处理所有任务
        """
        return True
