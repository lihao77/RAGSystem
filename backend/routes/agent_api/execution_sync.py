# -*- coding: utf-8 -*-
"""
Agent 同步执行与协作路由。
"""

from .shared import (
    AgentContext,
    agent_bp,
    error_response,
    logger,
    request,
    success_response,
    _get_conversation_store,
    _get_orchestrator,
    _load_history_into_context,
)
from services.execution_service import get_execution_service


def _build_status_payload(*, scope: str, scope_id: str, status, observability=None):
    return {
        scope: scope_id,
        'scope': scope,
        'scope_id': scope_id,
        'found': status is not None,
        'has_running_task': status is not None and status.get('status') == 'running',
        'task_info': status,
        'observability': observability,
    }


def _build_diagnostics_payload(*, scope: str, scope_id: str, diagnostics):
    return {
        scope: scope_id,
        'scope': scope,
        'scope_id': scope_id,
        'found': diagnostics is not None,
        'diagnostics': diagnostics,
    }

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

@agent_bp.route('/sessions/<session_id>/task-status', methods=['GET'])
def get_session_task_status(session_id):
    """
    查询会话的当前任务执行状态

    Returns:
        {
            "session_id": "...",
            "has_running_task": true/false,
            "task_info": { status, run_id, task, elapsed_seconds, thread_alive } | null
        }
    """
    execution_service = get_execution_service()
    status = execution_service.get_status_by_session(session_id)
    diagnostics = execution_service.get_diagnostics_by_session(session_id)
    return success_response(data=_build_status_payload(
        scope='session_id',
        scope_id=session_id,
        status=status,
        observability=diagnostics.get('observability') if diagnostics is not None else None,
    ))


@agent_bp.route('/sessions/<session_id>/execution-diagnostics', methods=['GET'])
def get_session_execution_diagnostics(session_id):
    """查询会话的 execution diagnostics（面向排障与观测）。"""
    diagnostics = get_execution_service().get_diagnostics_by_session(session_id)
    return success_response(data=_build_diagnostics_payload(
        scope='session_id',
        scope_id=session_id,
        diagnostics=diagnostics,
    ))


@agent_bp.route('/tasks/<task_id>/execution-diagnostics', methods=['GET'])
def get_task_execution_diagnostics(task_id):
    """按 task_id 查询 execution diagnostics（面向排障与观测）。"""
    diagnostics = get_execution_service().get_diagnostics(task_id)
    return success_response(data=_build_diagnostics_payload(
        scope='task_id',
        scope_id=task_id,
        diagnostics=diagnostics,
    ))


@agent_bp.route('/tasks/<task_id>/status', methods=['GET'])
def get_task_status(task_id):
    """按 task_id 查询任务状态。"""
    status = get_execution_service().get_status(task_id)
    return success_response(data=_build_status_payload(
        scope='task_id',
        scope_id=task_id,
        status=status,
        observability=(
            {
                'task_id': status.get('task_id'),
                'session_id': status.get('session_id'),
                'run_id': status.get('run_id'),
                'execution_kind': status.get('execution_kind'),
                'request_id': status.get('request_id'),
            }
            if status is not None else None
        ),
    ))


@agent_bp.route('/tasks/running', methods=['GET'])
def list_running_tasks():
    """列出当前运行中的任务状态。"""
    items = get_execution_service().list_statuses(active_only=True)
    return success_response(data={
        'active_only': True,
        'count': len(items),
        'items': items,
    })


@agent_bp.route('/execution/overview', methods=['GET'])
def get_execution_overview():
    """获取 execution plane 的聚合概览。"""
    active_only = str(request.args.get('active_only', 'true')).strip().lower() not in {'0', 'false', 'no', 'off'}
    overview = get_execution_service().get_overview(active_only=active_only)
    return success_response(data=overview)

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
