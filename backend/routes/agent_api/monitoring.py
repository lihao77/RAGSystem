# -*- coding: utf-8 -*-
"""
Agent 指标、快照与健康检查路由。
"""

from .shared import (
    agent_bp,
    error_response,
    logger,
    request,
    success_response,
    _get_conversation_store,
    _get_orchestrator,
)

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

        # master 直接工具（包含普通工具与 Skills 系统工具）
        master_tools = getattr(master, 'available_tools', []) or []
        direct_tools = []
        for t in master_tools:
            if isinstance(t, dict) and t.get('function'):
                func = t.get('function') or {}
                direct_tools.append({
                    'name': func.get('name'),
                    'description': func.get('description'),
                })

        # master Skills 概览
        master_skills_raw = getattr(master, 'available_skills', []) or []
        skills = []
        for s in master_skills_raw:
            if hasattr(s, 'to_dict'):
                skills.append(s.to_dict())
            else:
                skills.append({
                    'name': getattr(s, 'name', None),
                    'description': getattr(s, 'description', None),
                })

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
                    preview = content[:200] + ('...' if len(content) > 200 else '')
                    t = counter.count_text(content)
                    history_tokens += t
                    meta = msg.get('metadata') or {}
                    history.append({
                        'id': msg.get('id'),
                        'role': msg['role'],
                        'content_preview': preview,
                        'content_length': len(content),
                        'is_preview_truncated': len(content) > 200,
                        'can_load_full_content': bool(session_id and msg.get('seq') is not None),
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
            'available_tools': direct_tools,
            'available_skills': skills,
        }, message='获取上下文快照成功')

    except Exception as e:
        logger.error(f'获取上下文快照失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/context-snapshot/message-content', methods=['GET'])
def get_context_snapshot_message_content():
    """按会话和序号获取上下文快照中某条消息的完整内容"""
    try:
        session_id = request.args.get('session_id')
        seq = request.args.get('seq')
        if not session_id:
            return error_response(message='缺少 session_id', status_code=400)
        if seq is None:
            return error_response(message='缺少 seq', status_code=400)

        try:
            seq = int(seq)
        except (TypeError, ValueError):
            return error_response(message='seq 须为整数', status_code=400)

        if seq < 1:
            return error_response(message='seq 须大于 0', status_code=400)

        message = _get_conversation_store().get_message_by_seq(session_id=session_id, seq=seq)
        if not message:
            return error_response(message='消息不存在', status_code=404)

        content = message.get('content', '')
        return success_response(
            data={
                'id': message.get('id'),
                'seq': message.get('seq'),
                'role': message.get('role'),
                'content': content,
                'content_length': len(content),
            },
            message='获取消息完整内容成功'
        )
    except Exception as e:
        logger.error(f'获取上下文消息完整内容失败: {e}', exc_info=True)
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
