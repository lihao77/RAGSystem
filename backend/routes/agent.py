# -*- coding: utf-8 -*-
"""
Agent API 路由 - 智能体系统统一入口

提供智能体系统的 API 接口
"""

from flask import Blueprint, request, Response, stream_with_context
import logging
import json
import asyncio
import uuid as uuid_module
from agents import (
    AgentContext,
    get_orchestrator,
    get_config_manager,
    load_agents_from_config
)
from agents.context.manager import ContextManager
from agents.core.models import Message
from agents.events import EventType, get_session_event_bus, SSEAdapter
from conversation_store import ConversationStore
from model_adapter import get_default_adapter
from config import get_config
from utils.response_helpers import success_response, error_response

logger = logging.getLogger(__name__)

agent_bp = Blueprint('agent', __name__)


# 全局 Orchestrator（延迟初始化）
_orchestrator = None
_conversation_store = None


def _get_conversation_store() -> ConversationStore:
    global _conversation_store
    if _conversation_store is None:
        _conversation_store = ConversationStore()
    return _conversation_store


def _load_history_into_context(context: AgentContext, session_id: str, limit: int = 50):
    """
    加载完整原始上下文（含 seq）到 context。

    压缩判断与持久化由 Agent 内部统一处理，Route 只负责：
    1. 加载原始消息
    2. 订阅 COMPRESSION_SUMMARY 事件并写 DB
    """
    store = _get_conversation_store()
    raw = store.get_recent_messages(session_id=session_id, limit=limit)

    for item in raw:
        if item.get("role") in ["user", "assistant", "system"]:
            meta = dict(item.get("metadata") or {})
            if item.get("seq") is not None:
                meta["seq"] = item["seq"]
            context.add_message(role=item["role"], content=item["content"], metadata=meta)


def _get_orchestrator():
    """获取或初始化全局 Orchestrator（使用动态加载）"""
    global _orchestrator

    if _orchestrator is None:
        try:
            system_config = get_config()
            adapter = get_default_adapter()

            # 创建 Orchestrator
            _orchestrator = get_orchestrator(model_adapter=adapter)

            # 🎉 使用动态加载机制加载所有智能体
            agents = load_agents_from_config(
                model_adapter=adapter,
                system_config=system_config,
                orchestrator=_orchestrator
            )

            # 注册所有加载的智能体
            for agent_name, agent in agents.items():
                _orchestrator.register_agent(agent)
                logger.info(f"已注册智能体: {agent_name}")

            # 初始化性能指标收集器
            try:
                from agents.monitoring import MetricsCollector
                from agents.events import get_session_manager

                metrics_collector = MetricsCollector()

                # 获取全局会话事件总线管理器
                session_manager = get_session_manager()

                # 将 metrics_collector 附加到 orchestrator 以便后续访问
                _orchestrator._metrics_collector = metrics_collector
                _orchestrator._session_manager = session_manager

                logger.info("✓ 性能指标收集器已初始化")
            except Exception as e:
                logger.warning(f"性能指标收集器初始化失败（不影响核心功能）: {e}")

            # 验证注册结果
            registered_agents = _orchestrator.list_agents()
            logger.info(f"Orchestrator 初始化成功，已加载 {len(agents)} 个智能体，已注册 {len(registered_agents)} 个智能体")
            logger.info(f"已加载的智能体列表: {list(agents.keys())}")
            logger.info(f"已注册的智能体列表: {[a['name'] for a in registered_agents]}")
        except Exception as e:
            logger.error(f"Orchestrator 初始化失败: {e}", exc_info=True)
            raise

    return _orchestrator


def reload_agents():
    """
    重新加载 orchestrator 中的智能体（用于配置更新后刷新）

    这个函数会：
    1. 清除旧的智能体注册
    2. 重新加载所有启用的智能体
    3. 注册到 orchestrator

    Returns:
        bool: 是否重新加载成功
    """
    global _orchestrator

    if _orchestrator is None:
        logger.warning("orchestrator 未初始化，跳过重新加载")
        return False

    try:
        # 清空现有智能体（保留注册表对象）
        _orchestrator.registry.clear()
        logger.info("已清空 orchestrator 中的智能体注册")

        # 重新加载智能体
        system_config = get_config()
        adapter = get_default_adapter()

        agents = load_agents_from_config(
            model_adapter=adapter,
            system_config=system_config,
            orchestrator=_orchestrator
        )

        # 重新注册
        for agent_name, agent in agents.items():
            _orchestrator.register_agent(agent)
            logger.info(f"已重新注册智能体: {agent_name}")

        logger.info(f"智能体重新加载完成，共加载 {len(agents)} 个智能体")
        return True

    except Exception as e:
        logger.error(f"重新加载智能体失败: {e}", exc_info=True)
        return False


