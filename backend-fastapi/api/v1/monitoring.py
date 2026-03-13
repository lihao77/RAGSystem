# -*- coding: utf-8 -*-
"""
监控 API 路由。
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from schemas.common import ok

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_orchestrator():
    from dependencies import get_agent_runtime_service
    return get_agent_runtime_service().get_orchestrator()


def _get_store():
    from dependencies import get_agent_runtime_service
    return get_agent_runtime_service().get_conversation_store()


@router.get('/metrics')
async def get_metrics(agent_name: Optional[str] = Query(None)):
    """获取智能体性能指标。"""
    try:
        orchestrator = _get_orchestrator()
        metrics_collector = getattr(orchestrator, '_metrics_collector', None)
        if not metrics_collector:
            raise HTTPException(status_code=503, detail='指标收集器未初始化')

        if agent_name:
            metrics = await asyncio.to_thread(metrics_collector.get_agent_metrics, agent_name)
            if not metrics:
                raise HTTPException(status_code=404, detail=f'未找到智能体 {agent_name} 的指标')
            return ok(data=metrics.to_dict(), message='获取智能体指标成功')
        else:
            system_metrics = await asyncio.to_thread(metrics_collector.get_all_metrics)
            return ok(data=system_metrics.to_dict(), message='获取系统指标成功')

    except HTTPException:
        raise
    except Exception as e:
        logger.error('获取指标失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/metrics/reset')
async def reset_metrics(agent_name: Optional[str] = None):
    """重置性能指标。"""
    try:
        orchestrator = _get_orchestrator()
        metrics_collector = getattr(orchestrator, '_metrics_collector', None)
        if not metrics_collector:
            raise HTTPException(status_code=503, detail='指标收集器未初始化')

        await asyncio.to_thread(metrics_collector.reset_metrics, agent_name)
        return ok(message=f'已重置{"智能体 " + agent_name if agent_name else "所有"}指标')

    except HTTPException:
        raise
    except Exception as e:
        logger.error('重置指标失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/context-snapshot')
async def get_context_snapshot(session_id: Optional[str] = Query(None)):
    """获取当前默认入口智能体的上下文快照，用于调试和可视化。"""
    try:
        orchestrator = _get_orchestrator()
        entry_agent = orchestrator.resolve_default_entry_agent() if hasattr(orchestrator, 'resolve_default_entry_agent') else None
        if not entry_agent:
            raise HTTPException(status_code=503, detail='默认入口智能体未加载')

        def _get_snapshot():
            from agents.context.token_counter import TokenCounter

            system_prompt = entry_agent._build_system_prompt()
            agent_tools = []
            get_agent_tools = getattr(entry_agent, '_get_available_agent_tools', None)
            if callable(get_agent_tools):
                agent_tools = [
                    {'name': t['function']['name'], 'description': t['function']['description']}
                    for t in get_agent_tools()
                ]

            entry_tools = getattr(entry_agent, 'available_tools', []) or []
            direct_tools = []
            for t in entry_tools:
                if isinstance(t, dict) and t.get('function'):
                    func = t.get('function') or {}
                    direct_tools.append({
                        'name': func.get('name'),
                        'description': func.get('description'),
                    })

            entry_skills_raw = getattr(entry_agent, 'available_skills', []) or []
            skills = []
            for s in entry_skills_raw:
                if hasattr(s, 'to_dict'):
                    skills.append(s.to_dict())
                else:
                    skills.append({
                        'name': getattr(s, 'name', None),
                        'description': getattr(s, 'description', None),
                    })

            llm_cfg = entry_agent.get_llm_config()
            counter = TokenCounter(model_name=llm_cfg.get('model_name'))
            sp_tokens = counter.count_text(system_prompt)

            history = []
            history_tokens = 0
            if session_id:
                from dependencies import get_agent_runtime_service
                runtime_service = get_agent_runtime_service()
                context = runtime_service.build_context(session_id=session_id)
                messages = entry_agent.context_pipeline.inspect_messages(system_prompt, context)
                # 跳过第一条 system prompt（已单独统计）
                for msg in messages[1:]:
                    content = msg.get('content', '')
                    meta = msg.get('metadata') or {}
                    preview = content[:200] + ('...' if len(content) > 200 else '')
                    t = counter.count_text(content)
                    history_tokens += t
                    history.append({
                        'seq': msg.get('seq'),
                        'role': msg['role'],
                        'content_preview': preview,
                        'content_length': len(content),
                        'is_preview_truncated': len(content) > 200,
                        'can_load_full_content': bool(session_id and msg.get('seq') is not None),
                        'tokens': t,
                        'is_compression_summary': bool(meta.get('compression')),
                        'react_intermediate': meta.get('react_intermediate', False),
                        'msg_type': meta.get('msg_type'),
                        'round': meta.get('round'),
                    })

            max_tokens = entry_agent.context_pipeline.config.max_tokens
            total = sp_tokens + history_tokens

            cfg = entry_agent.context_pipeline.config
            config_info = {
                'agent_name': entry_agent.name,
                'display_name': getattr(entry_agent, 'display_name', entry_agent.name),
                'compression': {
                    'strategy': 'llm_summarize',
                    'trigger_ratio': cfg.compression_trigger_ratio,
                    'preserve_recent_turns': cfg.preserve_recent_turns,
                    'summarize_max_tokens': cfg.summarize_max_tokens,
                },
                'model': llm_cfg.get('model_name', ''),
            }
            if entry_agent.max_rounds is not None:
                config_info['max_rounds'] = entry_agent.max_rounds

            return {
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
            }

        data = await asyncio.to_thread(_get_snapshot)
        return ok(data=data, message='获取上下文快照成功')

    except HTTPException:
        raise
    except Exception as e:
        logger.error('获取上下文快照失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/context-snapshot/message-content')
async def get_context_snapshot_message_content(
    session_id: str = Query(..., min_length=1),
    seq: int = Query(..., ge=1),
):
    """按会话和序号获取上下文快照中某条消息的完整内容。"""
    try:
        store = _get_store()
        message = await asyncio.to_thread(store.get_message_by_seq, session_id, seq)
        if not message:
            raise HTTPException(status_code=404, detail='消息不存在')

        return ok(
            data={
                'id': message.get('id'),
                'seq': message.get('seq'),
                'role': message.get('role'),
                'content': message.get('content', ''),
                'content_length': len(message.get('content', '')),
            },
            message='获取消息完整内容成功'
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error('获取上下文消息完整内容失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/health')
async def health():
    """健康检查。"""
    try:
        orchestrator = _get_orchestrator()
        agents = await asyncio.to_thread(orchestrator.list_agents)
        return ok(
            data={'status': 'healthy', 'agents_count': len(agents)},
            message='智能体系统运行正常'
        )
    except Exception as e:
        logger.error('健康检查失败: %s', e)
        raise HTTPException(status_code=500, detail=str(e))
