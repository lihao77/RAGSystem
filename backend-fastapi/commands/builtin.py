# -*- coding: utf-8 -*-
"""
内建斜杠命令定义。
"""

import asyncio
import logging

from . import register, CommandDefinition, get_all

logger = logging.getLogger(__name__)


# ── system 命令 ──────────────────────────────────────────────────────────────

async def handle_help(session_id: str, args: str, **kw) -> dict:
    lines = ['可用命令：', '']
    for cmd in get_all():
        tag = '[提示词]' if cmd.mode == 'prompt' else '[系统]'
        lines.append(f'  {cmd.name.ljust(14)} {tag} {cmd.description}')
    lines.append('')
    lines.append('提示词命令后跟内容，如: /review 当前仓库代码')
    return {'command': 'help', 'success': True, 'content': '\n'.join(lines)}


async def handle_compact(session_id: str, args: str, **kw) -> dict:
    """强制压缩上下文。"""
    from dependencies import get_agent_runtime_service
    runtime_service = get_agent_runtime_service()

    task_registry = runtime_service.get_task_registry()
    task_status = task_registry.get_status(session_id)
    if task_status and task_status.get('status') in ('running', 'pending'):
        return {'command': 'compact', 'success': False, 'content': '该会话正在执行任务，请等待完成后再压缩'}

    try:
        result = await asyncio.to_thread(runtime_service.compact_session, session_id)
    except Exception as e:
        logger.error('压缩失败: %s', e, exc_info=True)
        return {'command': 'compact', 'success': False, 'content': f'压缩失败: {e}'}

    if result['status'] == 'skipped':
        return {'command': 'compact', 'success': True, 'content': '无需压缩（历史为空或消息不足）', 'data': result}

    return {
        'command': 'compact', 'success': True, 'data': result,
        'content': f"压缩完成：{result['before']} → {result['after']} 条消息，节省 {result['tokens_saved']} tokens",
    }


# ── 注册 ─────────────────────────────────────────────────────────────────────

register(CommandDefinition(name='/help', mode='system', description='显示可用命令列表', handler=handle_help))
register(CommandDefinition(name='/compact', mode='system', description='强制压缩上下文', handler=handle_compact))

register(CommandDefinition(name='/review', mode='prompt', description='代码审查',
    template='请对以下内容进行全面的代码审查，包括代码质量、安全性和性能优化建议：{args}'))
register(CommandDefinition(name='/analyze', mode='prompt', description='深度分析',
    template='请深入分析以下问题，给出详细的技术分析和建议：{args}'))
register(CommandDefinition(name='/explain', mode='prompt', description='详细解释',
    template='请详细解释以下概念或代码，用通俗易懂的方式：{args}'))
