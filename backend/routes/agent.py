# -*- coding: utf-8 -*-
"""
Agent API 路由 - 智能体系统统一入口

提供智能体系统的 API 接口
"""

from flask import Blueprint, request
import logging
from agents import QAAgent, MasterAgent, get_orchestrator, AgentContext, get_config_manager
from llm_adapter import get_default_adapter
from config import get_config
from utils.response_helpers import success_response, error_response

logger = logging.getLogger(__name__)

agent_bp = Blueprint('agent', __name__)


# 全局 Orchestrator（延迟初始化）
_orchestrator = None


def _get_orchestrator():
    """获取或初始化全局 Orchestrator"""
    global _orchestrator

    if _orchestrator is None:
        try:
            system_config = get_config()
            adapter = get_default_adapter()
            config_manager = get_config_manager()

            # 创建 Orchestrator
            _orchestrator = get_orchestrator(llm_adapter=adapter)

            # 加载 QAAgent 配置并注册
            qa_agent_config = config_manager.get_config('qa_agent')
            qa_agent = QAAgent(
                llm_adapter=adapter,
                agent_config=qa_agent_config,
                system_config=system_config
            )
            _orchestrator.register_agent(qa_agent)

            # 加载 MasterAgent 配置并注册
            master_agent_config = config_manager.get_config('master_agent')
            master_agent = MasterAgent(
                llm_adapter=adapter,
                orchestrator=_orchestrator,
                agent_config=master_agent_config,
                system_config=system_config
            )
            _orchestrator.register_agent(master_agent)

            logger.info("Orchestrator 初始化成功")
        except Exception as e:
            logger.error(f"Orchestrator 初始化失败: {e}")
            raise

    return _orchestrator


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
        preferred_agent = data.get('agent')

        if not task:
            return error_response(message='任务描述不能为空', status_code=400)

        logger.info(f'执行智能体任务: {task}')

        # 获取 Orchestrator
        orchestrator = _get_orchestrator()

        # 创建上下文
        if session_id:
            # 这里可以从会话管理器获取现有上下文
            # 暂时每次创建新上下文
            context = AgentContext(session_id=session_id)
        else:
            import uuid
            context = AgentContext(session_id=str(uuid.uuid4()))

        # 执行任务
        response = orchestrator.execute(
            task=task,
            context=context,
            preferred_agent=preferred_agent
        )

        if response.success:
            return success_response(
                data={
                    'answer': response.content,
                    'agent_name': response.agent_name,
                    'execution_time': response.execution_time,
                    'tool_calls': response.tool_calls,
                    'metadata': response.metadata,
                    'session_id': context.session_id
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
        if session_id:
            context = AgentContext(session_id=session_id)
        else:
            import uuid
            context = AgentContext(session_id=str(uuid.uuid4()))

        # 执行任务（指定智能体）
        response = orchestrator.execute(
            task=task,
            context=context,
            preferred_agent=agent_name
        )

        if response.success:
            return success_response(
                data={
                    'answer': response.content,
                    'agent_name': response.agent_name,
                    'execution_time': response.execution_time,
                    'tool_calls': response.tool_calls,
                    'metadata': response.metadata,
                    'session_id': context.session_id
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
        mode = data.get('mode', 'sequential')

        if not tasks:
            return error_response(message='任务列表不能为空', status_code=400)

        logger.info(f'多智能体协作，任务数: {len(tasks)}, 模式: {mode}')

        # 获取 Orchestrator
        orchestrator = _get_orchestrator()

        # 创建上下文
        if session_id:
            context = AgentContext(session_id=session_id)
        else:
            import uuid
            context = AgentContext(session_id=str(uuid.uuid4()))

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

        return success_response(
            data={
                'results': results_data,
                'session_id': context.session_id,
                'total_tasks': len(tasks)
            },
            message='协作任务执行完成'
        )

    except Exception as e:
        logger.error(f'协作任务执行失败: {e}', exc_info=True)
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
