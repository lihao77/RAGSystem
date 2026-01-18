# -*- coding: utf-8 -*-
"""
Agent API 路由 - 智能体系统统一入口

提供智能体系统的 API 接口
"""

from flask import Blueprint, request, Response, stream_with_context
import logging
import json
from agents import (
    AgentContext,
    get_orchestrator,
    get_config_manager,
    load_agents_from_config
)
from llm_adapter import get_default_adapter
from config import get_config
from utils.response_helpers import success_response, error_response

logger = logging.getLogger(__name__)

agent_bp = Blueprint('agent', __name__)


# 全局 Orchestrator（延迟初始化）
_orchestrator = None


def _get_orchestrator():
    """获取或初始化全局 Orchestrator（使用动态加载）"""
    global _orchestrator

    if _orchestrator is None:
        try:
            system_config = get_config()
            adapter = get_default_adapter()

            # 创建 Orchestrator
            _orchestrator = get_orchestrator(llm_adapter=adapter)

            # 🎉 使用动态加载机制加载所有智能体
            agents = load_agents_from_config(
                llm_adapter=adapter,
                system_config=system_config,
                orchestrator=_orchestrator,
                use_v2=False
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
                llm_adapter=get_default_adapter(),
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


@agent_bp.route('/stream', methods=['POST'])
def stream_execute():
    """
    流式执行智能体任务（Server-Sent Events）

    Request:
        {
            "task": "任务描述",
            "session_id": "会话ID（可选）"
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

    if not task:
        return error_response(message='任务描述不能为空', status_code=400)

    logger.info(f'流式执行任务: {task}')

    def generate():
        try:
            # 获取 Orchestrator
            orchestrator = _get_orchestrator()

            # 创建上下文
            if session_id:
                context = AgentContext(session_id=session_id)
            else:
                import uuid
                context = AgentContext(session_id=str(uuid.uuid4()))

            # 获取 MasterAgent
            master_agent = orchestrator.agents.get('master_agent')
            if not master_agent:
                yield f"data: {json.dumps({'type': 'error', 'content': 'MasterAgent 未找到'}, ensure_ascii=False)}\n\n"
                return

            # 调用 MasterAgent 的 stream_execute
            for event in master_agent.stream_execute(task, context):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

            # 结束事件
            yield f"data: {json.dumps({'type': 'done', 'session_id': context.session_id}, ensure_ascii=False)}\n\n"

        except Exception as e:
            logger.error(f"流式执行异常: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)}, ensure_ascii=False)}\n\n"

    response = Response(stream_with_context(generate()), mimetype='text/event-stream')
    response.headers['Content-Type'] = 'text/event-stream; charset=utf-8'
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