@agent_bp.route('/agents', methods=['GET'])
def list_agents():
    """
    列出所有可用智能体

    Returns:
        {
            "success": true,
            "data": [
                {
                    "name": "qa_agent",
                    "description": "知识图谱问答智能体",
                    "capabilities": [...],
                    "tools": [...]
                }
            ]
        }
    """
    try:
        orchestrator = _get_orchestrator()
        agents = orchestrator.list_agents()

        return success_response(
            data=agents,
            message=f'共有 {len(agents)} 个智能体'
        )

    except Exception as e:
        logger.error(f'获取智能体列表失败: {e}')
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/agents/create', methods=['POST'])
def create_agent():
    """
    创建新智能体

    Request:
        {
            "agent_name": "new_agent",
            "display_name": "新智能体",
            "description": "描述",
            "custom_params": {
                "type": "react",
                "behavior": {
                    system_prompt: "你是一XXX的智能体..."
                    max_rounds: 10
                    auto_execute_tools: true
                }
            },
            "llm": {
                "temperature": 0.7
            }
        }
    """
    try:
        data = request.get_json()
        agent_name = data.get('agent_name')

        if not agent_name:
            return error_response(message='智能体名称不能为空', status_code=400)

        config_manager = get_config_manager()

        # 检查是否已存在
        if config_manager.get_config(agent_name):
            return error_response(message=f'智能体 {agent_name} 已存在', status_code=400)

        from agents.config import AgentConfig

        # 创建配置对象
        try:
            config = AgentConfig(**data)
        except Exception as e:
            return error_response(message=f'配置验证失败: {e}', status_code=400)

        # 保存配置
        config_manager.set_config(config, save=True)

        # 重新加载 orchestrator 中的智能体
        orchestrator = _get_orchestrator()

        # 动态加载新智能体
        try:
            from agents.config import AgentLoader
            from config import get_config as get_system_config

            loader = AgentLoader(
                model_adapter=get_default_adapter(),
                system_config=get_system_config(),
                orchestrator=orchestrator
            )

            new_agent = loader.load_agent(agent_name)
            if new_agent:
                orchestrator.register_agent(new_agent)
                logger.info(f"新智能体 {agent_name} 已创建并加载")
            else:
                logger.warning(f"智能体 {agent_name} 配置已保存但在加载时失败")

        except Exception as e:
            logger.error(f"热加载新智能体失败: {e}")
            # 不影响配置保存成功的结果

        return success_response(
            data=config.model_dump(),
            message=f'智能体 {agent_name} 创建成功'
        )

    except Exception as e:
        logger.error(f'创建智能体失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/agents/delete/<agent_name>', methods=['DELETE'])
def delete_agent(agent_name):
    """
    删除智能体
    """
    try:
        if not agent_name:
            return error_response(message='智能体名称不能为空', status_code=400)

        # 禁止删除系统智能体
        if agent_name == 'master_agent_v2':
            return error_response(message='系统核心智能体禁止删除', status_code=403)

        config_manager = get_config_manager()

        # 检查是否存在
        if not config_manager.get_config(agent_name):
            return error_response(message=f'智能体 {agent_name} 不存在', status_code=404)

        # 删除配置
        config_manager.delete_config(agent_name, save=True)

        # 重新加载 orchestrator
        orchestrator = _get_orchestrator()

        # 尝试从 orchestrator 中移除（如果支持）
        if hasattr(orchestrator, 'agents') and agent_name in orchestrator.agents:
            del orchestrator.agents[agent_name]
            logger.info(f"已从 Orchestrator 移除智能体: {agent_name}")

        return success_response(message=f'智能体 {agent_name} 已删除')

    except Exception as e:
        logger.error(f'删除智能体失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/execute', methods=['POST'])
def execute():
    """
    执行智能体任务（自动路由）

    Request:
        {
            "task": "任务描述",
            "session_id": "会话ID（可选）",
            "agent": "指定智能体名称（可选）"
        }

    Returns:
        {
            "success": true,
            "data": {
                "answer": "...",
                "agent_name": "qa_agent",
                "execution_time": 2.5,
                "tool_calls": [...],
                "metadata": {...}
            }
        }
    """
    try:
        data = request.get_json()
        task = data.get('task', '').strip()
        session_id = data.get('session_id')
        user_id = data.get('user_id')
        preferred_agent = data.get('agent')

        if not task:
            return error_response(message='任务描述不能为空', status_code=400)

        logger.info(f'执行智能体任务: {task}')

        # 获取 Orchestrator
        orchestrator = _get_orchestrator()

        # 创建上下文
        if not session_id:
            import uuid
            session_id = str(uuid.uuid4())
        context = AgentContext(session_id=session_id, user_id=user_id)

        store = _get_conversation_store()
        store.create_session(session_id=session_id, user_id=user_id)
        _load_history_into_context(context, session_id=session_id, limit=50)

        # 执行任务
        store.add_message(session_id=session_id, role="user", content=task, metadata={"agent": preferred_agent})
        response = orchestrator.execute(
            task=task,
            context=context,
            preferred_agent=preferred_agent
        )

        if response.success:
            if response.content:
                store.add_message(session_id=session_id, role="assistant", content=response.content, metadata={"agent": response.agent_name})
            return success_response(
                data={
                    'answer': response.content,
                    'agent_name': response.agent_name,
                    'execution_time': response.execution_time,
                    'tool_calls': response.tool_calls,
                    'metadata': response.metadata,
                    'session_id': session_id
                },
                message='任务执行成功'
            )
        else:
            return error_response(
                message=response.error or '任务执行失败',
                status_code=500
            )

    except Exception as e:
        logger.error(f'执行任务失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/stream', methods=['POST'])
