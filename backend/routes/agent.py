# -*- coding: utf-8 -*-
"""
Agent API 路由 - 智能体系统统一入口

提供智能体系统的 API 接口
"""

from flask import Blueprint, request, Response, stream_with_context
import logging
import json
import asyncio
from agents import (
    AgentContext,
    get_orchestrator,
    get_config_manager,
    load_agents_from_config
)
from agents.event_bus import EventType
from agents.session_event_bus_manager import get_session_event_bus
from agents.sse_adapter import SSEAdapter
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


def _load_history_into_context(context: AgentContext, session_id: str, limit: int = 20):
    store = _get_conversation_store()
    history_items = store.get_recent_messages(session_id=session_id, limit=limit)
    for item in history_items:
        if item.get("role") in ["user", "assistant"]:
            context.add_message(role=item["role"], content=item["content"], metadata=item.get("metadata") or {})


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

        from agents.agent_config import AgentConfig

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
            from agents.agent_loader import AgentLoader
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
        if agent_name in ['master_agent']:
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
        _load_history_into_context(context, session_id=session_id, limit=20)

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
        注：仅使用 MasterAgent V2，V1 已废弃。

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
            _load_history_into_context(context, session_id=session_id, limit=20)

            # 强制使用 MasterAgent V2
            master_agent = orchestrator.agents.get('master_agent_v2')
            if not master_agent:
                yield f"data: {json.dumps({'type': 'error', 'content': 'MasterAgent V2 未找到，请确认已正确加载'}, ensure_ascii=False)}\n\n"
                return

            # ✨ 获取会话级事件总线
            event_bus = get_session_event_bus(session_id)

            # ✨ 创建 SSEAdapter 订阅事件总线
            adapter = SSEAdapter(
                event_bus=event_bus,
                session_id=session_id,
                buffer_size=100,
                heartbeat_interval=15.0
            )

            # ✨ 在后台执行 Agent（不再迭代生成器）
            import threading
            final_answer_saved = threading.Event()

            def handle_final_answer(event):
                content = event.data.get("content") if event and event.data else None
                if content and not final_answer_saved.is_set():
                    store.add_message(
                        session_id=session_id,
                        role="assistant",
                        content=content,
                        metadata={"agent": event.agent_name}
                    )
                    final_answer_saved.set()

            subscription_id = event_bus.subscribe(
                event_types=[EventType.FINAL_ANSWER],
                handler=handle_final_answer,
                filter_func=lambda e: e.session_id == session_id
            )

            store.add_message(session_id=session_id, role="user", content=task, metadata={"agent": "master_agent_v2"})

            def execute_agent_task():
                try:
                    logger.info(f"后台执行 Agent 任务: {task}")
                    response = master_agent.execute(task, context)
                    if response and getattr(response, "content", None) and not final_answer_saved.is_set():
                        store.add_message(
                            session_id=session_id,
                            role="assistant",
                            content=response.content,
                            metadata={"agent": getattr(response, "agent_name", None)}
                        )
                        final_answer_saved.set()
                    logger.info(f"Agent 任务执行完成: {task}")
                except Exception as e:
                    logger.error(f"后台执行 Agent 失败: {e}", exc_info=True)
                    # 发布错误事件
                    from agents.event_publisher import EventPublisher
                    publisher = EventPublisher(
                        agent_name="system",
                        session_id=session_id,
                        event_bus=event_bus
                    )
                    publisher.agent_error(error=str(e), error_type="ExecutionError")

            # 启动后台线程执行 Agent
            thread = threading.Thread(target=execute_agent_task, daemon=True)
            thread.start()

            # ✨ 从事件总线流式输出（SSEAdapter 会自动格式化为 SSE）
            adapter.start()
            try:
                # SSEAdapter.stream() 返回已格式化的 SSE 数据（"data: ...\n\n"）
                for sse_data in adapter.stream_sync():
                    yield sse_data
            finally:
                event_bus.unsubscribe(subscription_id)
                adapter.stop()

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
        _load_history_into_context(context, session_id=session_id, limit=20)

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
        _load_history_into_context(context, session_id=session_id, limit=20)

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


@agent_bp.route('/sessions/<session_id>/messages', methods=['GET'])
def get_session_messages(session_id):
    try:
        limit = int(request.args.get('limit', 20))
        offset = int(request.args.get('offset', 0))
        store = _get_conversation_store()
        data = store.list_messages(session_id=session_id, limit=limit, offset=offset)
        return success_response(data=data, message='获取对话记录成功')
    except Exception as e:
        logger.error(f'获取对话记录失败: {e}', exc_info=True)
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
