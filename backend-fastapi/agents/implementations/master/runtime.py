# -*- coding: utf-8 -*-
"""
MasterAgentV2 执行主循环。
"""

import time

from agents.core import AgentContext, AgentResponse, InterruptedError
from agents.events import EventPublisher, get_session_event_bus
from agents.streaming import StreamExecutor

from .executor import parse_agent_invocation

def execute_master(agent, task: str, context: AgentContext) -> AgentResponse:
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

    agent._publisher = EventPublisher(
        agent_name=agent.name,
        session_id=context.session_id,
        trace_id=context.metadata.get('trace_id'),
        span_id=context.metadata.get('span_id'),
        call_id=master_call_id,
        parent_call_id=parent_call_id,
        event_bus=event_bus
    )

    # 2. 发布运行开始事件 (Run)
    agent._publisher.run_start(run_id=run_id, metadata={"task": task})

    # 3. 发布 MasterAgent 自己的 CALL_AGENT_START 事件
    agent._publisher.agent_call_start(
        call_id=master_call_id,
        agent_name=agent.name,
        description=task
    )

    # 4. 发布 Agent 开始事件（保留原有的 agent_start）
    agent._publisher.agent_start(task, metadata={
        "agent_name": agent.name,
        "display_name": "MasterAgent V2",
        "max_rounds": agent.max_rounds,
        "run_id": run_id,
        "call_id": master_call_id
    })

    # 订阅子 Agent 的可视化事件，用于计数（子 Agent 生成的图表也需要编号）
    from agents.events.bus import EventType
    _child_viz_count = [0]  # 使用可变容器以便闭包内修改

    def _on_child_visualization(event):
        # 只统计子 Agent 发布的（非 MasterAgent 直接工具产生的）
        if event.agent_name != agent.name:
            _child_viz_count[0] += 1

    child_viz_sub_id = event_bus.subscribe(
        event_types=[EventType.CHART_GENERATED, EventType.MAP_GENERATED],
        handler=_on_child_visualization,
        filter_func=lambda e: e.session_id == context.session_id,
    )

    try:
        # 构建当次执行的消息列表（从 task 开始）
        current_session = [{"role": "user", "content": task}]

        rounds = 0
        visualization_counter = 0
        agent_calls_history = []
        global_agent_order = 0  # 🎯 全局 Agent 调用计数器

        while rounds < agent.max_rounds:
            rounds += 1
            # 检查中断
            agent._check_interrupt(context)

            # 获取 LLM 配置（含请求级 context.llm_override），用于调用与日志前缀
            llm_config = agent.get_llm_config(context)
            log_prefix = agent._log_prefix(llm_config, "MasterV2")

            agent.logger.info(f"{log_prefix} 第 {rounds} 轮推理")

            # 应用上下文管理
            managed_messages = agent.context_pipeline.prepare_messages(
                system_prompt=agent._build_system_prompt(),
                context=context,
                current_session=current_session,
                publisher=agent._publisher,
            )
            agent.logger.info(f"{log_prefix} {agent.context_pipeline.format_summary(managed_messages)}")

            # 发送上下文用量事件
            if agent._publisher:
                from agents.events.bus import EventType
                current_tokens = agent.context_pipeline._token_counter.count_messages(managed_messages)
                agent._publisher._publish(EventType.CONTEXT_USAGE, {
                    'used_tokens': current_tokens,
                    'max_tokens': agent.context_pipeline.config.max_tokens,
                    'round': rounds
                })

            # 调用 LLM（流式 XML 模式）
            stream_executor = StreamExecutor(
                model_adapter=agent.model_adapter,
                publisher=agent._publisher,
                agent_logger=agent.logger,
            )
            result = stream_executor.execute_llm_stream(
                messages=managed_messages,
                llm_config=llm_config,
                round_num=rounds,
                cancel_event=context.metadata.get('cancel_event'),
            )

            # 检查中断
            agent._check_interrupt(context)

            if result.error:
                if result.error == 'interrupted':
                    raise InterruptedError("LLM 调用被中断")
                # ✨ 使用事件发布器发布错误
                agent._publisher.agent_error(
                    error=f"LLM 调用失败: {result.error}",
                    error_type="LLMError"
                )
                # ✨ 发布完整的结束事件链，确保 SSE 流正确终止
                agent._publisher.agent_call_end(
                    call_id=master_call_id,
                    agent_name=agent.name,
                    result=f"LLM 调用失败: {result.error}",
                    success=False
                )
                agent._publisher.agent_end(
                    f"LLM 调用失败: {result.error}",
                    execution_time=time.time() - start_time
                )
                agent._publisher.run_end(
                    run_id=run_id,
                    status="error",
                    summary=f"LLM 调用失败: {result.error}"
                )
                return AgentResponse(
                    success=False,
                    error=f"LLM 调用失败: {result.error}",
                    agent_name=agent.name,
                    execution_time=time.time() - start_time
                )

            thought = result.thought
            actions = result.actions or []
            final_answer = result.answer
            full_response = result.full_response

            if thought:
                agent.logger.info(f"{log_prefix} Thinking: {thought[:100]}...")
            elif actions:
                agent.logger.info(f"{log_prefix} Actions: {len(actions)} tool(s): {[a.get('tool_name','?') for a in actions]}")
            elif final_answer:
                agent.logger.info(f"{log_prefix} Answer: {final_answer[:100]}...")

            # 添加 assistant 消息（使用完整 XML 响应用于持久化）
            current_session.append({
                "role": "assistant",
                "content": full_response
            })

            # 🔄 持久化中间 assistant 消息（final_answer 有独立路径）
            if not final_answer:
                agent._publisher.react_intermediate(
                    role="assistant", content=full_response,
                    round=rounds, msg_type="thought"
                )

            # 检查是否有最终答案
            if final_answer:
                agent.logger.info(f"{log_prefix} 得到最终答案")
                # 后端兜底：确保所有可视化占位符存在
                total_viz = visualization_counter + _child_viz_count[0]
                if total_viz > 0:
                    from agents.utils.visualization_postprocess import ensure_chart_placeholders
                    final_answer = ensure_chart_placeholders(final_answer, total_viz)

                # ✨ 发布最终答案事件（通过事件总线流式输出）
                agent._publisher.final_answer(final_answer)

                # ✨ 发布 MasterAgent 自己的 CALL_AGENT_END 事件
                agent._publisher.agent_call_end(
                    call_id=master_call_id,
                    agent_name=agent.name,
                    result=final_answer,
                    success=True
                )

                # ✨ 发布Agent结束和运行结束事件
                agent._publisher.agent_end(final_answer, execution_time=time.time() - start_time)
                agent._publisher.run_end(run_id=run_id, status="success", summary=f"任务完成，共 {rounds} 轮推理，{len(agent_calls_history)} 次Agent调用")

                return AgentResponse(
                    success=True,
                    content=final_answer,
                    agent_name=agent.name,
                    execution_time=time.time() - start_time,
                    metadata={
                        'rounds': rounds,
                        'agent_calls': len(agent_calls_history)
                    }
                )

            # 执行 Agent 调用
            if actions and len(actions) > 0:
                agent.logger.info(f"{log_prefix} 执行 {len(actions)} 个 Agent 调用")

                observations = []
                agent_results = {}

                for idx, action in enumerate(actions, 1):
                    # 每个 Agent 调用前检查中断
                    agent._check_interrupt(context)

                    tool_name = action.get('tool')
                    arguments = action.get('arguments', {})

                    if not tool_name:
                        continue

                    # 🎯 替换占位符（如 {result_1}, {result_2} 等）
                    # 这样可以实现链式调用，Agent B 可以引用 Agent A 的结果
                    original_arguments = arguments.copy()
                    arguments = agent._replace_placeholders(arguments, agent_results)

                    # 如果发生了替换，记录日志
                    if original_arguments != arguments:
                        agent.logger.info(f"{log_prefix} 占位符替换: {original_arguments} -> {arguments}")

                    # ─── 路由0：内置伪工具 request_user_input ─────────────
                    if tool_name == 'request_user_input':
                        tool_call_id = action.get('tool_call_id') or f"call_{run_id}_{rounds}_{idx}_input"
                        user_value = agent._handle_user_input_request(
                            arguments=arguments,
                            event_bus=event_bus,
                            session_id=context.session_id,
                            tool_call_id=tool_call_id,
                            publisher=agent._publisher,
                            parent_call_id=master_call_id,
                        )
                        if user_value is None:
                            # 被取消（cancel_event 已设置），下一次检查中断时会退出
                            agent._check_interrupt(context)
                            user_value = ""
                        observation = f"**工具 {idx}: request_user_input**\n用户输入: {user_value}"
                        observations.append(observation)
                        agent_results[idx] = {"success": True, "data": {"results": user_value}}
                        continue

                    # 解析出 Agent 名称
                    agent_name = parse_agent_invocation(tool_name)
                    if agent_name:
                        # ─── 路由1：委派子 Agent ──────────────────────────────
                        # 🎯 使用全局计数器确保每个 Agent 有唯一的 order
                        global_agent_order += 1
                        current_order = global_agent_order

                        # 提取参数
                        agent_task = arguments.get('task', '')
                        context_hint = arguments.get('context_hint')

                        agent.logger.info(f"{log_prefix} [{idx}/{len(actions)}] 调用 Agent: {agent_name} (全局顺序: {current_order}, 轮次: {rounds}-{idx})")
                        agent.logger.info(f"{log_prefix} 任务: {agent_task[:100]}...")

                        # 🎯 使用新版 call_id（原 task_id）
                        call_id = f"call_{run_id}_{rounds}_{idx}"
                        agent_display_name = agent._get_agent_display_name(agent_name)

                        # ✨ 发布 AgentCall 开始事件（parent_call_id 指向 MasterAgent 的 call_id）
                        agent._publisher.agent_call_start(
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
                        agent.logger.info(f"{log_prefix} 已派生子上下文 (Level {child_context.level})")

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
                        agent_result = agent.agent_executor.execute_agent(
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
                            agent.logger.info(f"{log_prefix} 子上下文已合并")
                        except Exception as e:
                            agent.logger.warning(f"{log_prefix} 合并上下文失败: {e}")

                        result = agent_result

                        # ✨ 发布 AgentCall 结束事件
                        agent._publisher.agent_call_end(
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
                        observation = agent.observation_formatter.format(
                            result,
                            tool_name=agent_name,
                            is_skills_tool=False
                        )
                        observations.append(f"**Agent {idx} ({agent_name})**:\n{observation}")

                    else:
                        # ─── 路由2/3：直接工具或 Skills 工具 ─────────────────
                        from agents.tools.builtin import SKILLS_TOOL_NAMES, BUILTIN_TOOL_NAMES
                        available_tool_names = {
                            t.get('function', {}).get('name') for t in agent.available_tools
                        } - BUILTIN_TOOL_NAMES  # 排除内置工具（已在路由0处理）
                        is_skills_tool = tool_name in SKILLS_TOOL_NAMES

                        if is_skills_tool or tool_name in available_tool_names:
                            # 路由2（Skills 工具）或路由3（普通直接工具）
                            agent.logger.info(
                                f"{log_prefix} [{idx}/{len(actions)}] 直接执行工具: {tool_name} "
                                f"({'Skills工具' if is_skills_tool else '直接工具'})"
                            )

                            # ✨ 发布工具调用开始事件（parent_call_id 指向 MasterAgent 自身）
                            tool_call_id = f"call_{run_id}_{rounds}_{idx}_tool"
                            agent._publisher.tool_call_start(
                                call_id=tool_call_id,
                                tool_name=tool_name,
                                arguments=arguments,
                                parent_call_id=master_call_id,
                            )

                            tool_start_time = time.time()
                            try:
                                from tools.tool_executor import execute_tool as _execute_tool
                                result = _execute_tool(
                                    tool_name,
                                    arguments,
                                    agent_config=agent.agent_config,
                                    event_bus=event_bus,
                                    session_id=context.session_id,
                                )
                            except Exception as tool_exc:
                                agent.logger.error(
                                    f"{log_prefix} 直接工具 {tool_name} 执行异常: {tool_exc}",
                                    exc_info=True
                                )
                                result = {
                                    "success": False,
                                    "error": str(tool_exc)
                                }

                            tool_elapsed = time.time() - tool_start_time

                            # ✨ 发布工具调用结束事件
                            tool_result_for_event = result.get('data', result) if isinstance(result, dict) else result
                            agent._publisher.tool_call_end(
                                call_id=tool_call_id,
                                tool_name=tool_name,
                                result=tool_result_for_event,
                                execution_time=tool_elapsed,
                                parent_call_id=master_call_id,
                            )

                            # ✨ 发布可视化事件（如果是图表/地图工具）
                            if tool_name == 'generate_chart' and result.get('success'):
                                results = result.get('data', {}).get('results', {})
                                chart_config = results.get('echarts_config')
                                chart_type = results.get('chart_type', 'bar')
                                if chart_config:
                                    visualization_counter += 1
                                    agent._publisher.chart_generated(
                                        chart_config=chart_config,
                                        chart_type=chart_type
                                    )
                            elif tool_name == 'generate_map' and result.get('success'):
                                results = result.get('data', {}).get('results', {})
                                map_type = results.get('map_type', 'marker')
                                if results:
                                    visualization_counter += 1
                                    agent._publisher.map_generated(
                                        map_data=results,
                                        map_type=map_type
                                    )

                            # 存储结果供后续占位符引用
                            agent_results[idx] = result

                            # 格式化观察结果
                            observation = agent.observation_formatter.format(
                                result,
                                tool_name=tool_name,
                                is_skills_tool=is_skills_tool
                            )
                            observations.append(f"**工具 {idx} ({tool_name})**:\n{observation}")

                        else:
                            # 未知工具名
                            error_msg = (
                                f"无效的工具名称: {tool_name}（既不是 Agent 工具也不是已配置的直接工具）"
                            )
                            agent.logger.warning(f"{log_prefix} {error_msg}")
                            observations.append(f"**工具 {idx}**: 失败\n错误: {error_msg}")

                # 将所有结果作为 user 消息添加
                combined_observations = "\n\n".join(observations)
                current_session.append({
                    "role": "user",
                    "content": f"Agent 执行结果：\n\n{combined_observations}"
                })

                # 🔄 持久化中间 observation 消息
                agent._publisher.react_intermediate(
                    role="user", content=current_session[-1]["content"],
                    round=rounds, msg_type="observation"
                )

                continue
            else:
                # 没有 Agent 调用但也没有最终答案
                agent.logger.warning(f"{log_prefix} 既没有调用 Agent 也没有给出最终答案")
                current_session.append({
                    "role": "user",
                    "content": "请直接输出 <answer> 或 <tools>。"
                })

                # 🔄 持久化兜底 observation 消息
                agent._publisher.react_intermediate(
                    role="user", content=current_session[-1]["content"],
                    round=rounds, msg_type="observation"
                )

                continue

        # 达到最大轮数（循环外无 log_prefix，用 display 名）
        agent.logger.warning(f"{agent._log_prefix(None, 'MasterV2')} 达到最大轮数 {agent.max_rounds}")
        final_content = "抱歉，经过多轮分析后仍无法给出完整答案。建议重新描述问题或提供更多信息。"

        # ✨ 发布事件
        agent._publisher.final_answer(final_content)

        # ✨ 发布 MasterAgent 自己的 CALL_AGENT_END 事件
        agent._publisher.agent_call_end(
            call_id=master_call_id,
            agent_name=agent.name,
            result=final_content,
            success=False  # 达到最大轮数视为失败
        )

        agent._publisher.agent_end(final_content, execution_time=time.time() - start_time)
        agent._publisher.session_end(summary=f"达到最大轮数 {agent.max_rounds}")

        return AgentResponse(
            success=True,
            content=final_content,
            agent_name=agent.name,
            execution_time=time.time() - start_time,
            metadata={
                'rounds': rounds,
                'max_rounds_reached': True,
                'agent_calls': len(agent_calls_history)
            }
        )

    except InterruptedError as e:
        agent.logger.info(f"任务被用户中断: {e}")

        # ✨ 发布 MasterAgent 自己的 CALL_AGENT_END 事件（中断）
        agent._publisher.agent_call_end(
            call_id=master_call_id,
            agent_name=agent.name,
            result="[已停止生成]",
            success=False
        )

        agent._publisher.agent_error(error=str(e), error_type="InterruptedError")
        agent._publisher.run_end(
            run_id=run_id,
            status="interrupted",
            summary=f"用户中断执行"
        )
        return AgentResponse(
            success=False,
            content="[已停止生成]",
            error="interrupted",
            agent_name=agent.name,
            execution_time=time.time() - start_time
        )

    except Exception as e:
        agent.logger.error(f"执行任务失败: {e}", exc_info=True)

        # ✨ 发布 MasterAgent 自己的 CALL_AGENT_END 事件（失败）
        agent._publisher.agent_call_end(
            call_id=master_call_id,
            agent_name=agent.name,
            result=str(e),
            success=False
        )

        # ✨ 发布错误事件
        agent._publisher.agent_error(error=str(e), error_type="ExecutionError")
        # ✨ 发布运行结束事件，确保 SSE 流正确终止
        agent._publisher.run_end(
            run_id=run_id,
            status="error",
            summary=f"执行失败: {e}"
        )
        return AgentResponse(
            success=False,
            error=str(e),
            agent_name=agent.name,
            execution_time=time.time() - start_time
        )

    finally:
        # 清理子 Agent 可视化事件订阅
        try:
            event_bus.unsubscribe(child_viz_sub_id)
        except Exception:
            pass