def stream_execute():
    """
    流式执行智能体任务（Server-Sent Events）- 使用事件总线解耦

    Request:
        {
            "task": "任务描述",
            "session_id": "会话ID（可选）",
            "selected_llm": "provider|provider_type|model_name（可选，前端 llm-select-trigger 选择，用于临时覆盖默认/未配置 LLM 的智能体）"
        }

    Response:
        text/event-stream
        data: {"type": "thought", "content": "..."}
        data: {"type": "agent_start", "agent": "qa_agent", "content": "..."}
        data: {"type": "chunk", "content": "部分回答..."}
        data: {"type": "done", "session_id": "..."}
    """
    data = request.get_json()
    task = data.get('task', '').strip()
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    # 前端 llm-select-trigger 选择：格式 "provider|provider_type|model_name"，用于临时覆盖默认/未配置 LLM 的智能体
    selected_llm = (data.get('selected_llm') or data.get('selectedLLM') or '').strip()  # 兼容前端可能的 camelCase
    llm_override = None
    if selected_llm:
        parts = selected_llm.split('|')
        if len(parts) >= 3:
            llm_override = {'provider': parts[0], 'provider_type': parts[1], 'model_name': parts[2]}
        elif len(parts) == 2:
            llm_override = {'provider': parts[0], 'provider_type': '', 'model_name': parts[1]}
        elif len(parts) == 1 and parts[0]:
            llm_override = {'provider': parts[0], 'provider_type': None, 'model_name': None}
        logger.info(f'流式请求使用前端选择 LLM: selected_llm={selected_llm!r} -> llm_override={llm_override}')
    else:
        logger.info('流式请求未携带 selected_llm，将使用系统/智能体默认 LLM')

    if not task:
        return error_response(message='任务描述不能为空', status_code=400)

    # 生成 session_id（如果未提供）
    if not session_id:
        import uuid
        session_id = str(uuid.uuid4())

    logger.info(f'流式执行任务: {task} (session_id: {session_id})')

    def generate():
        try:
            store = _get_conversation_store()
            store.create_session(session_id=session_id, user_id=user_id)

            # 获取 Orchestrator
            orchestrator = _get_orchestrator()

            # 创建上下文（含前端选择的 LLM 覆盖）
            context = AgentContext(session_id=session_id, user_id=user_id, llm_override=llm_override)
            _load_history_into_context(context, session_id=session_id, limit=50)

            # 生成 run_id 并注入 context，用于中间过程落库与关联 assistant 消息
            run_id = str(uuid_module.uuid4())
            context.metadata['run_id'] = run_id

            # 创建 cancel_event 用于用户中断
            import threading as _threading
            cancel_event = _threading.Event()
            context.metadata['cancel_event'] = cancel_event

            # 统一入口：MasterAgent V2
            master_agent = orchestrator.agents.get('master_agent_v2')
            if not master_agent:
                yield f"data: {json.dumps({'type': 'error', 'content': 'MasterAgent 未找到，请确认已正确加载'}, ensure_ascii=False)}\n\n"
                return

            # ✨ 获取会话级事件总线
            event_bus = get_session_event_bus(session_id)

            # ✨ 让 MetricsCollector 订阅此会话的事件总线
            metrics_collector = getattr(orchestrator, '_metrics_collector', None)
            metrics_subscription_id = None
            if metrics_collector:
                metrics_subscription_id = metrics_collector.subscribe_to_events(event_bus)
                logger.info(f"✓ MetricsCollector 已订阅会话 {session_id} 的事件总线")

            # ✨ 创建 SSEAdapter 订阅事件总线
            adapter = SSEAdapter(
                event_bus=event_bus,
                session_id=session_id,
                buffer_size=100,
                heartbeat_interval=15.0
            )

            # ✨ 订阅 USER_INTERRUPT 事件，设置 cancel_event
            def handle_user_interrupt(event):
                logger.info(f"收到用户中断事件: session_id={session_id}")
                cancel_event.set()

            interrupt_subscription_id = event_bus.subscribe(
                event_types=[EventType.USER_INTERRUPT],
                handler=handle_user_interrupt,
                filter_func=lambda e: e.session_id == session_id
            )

            # ✨ 订阅 COMPRESSION_SUMMARY 事件并写 DB
            def handle_compression_summary(event):
                """处理上下文压缩摘要事件"""
                try:
                    data = event.data or {}
                    content = data.get("content")
                    event_session_id = data.get("session_id") or event.session_id
                    replaces_up_to_seq = data.get("replaces_up_to_seq")
                    if content and event_session_id:
                        store.insert_compression_message(
                            session_id=event_session_id,
                            summary_content=content,
                            replaces_up_to_seq=replaces_up_to_seq,
                        )
                        logger.info(f"已保存压缩摘要到 DB: session_id={event_session_id}, replaces_up_to_seq={replaces_up_to_seq}")
                except Exception as e:
                    logger.warning(f"保存压缩摘要失败: {e}", exc_info=True)

            compression_subscription_id = event_bus.subscribe(
                event_types=[EventType.COMPRESSION_SUMMARY],
                handler=handle_compression_summary,
                filter_func=lambda e: e.session_id == session_id
            )

            # ✨ 订阅 REACT_INTERMEDIATE 事件，将中间推理过程写入 DB
            def handle_react_intermediate(event):
                try:
                    d = event.data or {}
                    store.add_message(
                        session_id=session_id,
                        role=d.get("role", "assistant"),
                        content=d.get("content", ""),
                        metadata={
                            "react_intermediate": True,
                            "msg_type": d.get("msg_type"),
                            "round": d.get("round"),
                            "run_id": run_id,
                            "agent": "master_agent_v2",
                        },
                    )
                except Exception as e:
                    logger.warning(f"写入 react_intermediate 消息失败: {e}", exc_info=True)

            react_intermediate_subscription_id = event_bus.subscribe(
                event_types=[EventType.REACT_INTERMEDIATE],
                handler=handle_react_intermediate,
                filter_func=lambda e: e.session_id == session_id
            )

            # ✨ 在后台执行 Agent（不再迭代生成器）
            import threading
            final_answer_saved = threading.Event()
            # 保存 FINAL_ANSWER 时写入的 message_id，供 RUN_END 时再次更新 run_steps，使 AGENT_END/RUN_END 等后续步骤也关联到该消息
            message_id_for_run = [None]

            # 需要落库的中间过程事件类型
            step_event_types = [
                EventType.RUN_START,
                EventType.AGENT_START,
                EventType.THOUGHT_STRUCTURED,
                EventType.CALL_AGENT_START,
                EventType.CALL_AGENT_END,
                EventType.CALL_TOOL_START,
                EventType.CALL_TOOL_END,
                EventType.FINAL_ANSWER,
                EventType.RUN_END,
            ]

            def make_payload_safe(data):
                """确保 payload 可 JSON 序列化（避免 event.data 中含不可序列化对象）。"""
                if data is None:
                    return {}
                if not isinstance(data, dict):
                    return {"value": str(data)}
                out = {}
                for k, v in data.items():
                    try:
                        json.dumps(v, ensure_ascii=False)
                        out[k] = v
                    except (TypeError, ValueError):
                        out[k] = str(v)
                return out

            def event_to_payload(event):
                """与 SSE 发送的事件结构一致；call.agent.start/end 的 agent_name 存被调用 Agent，与 stream 语义对齐。"""
                payload = {
                    "type": event.type.value,
                    "event_id": getattr(event, "event_id", None),
                    "timestamp": getattr(event, "timestamp", None),
                    "priority": getattr(getattr(event, "priority", None), "value", None),
                    "session_id": getattr(event, "session_id", None),
                    "trace_id": getattr(event, "trace_id", None),
                    "span_id": getattr(event, "span_id", None),
                    "agent_name": event.agent_name,
                    "call_id": getattr(event, "call_id", None),
                    "parent_call_id": getattr(event, "parent_call_id", None),
                    "data": make_payload_safe(event.data),
                    "requires_user_action": getattr(event, "requires_user_action", False),
                    "user_action_timeout": getattr(event, "user_action_timeout", None),
                }
                # call.agent.start / call.agent.end：持久化 top-level agent_name 存「被调用 Agent」，与前端从 stream 使用的 data.agent_name 语义一致
                if event.type in (EventType.CALL_AGENT_START, EventType.CALL_AGENT_END):
                    called = (event.data or {}).get("agent_name")
                    if called is not None:
                        payload["agent_name"] = called
                return payload

            def handle_step_and_final_answer(event):
                payload = event_to_payload(event)
                try:
                    store.add_run_step(
                        session_id=session_id,
                        run_id=run_id,
                        step_type=event.type.value,
                        payload=payload,
                        message_id=None,
                    )
                except Exception as e:
                    logger.warning(f"写入 run_step 失败: {e}", exc_info=True)
                if event.type == EventType.FINAL_ANSWER:
                    # 只持久化 master_agent_v2 的最终答案；子 Agent 也会发布 FINAL_ANSWER，
                    # 若不过滤，子 Agent 的回答会先于 observation 写入，且 final_answer_saved
                    # 被提前设置，导致 MasterAgent 真正的最终答案被丢弃。
                    if event.agent_name and event.agent_name != 'master_agent_v2':
                        return
                    content = (event.data or {}).get("content")
                    if content is not None and not final_answer_saved.is_set():
                        try:
                            msg = store.add_message(
                                session_id=session_id,
                                role="assistant",
                                content=content if isinstance(content, str) else str(content),
                                metadata={"agent": event.agent_name, "run_id": run_id},
                            )
                            message_id_for_run[0] = msg["id"]
                            store.update_run_steps_message_id(session_id, run_id, msg["id"])
                        except Exception as e:
                            logger.warning(f"写入 assistant 消息或更新 run_steps message_id 失败: {e}", exc_info=True)
                        final_answer_saved.set()
                if event.type == EventType.RUN_END and message_id_for_run[0]:
                    # FINAL_ANSWER 之后还会写入 AGENT_END、RUN_END，需再次绑定 message_id，否则按 message_id 查 steps 会漏掉
                    try:
                        store.update_run_steps_message_id(session_id, run_id, message_id_for_run[0])
                    except Exception as e:
                        logger.warning(f"RUN_END 时更新 run_steps message_id 失败: {e}", exc_info=True)

            subscription_id = event_bus.subscribe(
                event_types=step_event_types,
                handler=handle_step_and_final_answer,
                filter_func=lambda e: e.session_id == session_id
            )

            store.add_message(session_id=session_id, role="user", content=task, metadata={"agent": "master_agent_v2"})

            def execute_agent_task():
                try:
                    logger.info(f"后台执行 Agent 任务: {task}")
                    response = master_agent.execute(task, context)
                    if response and getattr(response, "content", None) and not final_answer_saved.is_set():
                        msg = store.add_message(
                            session_id=session_id,
                            role="assistant",
                            content=response.content,
                            metadata={"agent": getattr(response, "agent_name", None), "run_id": run_id},
                        )
                        store.update_run_steps_message_id(session_id, run_id, msg["id"])
                        final_answer_saved.set()
                    logger.info(f"Agent 任务执行完成: {task}")
                except Exception as e:
                    logger.error(f"后台执行 Agent 失败: {e}", exc_info=True)
                    # 发布错误事件
                    from agents.events import EventPublisher
                    publisher = EventPublisher(
                        agent_name="system",
                        session_id=session_id,
                        event_bus=event_bus
                    )
                    publisher.agent_error(error=str(e), error_type="ExecutionError")

            # 启动后台线程执行 Agent
            thread = threading.Thread(target=execute_agent_task, daemon=True)
            thread.start()

            # ✨ 从事件总线流式输出（SSEAdapter 内部管理 start/stop 生命周期）
            try:
                for sse_data in adapter.stream_sync():
                    yield sse_data
            finally:
                event_bus.unsubscribe(subscription_id)
                event_bus.unsubscribe(compression_subscription_id)
                event_bus.unsubscribe(react_intermediate_subscription_id)
                event_bus.unsubscribe(interrupt_subscription_id)
                if metrics_subscription_id:
                    event_bus.unsubscribe(metrics_subscription_id)

            # 结束事件
            yield f"data: {json.dumps({'type': 'done', 'session_id': session_id}, ensure_ascii=False)}\n\n"

        except Exception as e:
            logger.error(f"流式执行异常: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)}, ensure_ascii=False)}\n\n"

    response = Response(stream_with_context(generate()), mimetype='text/event-stream')
    response.headers['Content-Type'] = 'text/event-stream; charset=utf-8'
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'
    return response


@agent_bp.route('/stream/stop', methods=['POST'])
def stream_stop():
    """
    停止正在执行的流式任务

    Request:
        {
            "session_id": "会话ID"
        }

    Returns:
        {"interrupted": true}
    """
    try:
        data = request.get_json()
        session_id = data.get('session_id')

        if not session_id:
            return error_response(message='session_id 不能为空', status_code=400)

        event_bus = get_session_event_bus(session_id)
        from agents.events.bus import Event
        event_bus.publish(Event(
            type=EventType.USER_INTERRUPT,
            data={"reason": "user_stop"},
            session_id=session_id
        ))

        logger.info(f"已发送用户中断事件: session_id={session_id}")
        return success_response(data={"interrupted": True})

    except Exception as e:
        logger.error(f"停止流式任务失败: {e}", exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/execute/<agent_name>', methods=['POST'])
def execute_specific_agent(agent_name):
    """
    执行指定智能体

    Request:
        {
            "task": "任务描述",
            "session_id": "会话ID（可选）"
        }

    Returns:
        同 /execute
    """
    try:
        data = request.get_json()
        task = data.get('task', '').strip()
        session_id = data.get('session_id')
        user_id = data.get('user_id')

        if not task:
            return error_response(message='任务描述不能为空', status_code=400)

        logger.info(f'执行智能体 {agent_name} 任务: {task}')

        # 获取 Orchestrator
        orchestrator = _get_orchestrator()

        # 创建上下文
        if not session_id:
            import uuid
            session_id = str(uuid.uuid4())
        context = AgentContext(session_id=session_id, user_id=user_id)

        store = _get_conversation_store()
        store.create_session(session_id=session_id, user_id=user_id)
        _load_history_into_context(context, session_id=session_id, limit=50)

        # 执行任务（指定智能体）
        store.add_message(session_id=session_id, role="user", content=task, metadata={"agent": agent_name})
        response = orchestrator.execute(
            task=task,
            context=context,
            preferred_agent=agent_name
        )

        if response.success:
            if response.content:
                store.add_message(session_id=session_id, role="assistant", content=response.content, metadata={"agent": response.agent_name})
            return success_response(
                data={
                    'answer': response.content,
                    'agent_name': response.agent_name,
                    'execution_time': response.execution_time,
                    'tool_calls': response.tool_calls,
                    'metadata': response.metadata,
                    'session_id': session_id
                },
                message='任务执行成功'
            )
        else:
            return error_response(
                message=response.error or '任务执行失败',
                status_code=500
            )

    except Exception as e:
        logger.error(f'执行任务失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/collaborate', methods=['POST'])
def collaborate():
    """
    多智能体协作

    Request:
        {
            "tasks": [
                {"task": "查询数据", "agent": "qa_agent"},
                {"task": "生成图表", "agent": "chart_agent"}
            ],
            "session_id": "会话ID（可选）",
            "mode": "sequential"  // sequential 或 parallel
        }

    Returns:
        {
            "success": true,
            "data": {
                "results": [...]  // 每个任务的结果
            }
        }
    """
    try:
        data = request.get_json()
        tasks = data.get('tasks', [])
        session_id = data.get('session_id')
        user_id = data.get('user_id')
        mode = data.get('mode', 'sequential')

        if not tasks:
            return error_response(message='任务列表不能为空', status_code=400)

        logger.info(f'多智能体协作，任务数: {len(tasks)}, 模式: {mode}')

        # 获取 Orchestrator
        orchestrator = _get_orchestrator()

        # 创建上下文
        if not session_id:
            import uuid
            session_id = str(uuid.uuid4())
        context = AgentContext(session_id=session_id, user_id=user_id)

        store = _get_conversation_store()
        store.create_session(session_id=session_id, user_id=user_id)
        _load_history_into_context(context, session_id=session_id, limit=50)

        for t in tasks:
            task_content = (t.get('task') or '').strip()
            if task_content:
                store.add_message(session_id=session_id, role="user", content=task_content, metadata={"agent": t.get("agent")})

        # 执行协作
        results = orchestrator.collaborate(
            tasks=tasks,
            context=context,
            mode=mode
        )

        # 整理结果
        results_data = [
            {
                'success': r.success,
                'content': r.content,
                'error': r.error,
                'agent_name': r.agent_name,
                'execution_time': r.execution_time
            }
            for r in results
        ]

        for r in results:
            if r and r.content:
                store.add_message(session_id=session_id, role="assistant", content=r.content, metadata={"agent": r.agent_name})

        return success_response(
            data={
                'results': results_data,
                'session_id': session_id,
                'total_tasks': len(tasks)
            },
            message='协作任务执行完成'
        )

    except Exception as e:
        logger.error(f'协作任务执行失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions', methods=['POST'])
def create_session():
    try:
        data = request.get_json() or {}
        user_id = data.get('user_id')
        metadata = data.get('metadata') or {}
        session_id = data.get('session_id')
        if not session_id:
            import uuid
            session_id = str(uuid.uuid4())

        store = _get_conversation_store()
        store.create_session(session_id=session_id, user_id=user_id, metadata=metadata)

        return success_response(
            data={
                'session_id': session_id,
                'user_id': user_id,
                'metadata': metadata
            },
            message='会话创建成功'
        )
    except Exception as e:
        logger.error(f'创建会话失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions', methods=['GET'])
def list_sessions():
    try:
        limit = int(request.args.get('limit', 20))
        offset = int(request.args.get('offset', 0))
        user_id = request.args.get('user_id')
        if user_id is not None and str(user_id).strip() == "":
            user_id = None
        store = _get_conversation_store()
        data = store.list_sessions(limit=limit, offset=offset, user_id=user_id)
        return success_response(data=data, message='获取会话列表成功')
    except Exception as e:
        logger.error(f'获取会话列表失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions/<session_id>', methods=['GET'])
def get_session(session_id):
    try:
        store = _get_conversation_store()
        session = store.get_session(session_id=session_id)
        if not session:
            return error_response(message='会话不存在', status_code=404)
        return success_response(data=session, message='获取会话成功')
    except Exception as e:
        logger.error(f'获取会话失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions/<session_id>', methods=['DELETE'])
def delete_session(session_id):
    """删除会话及其所有消息"""
    try:
        store = _get_conversation_store()
        session = store.get_session(session_id=session_id)
        if not session:
            return error_response(message='会话不存在', status_code=404)

        # 删除会话（会级联删除所有消息和 run_steps）
        store.delete_session(session_id=session_id)

        return success_response(message='会话删除成功')
    except Exception as e:
        logger.error(f'删除会话失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions/<session_id>/recover', methods=['POST'])
def recover_session(session_id):
    """
    从检查点恢复会话执行

    Body:
        {
            "checkpoint_id": "xxx",  // 可选，不指定则使用最新检查点
            "agent_name": "qa_agent"  // 可选，指定智能体
        }

    Returns:
        {
            "success": true,
            "data": {
                "checkpoint_id": "xxx",
                "round": 3,
                "answer": "...",
                "success": true
            }
        }
    """
    try:
        from agents.recovery import CheckpointManager

        data = request.get_json() or {}
        checkpoint_id = data.get('checkpoint_id')
        agent_name = data.get('agent_name')

        # 初始化检查点管理器
        checkpoint_manager = CheckpointManager()

        # 加载检查点
        if checkpoint_id:
            checkpoint = checkpoint_manager.load_checkpoint(checkpoint_id)
        else:
            checkpoint = checkpoint_manager.get_latest_checkpoint(
                session_id=session_id,
                agent_name=agent_name
            )

        if not checkpoint:
            return error_response(
                message='未找到可用的检查点',
                status_code=404
            )

        logger.info(f"从检查点恢复: {checkpoint['checkpoint_id']}, 轮次: {checkpoint['round']}")

        # 重建上下文
        orchestrator = _get_orchestrator()
        context = AgentContext(
            session_id=session_id,
            user_id=data.get('user_id')
        )

        # 恢复消息历史
        for msg in checkpoint['messages']:
            context.add_message(
                role=msg['role'],
                content=msg['content'],
                metadata=msg.get('metadata', {})
            )

        # 获取最后一条用户消息作为任务
        user_messages = [m for m in checkpoint['messages'] if m['role'] == 'user']
        if not user_messages:
            return error_response(
                message='检查点中没有用户消息',
                status_code=400
            )

        task = user_messages[-1]['content']

        # 继续执行
        response = orchestrator.execute(
            task=task,
            context=context,
            agent_name=checkpoint['agent_name']
        )

        # 保存结果
        store = _get_conversation_store()
        if response.success and response.content:
            store.add_message(
                session_id=session_id,
                role='assistant',
                content=response.content,
                metadata={
                    'agent': response.agent_name,
                    'recovered_from': checkpoint['checkpoint_id']
                }
            )

        return success_response(
            data={
                'checkpoint_id': checkpoint['checkpoint_id'],
                'round': checkpoint['round'],
                'answer': response.content if response.success else None,
                'success': response.success,
                'error': response.error if not response.success else None,
                'agent_name': response.agent_name
            },
            message='从检查点恢复成功' if response.success else '恢复执行完成但未成功'
        )

    except Exception as e:
        logger.error(f'从检查点恢复失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions/<session_id>/checkpoints', methods=['GET'])
def list_session_checkpoints(session_id):
    """
    列出会话的检查点

    Query Parameters:
        agent_name: 智能体名称（可选）
        limit: 返回数量限制（默认 10）

    Returns:
        {
            "success": true,
            "data": {
                "checkpoints": [...]
            }
        }
    """
    try:
        from agents.recovery import CheckpointManager

        agent_name = request.args.get('agent_name')
        limit = int(request.args.get('limit', 10))

        checkpoint_manager = CheckpointManager()
        checkpoints = checkpoint_manager.list_checkpoints(
            session_id=session_id,
            agent_name=agent_name,
            limit=limit
        )

        return success_response(
            data={'checkpoints': checkpoints},
            message='获取检查点列表成功'
        )

    except Exception as e:
        logger.error(f'获取检查点列表失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions/<session_id>/rollback', methods=['POST'])
def rollback_session(session_id):
    """
    回退到某条消息：删除该条之后的所有消息及关联 run_steps。
    Body: { "after_seq": 5 } 或 { "after_message_id": "uuid" }
    """
    try:
        data = request.get_json() or {}
        after_seq = data.get('after_seq')
        after_message_id = data.get('after_message_id')
        if after_seq is None and not after_message_id:
            return error_response(message='请提供 after_seq 或 after_message_id', status_code=400)
        if after_seq is not None and not isinstance(after_seq, int):
            try:
                after_seq = int(after_seq)
            except (TypeError, ValueError):
                return error_response(message='after_seq 须为整数', status_code=400)
        store = _get_conversation_store()
        deleted = store.delete_messages_after(
            session_id=session_id,
            after_seq=after_seq,
            after_message_id=after_message_id,
        )
        return success_response(data={'deleted': deleted}, message='回退成功')
    except Exception as e:
        logger.error(f'回退失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions/<session_id>/rollback-and-retry', methods=['POST'])
def rollback_and_retry(session_id):
    """
    回退到某条消息并自动重试：删除该条之后的消息，使用原问题或修改后的问题重新执行。

    Body: {
        "after_seq": 5,                      # 回退到第 5 条（该条保留，之后删除）
        "modify_user_message": "新问题",      # 可选：修改用户问题后重试
        "user_id": "xxx"                     # 可选：用户 ID
    }
    要求 after_seq 对应的消息必须是 user 角色。
    """
    try:
        data = request.get_json() or {}
        after_seq = data.get('after_seq')
        if after_seq is None:
            return error_response(message='请提供 after_seq', status_code=400)
        try:
            after_seq = int(after_seq)
        except (TypeError, ValueError):
            return error_response(message='after_seq 须为整数', status_code=400)

        store = _get_conversation_store()
        original_message = store.get_message_by_seq(session_id=session_id, seq=after_seq)
        if not original_message:
            return error_response(message=f'未找到会话 {session_id} 中序号为 {after_seq} 的消息', status_code=404)
        if original_message.get('role') != 'user':
            return error_response(message='指定位置必须是用户消息（user），才能从此处重试', status_code=400)

        deleted = store.delete_messages_after(session_id=session_id, after_seq=after_seq)
        task = data.get('modify_user_message')
        if task is not None:
            task = (task or '').strip()
        if not task:
            task = (original_message.get('content') or '').strip()
        if not task:
            return error_response(message='无法获取要重试的任务内容', status_code=400)

        if data.get('modify_user_message') is not None:
            store.update_message(
                message_id=original_message['id'],
                content=task,
                session_id=session_id,
                role_filter='user'
            )

        user_id = data.get('user_id')
        orchestrator = _get_orchestrator()
        context = AgentContext(session_id=session_id, user_id=user_id)
        _load_history_into_context(context, session_id=session_id, limit=50)

        response = orchestrator.execute(task=task, context=context)

        if response.success and response.content:
            store.add_message(
                session_id=session_id,
                role='assistant',
                content=response.content,
                metadata={'agent': response.agent_name}
            )

        return success_response(
            data={
                'deleted': deleted,
                'answer': response.content if response.success else None,
                'agent_name': response.agent_name if response.success else None,
                'execution_time': getattr(response, 'execution_time', None),
                'success': response.success,
                'error': response.error if not response.success else None
            },
            message='重试成功' if response.success else '重试执行完成但未得到成功结果'
        )
    except Exception as e:
        logger.error(f'回退并重试失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions/<session_id>/messages/<message_id>', methods=['PATCH'])
def update_session_message(session_id, message_id):
    """
    更新某条消息内容（主要用于编辑 user 消息）。
    Body: { "content": "新内容" }
    """
    try:
        data = request.get_json() or {}
        content = data.get('content')
        if content is None:
            return error_response(message='请提供 content', status_code=400)
        store = _get_conversation_store()
        updated = store.update_message(
            message_id=message_id,
            content=content,
            session_id=session_id,
            role_filter='user',
        )
        if not updated:
            return error_response(message='消息不存在或不可编辑', status_code=404)
        return success_response(data={'message_id': message_id}, message='更新成功')
    except Exception as e:
        logger.error(f'更新消息失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/sessions/<session_id>/messages', methods=['GET'])
def get_session_messages(session_id):
    try:
        limit = int(request.args.get('limit', 20))
        offset = int(request.args.get('offset', 0))
        expand = request.args.get('expand', 'steps').lower()
        expand_steps = expand in ('1', 'true', 'steps', 'yes')
        store = _get_conversation_store()
        data = store.list_messages(session_id=session_id, limit=limit, offset=offset)
        # 过滤掉 ReAct 中间消息，前端聊天界面不显示
        if data.get('items'):
            data['items'] = [
                item for item in data['items']
                if not (item.get('metadata') or {}).get('react_intermediate')
            ]
        if expand_steps and data.get('items'):
            for item in data['items']:
                if item.get('role') == 'assistant' and (item.get('metadata') or {}).get('run_id'):
                    # 按 run_id 查该 run 的全部 steps，避免 FINAL_ANSWER 之后写入的 AGENT_END/RUN_END 因 message_id 未及时更新而被漏掉
                    run_id = (item.get('metadata') or {}).get('run_id')
                    steps = store.list_run_steps(
                        run_id=run_id,
                        session_id=session_id,
                        limit=500,
                    )
                    item['steps'] = steps
        return success_response(data=data, message='获取对话记录成功')
    except Exception as e:
        logger.error(f'获取对话记录失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/metrics', methods=['GET'])
def get_metrics():
    """
    获取智能体性能指标

    Query Parameters:
        agent_name: 指定智能体名称（可选），不指定则返回所有智能体指标

    Returns:
        {
            "success": true,
            "data": {
                "total_agents": 3,
                "total_calls": 156,
                "avg_duration_ms": 2340.5,
                "overall_success_rate": 0.94,
                "agents": {
                    "qa_agent": {
                        "total_calls": 89,
                        "success_rate": 0.95,
                        "avg_duration_ms": 2100.3,
                        "tool_usage": {...},
                        "error_distribution": {...}
                    }
                }
            }
        }
    """
    try:
        from agents.monitoring import MetricsCollector

        # 获取全局 metrics_collector（从 app.py 初始化）
        metrics_collector = getattr(_get_orchestrator(), '_metrics_collector', None)
        if not metrics_collector:
            return error_response(
                message='指标收集器未初始化',
                status_code=503
            )

        agent_name = request.args.get('agent_name')

        if agent_name:
            # 返回单个智能体指标
            metrics = metrics_collector.get_agent_metrics(agent_name)
            if not metrics:
                return error_response(
                    message=f'未找到智能体 {agent_name} 的指标',
                    status_code=404
                )
            return success_response(
                data=metrics.to_dict(),
                message='获取智能体指标成功'
            )
        else:
            # 返回系统级指标
            system_metrics = metrics_collector.get_all_metrics()
            return success_response(
                data=system_metrics.to_dict(),
                message='获取系统指标成功'
            )

    except Exception as e:
        logger.error(f'获取指标失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/metrics/reset', methods=['POST'])
def reset_metrics():
    """
    重置性能指标

    Body:
        {
            "agent_name": "qa_agent"  // 可选，不指定则重置所有
        }
    """
    try:
        from agents.monitoring import MetricsCollector

        metrics_collector = getattr(_get_orchestrator(), '_metrics_collector', None)
        if not metrics_collector:
            return error_response(
                message='指标收集器未初始化',
                status_code=503
            )

        data = request.get_json() or {}
        agent_name = data.get('agent_name')

        metrics_collector.reset_metrics(agent_name)

        return success_response(
            message=f'已重置{"智能体 " + agent_name if agent_name else "所有"}指标'
        )

    except Exception as e:
        logger.error(f'重置指标失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/context-snapshot', methods=['GET'])
def get_context_snapshot():
    """获取 MasterAgent V2 的上下文快照，用于调试和可视化"""
    try:
        session_id = request.args.get('session_id')
        orchestrator = _get_orchestrator()
        master = orchestrator.agents.get('master_agent_v2')
        if not master:
            return error_response(message='MasterAgentV2 未加载', status_code=503)

        # system prompt & agent tools
        system_prompt = master._build_system_prompt()
        agent_tools = [
            {'name': t['function']['name'], 'description': t['function']['description']}
            for t in master._get_available_agent_tools()
        ]

        # token counter
        from agents.context.token_counter import TokenCounter
        llm_cfg = master.get_llm_config()
        counter = TokenCounter(model_name=llm_cfg.get('model_name'))
        sp_tokens = counter.count_text(system_prompt)

        # conversation history
        history = []
        history_tokens = 0
        if session_id:
            store = _get_conversation_store()
            raw = store.get_recent_messages(session_id=session_id, limit=50)
            for msg in raw:
                if msg.get('role') in ('user', 'assistant', 'system'):
                    content = msg.get('content', '')
                    t = counter.count_text(content)
                    history_tokens += t
                    meta = msg.get('metadata') or {}
                    history.append({
                        'role': msg['role'],
                        'content': content[:200] + ('...' if len(content) > 200 else ''),
                        'tokens': t,
                        'seq': msg.get('seq'),
                        'react_intermediate': meta.get('react_intermediate', False),
                        'msg_type': meta.get('msg_type'),
                        'round': meta.get('round'),
                    })

        max_tokens = master.context_pipeline.config.max_tokens
        total = sp_tokens + history_tokens

        # config info
        cfg = master.context_pipeline.config
        config_info = {
            'max_rounds': master.max_rounds,
            'compression': {
                'strategy': 'llm_summarize_with_fallback',
                'trigger_ratio': cfg.compression_trigger_ratio,
                'preserve_recent_turns': cfg.preserve_recent_turns,
                'summarize_max_tokens': cfg.summarize_max_tokens,
            },
            'model': llm_cfg.get('model_name', ''),
        }

        return success_response(data={
            'system_prompt': system_prompt,
            'available_agent_tools': agent_tools,
            'conversation_history': history,
            'token_stats': {
                'system_prompt_tokens': sp_tokens,
                'history_tokens': history_tokens,
                'total_tokens': total,
                'max_tokens': max_tokens,
            },
            'config': config_info,
        }, message='获取上下文快照成功')

    except Exception as e:
        logger.error(f'获取上下文快照失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)


@agent_bp.route('/health', methods=['GET'])
def health():
    """健康检查"""
    try:
        orchestrator = _get_orchestrator()
        agents = orchestrator.list_agents()

        return success_response(
            data={
                'status': 'healthy',
                'agents_count': len(agents)
            },
            message='智能体系统运行正常'
        )

    except Exception as e:
        logger.error(f'健康检查失败: {e}')
        return error_response(message=str(e), status_code=500)
