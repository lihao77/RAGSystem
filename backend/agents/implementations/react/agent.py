# -*- coding: utf-8 -*-
"""
ReAct Agent - 使用 XML 标签格式 + 流式输出

优势：
1. 不依赖 function calling API
2. 支持任何大模型
3. 推理过程实时流式可见（thinking_delta）
4. 最终答案逐字流式输出
"""

import logging
import json
import os
import time
from typing import Optional, Dict, Any, List
import uuid
from agents.core import BaseAgent, AgentContext, AgentResponse, InterruptedError
from agents.streaming import StreamExecutor
from tools.tool_executor import execute_tool
from agents.context import ContextConfig, ObservationFormatter, ContextPipeline
from agents.events import get_session_event_bus, EventPublisher

logger = logging.getLogger(__name__)


class ReActAgent(BaseAgent):
    """
    ReAct (Reasoning + Acting) 智能体

    使用 XML 标签格式 + 流式输出，支持实时展示思考和回答过程
    """

    def __init__(
        self,
        agent_name: str,
        display_name: str = None,
        description: str = None,
        model_adapter = None,
        agent_config = None,
        system_config = None,
        available_tools: Optional[List[Dict[str, Any]]] = None,
        available_skills: Optional[List] = None,  # 新增：Skills 列表
        event_callback = None,  # 新增：事件回调函数（向后兼容）
        event_bus = None  # 新增：会话级事件总线
    ):
        super().__init__(
            name=agent_name,
            description=description or display_name or agent_name,
            capabilities=['reasoning', 'tool_calling'],
            model_adapter=model_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.display_name = display_name or agent_name
        self.available_tools = available_tools or []
        self.available_skills = available_skills or []  # 新增：保存 Skills
        self.event_callback = event_callback  # 保存回调函数（向后兼容）
        self.event_bus = event_bus  # 保存事件总线实例
        self._publisher = None  # EventPublisher 实例（延迟创建）

        # 从配置获取行为参数
        behavior_config = agent_config.custom_params.get('behavior', {}) if agent_config else {}
        self.max_rounds = behavior_config.get('max_rounds', 10)
        self.base_prompt = behavior_config.get('system_prompt', '')

        # 获取模型配置
        llm_config = self.get_llm_config()

        # 计算上下文预算
        from agents.context.budget import compute_context_budget, DEFAULT_MAX_COMPLETION_TOKENS, REACT_FALLBACK_MULTIPLIER
        # 兼容新旧字段名：优先使用 max_completion_tokens，回退到 max_tokens
        model_max_completion_tokens = llm_config.get('max_completion_tokens') or llm_config.get('max_tokens', DEFAULT_MAX_COMPLETION_TOKENS)
        model_context_window = llm_config.get('max_context_tokens')

        max_context_tokens = compute_context_budget(
            model_context_window=model_context_window,
            max_completion_tokens=model_max_completion_tokens,
            explicit_budget=behavior_config.get('max_context_tokens'),
            fallback_multiplier=REACT_FALLBACK_MULTIPLIER,
        )

        # 初始化上下文管理器
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

        logger.info(
            f"ReActAgent '{self.name}' 初始化完成，"
            f"可用工具: {len(self.available_tools)}，"
            f"可用 Skills: {len(self.available_skills)}，"
            f"模型输出限制: {model_max_completion_tokens} tokens, "
            f"上下文窗口: {model_context_window or '未配置'}, "
            f"上下文预算: {max_context_tokens} tokens"
        )

    def _emit_event(self, event_type: str, data: Dict[str, Any]):
        """
        发送事件到回调函数和事件总线

        支持两种方式（向后兼容）：
        1. 旧方式：通过 event_callback 回调函数
        2. 新方式：通过 EventPublisher 发布到事件总线
        """
        # 旧方式：回调函数（向后兼容）
        if self.event_callback:
            try:
                self.event_callback(event_type, data)
            except Exception as e:
                self.logger.warning(f"事件回调失败: {e}")

        # 新方式：事件总线
        if self._publisher:
            try:
                # ✨ 获取当前 ReActAgent 的 call_id（作为工具调用的 parent_call_id）
                agent_call_id = getattr(self, '_current_call_id', None)
                # 兼容旧 task_id
                if not agent_call_id:
                    agent_call_id = getattr(self, '_current_task_id', None)

                # 映射事件类型到 EventPublisher 方法
                if event_type == 'thinking_structured':
                    self._publisher.thinking_structured(
                        thinking=data.get('thinking', ''),
                        actions=data.get('actions', []),
                        reasoning=f"第 {data.get('round', 0)} 轮推理",
                        round=data.get('round'),
                    )
                elif event_type == 'tool_start':
                    # 生成唯一的 tool call_id
                    import uuid
                    tool_call_id = data.get('tool_call_id') or f"tool_{uuid.uuid4()}"

                    self._publisher.tool_call_start(
                        call_id=tool_call_id,
                        tool_name=data.get('tool_name'),
                        arguments=data.get('arguments', {}),
                        parent_call_id=agent_call_id  # ✨ 关联到 ReActAgent 的调用
                    )
                elif event_type == 'tool_end':
                    self._publisher.tool_call_end(
                        call_id=data.get('tool_call_id'),
                        tool_name=data.get('tool_name'),
                        result=data.get('result'),
                        execution_time=data.get('elapsed_time'),
                        parent_call_id=agent_call_id  # ✨ 关联到 ReActAgent 的调用
                    )
                elif event_type == 'tool_error':
                    self._publisher.tool_error(
                        tool_name=data.get('tool_name'),
                        error=data.get('error')
                    )
            except Exception as e:
                self.logger.warning(f"事件总线发布失败: {e}")

    def _build_system_prompt(self) -> str:
        """构建系统提示词"""
        # 构建详细的工具说明（包含参数定义）
        tools_desc_lines = []
        for tool in self.available_tools:
            func = tool['function']
            name = func['name']
            desc = func['description']
            params = func.get('parameters', {})

            # 基本描述
            tools_desc_lines.append(f"\n### {name}")
            tools_desc_lines.append(f"**描述**: {desc}")

            # 参数说明
            if params and 'properties' in params:
                tools_desc_lines.append("**参数**:")
                required = params.get('required', [])
                for param_name, param_info in params['properties'].items():
                    param_type = param_info.get('type', 'any')
                    param_desc = param_info.get('description', '')
                    required_mark = " (必填)" if param_name in required else " (可选)"
                    tools_desc_lines.append(f"  - `{param_name}` ({param_type}){required_mark}: {param_desc}")

            # 示例（如果有）
            if 'examples' in func:
                tools_desc_lines.append("**示例**:")
                for example in func['examples']:
                    tools_desc_lines.append(f"  ```json\n  {json.dumps(example, ensure_ascii=False)}\n  ```")

        tools_desc = "\n".join(tools_desc_lines)

        # 构建 execute_code 可调用工具说明
        # 当 execute_code 在可用工具中时，告知 LLM 哪些工具可在 call_tool() 中调用
        code_callable_hint = ""
        has_execute_code = any(
            t['function']['name'] == 'execute_code' for t in self.available_tools
        )
        if has_execute_code:
            code_callable_tools = [
                t['function']['name']
                for t in self.available_tools
                if t['function']['name'] != 'execute_code'
                and 'code_execution' in t['function'].get('allowed_callers', ['direct'])
            ]
            if code_callable_tools:
                tools_list = ", ".join(f"`{t}`" for t in code_callable_tools)
                code_callable_hint = f"""

## execute_code 中可调用的工具

在 `execute_code` 的代码中使用 `call_tool(tool_name, arguments)` 时，**只能调用以下工具**：
{tools_list}

其他工具（如高风险写操作工具）不允许从代码中调用，只能直接作为 action 使用。"""

        # 构建 Skills 说明
        skills_desc = self._format_skills_description()

        # 🔒 动态生成示例：使用当前智能体可用的工具
        example_tool_name = self.available_tools[0]['function']['name'] if self.available_tools else "tool_name"
        example_params = self.available_tools[0]['function'].get('parameters', {}).get('properties', {})

        # 构造示例参数
        if example_params:
            first_param = list(example_params.keys())[0]
            example_arg_json = json.dumps({first_param: "示例值"}, ensure_ascii=False)
        else:
            example_arg_json = "{}"

        return f"""{self.base_prompt}

## 可用工具

{tools_desc}
{code_callable_hint}

## 领域知识 (Skills)

{skills_desc}

## 输出格式

**直接输出工具调用或答案，禁止在 <thinking> 中写分析过程。**

调用工具：
<tools>
<tool name="工具名">{{"参数": "值"}}</tool>
</tools>

给出最终答案：
<answer>
答案内容
</answer>

如需备注意图（可选，最多10字）：
<thinking>激活技能</thinking>
<tools>...</tools>

**规则：**
1. 只能使用"可用工具"中列出的工具
2. 禁止在 <thinking> 写推理、分析、解释——只允许写不超过10字的动作标注，或直接省略
3. 互相独立的工具调用放同一 <tools> 中并行
4. 链式调用：{{result_N}} 引用同轮第N个工具结果
5. 数据充足时直接输出 <answer>
6. 报错时下一轮换策略

**数据处理：**
- 批量查多实体 → `execute_code`（call_tool 循环）
- 工具返回文件路径 → 直接传给 `process_data_file` 或 `generate_chart`
- 内存中小数据格式变换 → `transform_data`

### 图表引用规则
使用了 generate_chart / generate_map 后，**必须**在 <answer> 相关段落插入 [CHART:N]（N 从 1 起，独占一行，前后空行）。未生成图表则不插入。
"""

    def _format_skills_description(self) -> str:
        """
        格式化 Skills 说明（仅列出 name 和 description）

        根据 Claude Skills 的渐进式披露原则：
        1. System Prompt 只包含 name + description（最小化信息）
        2. AI 判断需要时，调用 activate_skill 工具激活 Skill 并加载主文件
        3. AI 根据主文件提示，调用 load_skill_resource 加载引用文件
        4. AI 根据主文件指示，调用 execute_skill_script 执行脚本

        Skills 不是工具，而是领域知识指南，告诉 Agent 如何更好地完成特定任务。
        """
        if not self.available_skills:
            return "当前无可用的领域知识。"

        lines = []
        lines.append("## 领域知识 Skills")
        lines.append("")
        lines.append("以下是可用的领域知识 Skills。使用流程：")
        lines.append("")
        lines.append("**第 1 步**：当任务匹配某个 Skill 的场景时，调用 `activate_skill(skill_name)` 激活它")
        lines.append("  - 效果：加载 SKILL.md 主文件，获取完整指导流程")
        lines.append("  - 返回：主文件内容 + 可用的资源和脚本列表")
        lines.append("")
        lines.append("**第 2 步**：根据主文件中的提示，使用 `load_skill_resource` 加载详细文档")
        lines.append("")
        lines.append("**第 3 步**：根据主文件中的指示，使用 `execute_skill_script` 执行脚本")
        lines.append("")
        lines.append("---")
        lines.append("")

        for idx, skill in enumerate(self.available_skills, 1):
            lines.append(f"### Skill {idx}: {skill.name}")
            lines.append(f"**适用场景**: {skill.description}")
            lines.append("")

        return "\n".join(lines)

    def execute_stream(self, task: str, context: AgentContext) -> AgentResponse:
        """
        执行任务（向后兼容方法）

        注意：不再使用 yield 返回事件，所有事件通过事件总线发布
        前端应使用 SSEAdapter 订阅事件总线
        """
        return self.execute(task, context)

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """执行任务（非流式版本，兼容旧接口）"""
        start_time = time.time()

        try:
            # ✨ 初始化事件总线和 EventPublisher
            event_bus = self.event_bus
            if not event_bus and hasattr(context, 'session_id') and context.session_id:
                event_bus = get_session_event_bus(context.session_id)

            current_session_id = getattr(context, 'session_id', None)

            # ✨ 从 context 读取 call_id 和 parent_call_id（如果是被 MasterAgent V2 调用）
            import uuid
            parent_call_id = None
            current_call_id = None
            if hasattr(context, 'metadata'):
                current_call_id = context.metadata.get('call_id')  # MasterAgent 传来的 call_id（与 call.agent.start 一致）
                parent_call_id = context.metadata.get('parent_call_id') or context.metadata.get('parent_task_id')

            if not current_call_id:
                current_call_id = f"call_{uuid.uuid4()}"

            if (
                self._publisher is None
                or self._publisher.session_id != current_session_id
                or self._publisher.event_bus is not event_bus
            ):
                if event_bus:
                    self._publisher = EventPublisher(
                        agent_name=self.name,
                        session_id=current_session_id,
                        trace_id=context.metadata.get('trace_id') if hasattr(context, 'metadata') else None,
                        span_id=context.metadata.get('span_id') if hasattr(context, 'metadata') else None,
                        call_id=current_call_id,
                        parent_call_id=parent_call_id,
                        event_bus=event_bus
                    )
            elif self._publisher:
                # publisher 被复用时，必须更新 call_id 和 parent_call_id（每次调用不同）
                self._publisher.call_id = current_call_id
                self._publisher.parent_call_id = parent_call_id

            # ✨ 发布 agent_start 事件
            if self._publisher:
                self._publisher.agent_start(task, metadata={'max_rounds': self.max_rounds})

            # 保存 call_id 供后续使用
            self._current_call_id = current_call_id
            self._parent_call_id = parent_call_id

            # 兼容旧代码
            self._current_task_id = self._current_call_id

            # 构建当次执行的消息列表（从 task 开始）
            current_session = [{"role": "user", "content": task}]

            rounds = 0
            visualization_counter = 0
            tool_calls_history = []

            while rounds < self.max_rounds:
                rounds += 1
                # 检查中断
                self._check_interrupt(context)

                # 获取 LLM 配置（含请求级 context.llm_override），用于调用与日志前缀
                llm_config = self.get_llm_config(context)
                log_prefix = self._log_prefix(llm_config, "ReAct")

                self.logger.info(f"{log_prefix} 第 {rounds} 轮推理")

                #  应用上下文管理（压缩 + 预算控制）
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

                # 调用 LLM（流式 XML 模式）
                stream_executor = StreamExecutor(
                    model_adapter=self.model_adapter,
                    publisher=self._publisher,
                    agent_logger=self.logger,
                )
                result = stream_executor.execute_llm_stream(
                    messages=managed_messages,
                    llm_config=llm_config,
                    round_num=rounds,
                    cancel_event=context.metadata.get('cancel_event'),
                )

                # 检查中断
                self._check_interrupt(context)

                # 检查错误
                if result.error:
                    if result.error == 'interrupted':
                        raise InterruptedError("LLM 调用被中断")
                    error_msg = f"LLM 调用失败: {result.error}"
                    if self._publisher:
                        self._publisher.agent_error(error=error_msg, error_type="LLMError")
                    return AgentResponse(
                        success=False,
                        content="",
                        error=error_msg,
                        agent_name=self.name,
                        execution_time=time.time() - start_time
                    )

                thought = result.thought
                actions = result.actions or []
                final_answer = result.answer
                full_response = result.full_response

                if thought:
                    self.logger.info(f"{log_prefix} Thinking: {thought[:100]}...")
                elif actions:
                    self.logger.info(f"{log_prefix} Actions: {len(actions)} tool(s): {[a.get('tool_name','?') for a in actions]}")
                elif final_answer:
                    self.logger.info(f"{log_prefix} Answer: {final_answer[:100]}...")

                # 添加 assistant 消息（使用完整的 XML 响应文本用于持久化）
                current_session.append({
                    "role": "assistant",
                    "content": full_response
                })

                # 检查是否有最终答案
                if final_answer:
                    self.logger.info(f"{log_prefix} 得到最终答案")
                    # 后端兜底：确保所有可视化占位符存在
                    if visualization_counter > 0:
                        from agents.utils.visualization_postprocess import ensure_chart_placeholders
                        final_answer = ensure_chart_placeholders(final_answer, visualization_counter)
                    # ✨ 发布事件
                    if self._publisher:
                        self._publisher.final_answer(final_answer)
                        self._publisher.agent_end(
                            result=final_answer,
                            execution_time=time.time() - start_time
                        )
                    return AgentResponse(
                        success=True,
                        content=final_answer,
                        agent_name=self.name,
                        execution_time=time.time() - start_time,
                        tool_calls=tool_calls_history,
                        metadata={
                            'rounds': rounds,
                            'reasoning_steps': [msg for msg in current_session if msg['role'] == 'assistant']
                        }
                    )

                # 检查是否需要执行工具（支持多个工具并行）
                if actions and len(actions) > 0:
                    self.logger.info(f"{log_prefix} 执行 {len(actions)} 个工具调用")

                    # 收集所有工具的执行结果
                    observations = []

                    for idx, action in enumerate(actions, 1):
                        # 每个工具执行前检查中断
                        self._check_interrupt(context)

                        tool_name = action.get('tool')
                        arguments = action.get('arguments', {})

                        if not tool_name:
                            continue

                        self.logger.info(f"{log_prefix} [{idx}/{len(actions)}] 执行工具: {tool_name}, 参数: {arguments}")

                        # 生成 tool_call_id
                        import uuid
                        tool_call_id = f"tool_{uuid.uuid4()}"

                        # 发送工具开始事件
                        self._emit_event('tool_start', {
                            'tool_call_id': tool_call_id,  # 传入 ID
                            'tool_name': tool_name,
                            'arguments': arguments,
                            'index': idx,
                            'total': len(actions)
                        })

                        # 执行工具（传递 agent_config 以确保 agent 级别的工具权限检查）
                        start_time = time.time()
                        result = execute_tool(
                            tool_name, arguments,
                            agent_config=self.agent_config,
                            event_bus=event_bus,
                        )
                        elapsed_time = time.time() - start_time

                        # 发送工具结束事件
                        self._emit_event('tool_end', {
                            'tool_call_id': tool_call_id,  # 传入 ID
                            'tool_name': tool_name,
                            'result': result,
                            'elapsed_time': elapsed_time,
                            'index': idx,
                            'total': len(actions)
                        })

                        # ✨ 发布可视化事件（如果是图表/地图工具）
                        if self._publisher:
                            if tool_name == 'generate_chart' and result.get('success'):
                                results = result.get('data', {}).get('results', {})
                                chart_config = results.get('echarts_config')
                                chart_type = results.get('chart_type', 'bar')
                                if chart_config:
                                    visualization_counter += 1
                                    self._publisher.chart_generated(
                                        chart_config=chart_config,
                                        chart_type=chart_type
                                    )
                            elif tool_name == 'generate_map' and result.get('success'):
                                results = result.get('data', {}).get('results', {})
                                map_type = results.get('map_type', 'marker')
                                if results:
                                    visualization_counter += 1
                                    self._publisher.map_generated(
                                        map_data=results,
                                        map_type=map_type
                                    )

                        # 记录工具调用
                        tool_calls_history.append({
                            'tool_name': tool_name,
                            'arguments': arguments,
                            'result': result
                        })

                        # 格式化观察结果（使用新的格式化器）
                        is_skills_tool = tool_name in ['activate_skill', 'load_skill_resource', 'execute_skill_script']
                        observation = self.observation_formatter.format(
                            result,
                            tool_name=tool_name,
                            is_skills_tool=is_skills_tool
                        )
                        observations.append(f"**工具 {idx}: {tool_name}**\n{observation}")

                    # 将所有结果作为 user 消息添加
                    combined_observations = "\n\n".join(observations)
                    current_session.append({
                        "role": "user",
                        "content": f"工具执行结果：\n\n{combined_observations}"
                    })

                    continue
                else:
                    # 没有工具调用但也没有最终答案，可能是 LLM 困惑了
                    self.logger.warning(f"{log_prefix} LLM 既没有调用工具也没有给出最终答案")
                    current_session.append({
                        "role": "user",
                        "content": "请直接输出 <answer> 或 <tools>。"
                    })
                    continue

            # 达到最大轮数
            self.logger.warning(f"{self._log_prefix(None, 'ReAct')} 达到最大轮数 {self.max_rounds}")
            final_content = "抱歉，经过多轮分析后仍无法给出完整答案。建议重新描述问题或提供更多信息。"
            # ✨ 发布事件
            if self._publisher:
                self._publisher.final_answer(final_content)
                self._publisher.agent_end(
                    result=final_content,
                    execution_time=time.time() - start_time
                )
            return AgentResponse(
                success=True,
                content=final_content,
                agent_name=self.name,
                execution_time=time.time() - start_time,
                tool_calls=tool_calls_history,
                metadata={'rounds': rounds, 'max_rounds_reached': True}
            )

        except InterruptedError as e:
            self.logger.info(f"任务被用户中断: {e}")
            if self._publisher:
                self._publisher.agent_error(error=str(e), error_type="InterruptedError")
                self._publisher.agent_end(
                    result="[已停止生成]",
                    execution_time=time.time() - start_time
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
            # ✨ 发布错误事件
            if self._publisher:
                self._publisher.agent_error(error=str(e), error_type="ExecutionError")
            return AgentResponse(
                success=False,
                content="",
                error=str(e),
                agent_name=self.name,
                execution_time=time.time() - start_time
            )

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        ReAct Agent 始终返回 True，让 MasterAgent V2 通过 LLM 智能分析来决定路由
        """
        return True

    def _safe_json_dumps(self, obj):
        """
        安全地序列化对象为 JSON 字符串，处理 NaN/Infinity 等特殊值

        Args:
            obj: 要序列化的对象

        Returns:
            JSON 字符串
        """
        import json
        import math

        def clean_value(value):
            """递归清理 NaN 和 Infinity"""
            if isinstance(value, float):
                if math.isnan(value) or math.isinf(value):
                    return None  # 将 NaN/Inf 转换为 null
                return value
            elif isinstance(value, dict):
                return {k: clean_value(v) for k, v in value.items()}
            elif isinstance(value, list):
                return [clean_value(item) for item in value]
            else:
                return value

        cleaned_obj = clean_value(obj)
        return json.dumps(cleaned_obj, ensure_ascii=False)

    def _resolve_tool_references(self, arguments: dict, tool_results: dict, current_idx: int) -> dict:
        """
        解析工具参数中的引用占位符，替换为前面工具的实际结果

        支持的占位符格式：
        - {result_N}  - 引用第N个工具的完整结果
        - {result_N.data.results} - 引用第N个工具结果中的特定字段（JSON路径）
        - {result_1} 到 {result_N-1}  - 只能引用当前工具之前的结果

        Args:
            arguments: 工具的原始参数字典
            tool_results: 已执行工具的结果字典 {idx: result}
            current_idx: 当前工具的索引（从1开始）

        Returns:
            替换后的参数字典
        """
        import re
        import json

        def replace_placeholder(match):
            """替换单个占位符"""
            full_match = match.group(0)  # 完整的 {{...}}
            ref_expr = match.group(1)     # {{}} 内的内容

            # 解析引用：result_N 或 result_N.path.to.field
            parts = ref_expr.split('.', 1)
            base_ref = parts[0]  # result_N
            json_path = parts[1] if len(parts) > 1 else None  # path.to.field

            # 提取索引 N
            if not base_ref.startswith('result_'):
                self.logger.warning(f"[链式调用] 无效的占位符格式: {full_match}")
                return full_match  # 保持原样

            try:
                ref_idx = int(base_ref.replace('result_', ''))
            except ValueError:
                self.logger.warning(f"[链式调用] 无法解析索引: {full_match}")
                return full_match

            # 检查是否引用了后面的工具（不允许）
            if ref_idx >= current_idx:
                self.logger.warning(
                    f"[链式调用] 工具 {current_idx} 不能引用后面的工具 {ref_idx}"
                )
                return full_match

            # 检查引用的工具是否已执行
            if ref_idx not in tool_results:
                self.logger.warning(
                    f"[链式调用] 工具 {current_idx} 引用的工具 {ref_idx} 尚未执行"
                )
                return full_match

            # 获取引用的结果
            result = tool_results[ref_idx]

            # 如果有 JSON 路径，提取特定字段
            if json_path:
                try:
                    value = result
                    for key in json_path.split('.'):
                        if isinstance(value, dict):
                            value = value.get(key)
                        else:
                            self.logger.warning(
                                f"[链式调用] 无法访问路径 {json_path}，当前值不是字典"
                            )
                            return full_match

                    # 如果提取的值是字符串，直接返回；否则序列化为 JSON
                    if isinstance(value, str):
                        return value
                    else:
                        return self._safe_json_dumps(value)
                except Exception as e:
                    self.logger.warning(
                        f"[链式调用] 提取 JSON 路径失败: {json_path}, 错误: {e}"
                    )
                    return full_match
            else:
                # 没有 JSON 路径，返回完整结果
                # 如果结果是标准化响应，提取 data.results
                if isinstance(result, dict) and result.get('success'):
                    data = result.get('data', {})
                    results = data.get('results')

                    # 如果 results 是字符串（JSON字符串），直接返回
                    if isinstance(results, str):
                        return results
                    # 如果 results 是字典或列表，序列化为 JSON
                    elif results is not None:
                        return self._safe_json_dumps(results)

                # 兜底：返回整个 result 的 JSON 序列化
                return self._safe_json_dumps(result)

        # 递归处理参数字典中的所有字符串值
        def process_value(value):
            if isinstance(value, str):
                # 查找所有占位符 {result_N} 或 {result_N.path} 并替换
                # 使用单层花括号，更简洁直观
                pattern = r'\{(result_\d+(?:\.[a-zA-Z0-9_\.]+)?)\}'
                return re.sub(pattern, replace_placeholder, value)
            elif isinstance(value, dict):
                return {k: process_value(v) for k, v in value.items()}
            elif isinstance(value, list):
                return [process_value(item) for item in value]
            else:
                return value

        resolved = process_value(arguments)

        # 如果有替换发生，记录日志
        if resolved != arguments:
            self.logger.info(
                f"[链式调用] 工具 {current_idx} 的参数中发现占位符，已替换"
            )

        return resolved
