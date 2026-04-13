# -*- coding: utf-8 -*-
"""
守护 Agent 系统 API 端点。
"""

from fastapi import APIRouter, HTTPException, Request
from typing import Any, Dict, List, Optional

from daemon.models import (
    CronTask,
    DaemonSystemConfig,
    OutgoingMessage,
    PlatformType,
)
from daemon.utils import model_dump, model_validate

router = APIRouter()


def _get_service(request: Request):
    container = getattr(request.app.state, 'runtime_container', None)
    if not container:
        raise HTTPException(500, 'RuntimeContainer 未初始化')
    return container.get_daemon_service()


# ── 系统状态 ──────────────────────────────────────────

@router.get('/status')
def get_status(request: Request) -> Dict[str, Any]:
    """守护系统整体状态。"""
    svc = _get_service(request)
    return svc.get_status()


@router.get('/config')
def get_config(request: Request) -> Dict[str, Any]:
    """获取守护系统配置。"""
    svc = _get_service(request)
    cfg = svc.config
    return model_dump(cfg, mode='json')


@router.put('/config')
async def update_config(request: Request) -> Dict[str, Any]:
    """更新守护系统配置（保存到文件并热更新内存）。"""
    svc = _get_service(request)
    body = await request.json()
    try:
        new_config = model_validate(DaemonSystemConfig, body)
    except Exception as e:
        raise HTTPException(400, f'配置格式错误: {e}')

    was_running = svc.running
    if was_running:
        await svc.stop()
    try:
        svc.save_config(new_config)
        if was_running and new_config.enabled:
            await svc.start()
    except ValueError as e:
        raise HTTPException(400, str(e))

    return {
        'status': 'ok',
        'message': '配置已保存' + ('，并已自动重载守护系统' if was_running else '，启动守护系统后生效')
    }


@router.post('/start')
async def start_daemon(request: Request) -> Dict[str, Any]:
    """启动守护系统。"""
    svc = _get_service(request)
    await svc.start()
    return {'status': 'ok', 'message': '守护系统已启动'}


@router.post('/stop')
async def stop_daemon(request: Request) -> Dict[str, Any]:
    """停止守护系统。"""
    svc = _get_service(request)
    await svc.stop()
    return {'status': 'ok', 'message': '守护系统已停止'}


# ── Agent 管理 ────────────────────────────────────────

@router.get('/agents')
def list_agents(request: Request) -> List[Dict[str, Any]]:
    """列出所有守护机器人（team）状态。"""
    svc = _get_service(request)
    cfg = svc.config
    result = []
    for agent_cfg in cfg.agents:
        status = svc.get_agent_status(agent_cfg.team_name)
        if status:
            result.append(status)
    return result


@router.get('/agents/{team_name}/status')
def get_agent_status(team_name: str, request: Request) -> Dict[str, Any]:
    """单个守护机器人（team）详细状态。"""
    svc = _get_service(request)
    status = svc.get_agent_status(team_name)
    if not status:
        raise HTTPException(404, f'守护机器人不存在: {team_name}')
    return status


@router.get('/agents/{team_name}/heartbeat')
def get_agent_heartbeat(team_name: str, request: Request, limit: int = 20) -> Dict[str, Any]:
    """心跳历史。"""
    svc = _get_service(request)
    agent_cfg = None
    for ac in svc.config.agents:
        if ac.team_name == team_name:
            agent_cfg = ac
            break
    if not agent_cfg:
        raise HTTPException(404, f'守护机器人不存在: {team_name}')

    result = {}
    for platform in agent_cfg.platforms:
        result[platform.value] = svc.get_heartbeat_history(platform, limit=limit)
    return {'team_name': team_name, 'heartbeats': result}


@router.post('/agents/{team_name}/test')
async def test_agent(team_name: str, request: Request) -> Dict[str, Any]:
    """手动触发测试消息。"""
    svc = _get_service(request)
    body = await request.json()
    content = body.get('content', '测试消息')
    platform_str = body.get('platform', 'feishu')
    try:
        platform = PlatformType(platform_str)
    except ValueError:
        raise HTTPException(400, f'不支持的平台: {platform_str}')

    from daemon.models import IncomingMessage
    import time
    msg = IncomingMessage(
        message_id=f"test_{int(time.time())}",
        platform=platform,
        chat_id=body.get('chat_id', 'test_user'),
        user_id='test_user',
        content=content,
        timestamp=time.time(),
    )
    await svc.handle_incoming_message(msg)
    return {'status': 'ok', 'message': '测试消息已发送'}


# ── Webhook 入口 ─────────────────────────────────────

@router.post('/webhook/{platform}')
async def webhook_entry(platform: str, request: Request) -> Dict[str, Any]:
    """统一 Webhook 入口（供社交平台回调）。"""
    import json as _json
    svc = _get_service(request)
    try:
        p = PlatformType(platform)
    except ValueError:
        raise HTTPException(400, f'不支持的平台: {platform}')

    raw_body = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}
    try:
        body = _json.loads(raw_body)
    except Exception:
        raise HTTPException(400, '请求体非合法 JSON')

    # 查找对应适配器
    adapter = svc.get_adapter(p)

    # 飞书 URL challenge 验证：先验签（若适配器已就绪），再响应 challenge
    if p == PlatformType.FEISHU and 'challenge' in body:
        if adapter and not adapter.verify_webhook_signature(headers, raw_body):
            raise HTTPException(403, '签名验证失败')
        return {'challenge': body['challenge']}

    if not adapter:
        raise HTTPException(503, f'平台适配器未连接: {platform}')

    # 签名验证
    if not adapter.verify_webhook_signature(headers, raw_body):
        raise HTTPException(403, '签名验证失败')

    # 解析消息
    messages = adapter.parse_webhook(body)
    for msg in messages:
        await svc.handle_incoming_message(msg)

    return {'status': 'ok', 'processed': len(messages)}


# ── 主动推送 ──────────────────────────────────────────

@router.post('/send')
async def send_message(request: Request) -> Dict[str, Any]:
    """主动推送消息到社交平台。"""
    svc = _get_service(request)
    body = await request.json()

    try:
        msg = OutgoingMessage(
            platform=PlatformType(body['platform']),
            chat_id=body['chat_id'],
            content=body['content'],
            message_type=body.get('message_type', 'text'),
        )
    except (KeyError, ValueError) as e:
        raise HTTPException(400, f'请求参数错误: {e}')

    success = await svc.send_message(msg)
    return {'status': 'ok' if success else 'failed'}


# ── Cron 任务管理 ─────────────────────────────────────

@router.get('/cron/tasks')
def list_cron_tasks(request: Request) -> List[Dict[str, Any]]:
    """列出所有 Cron 任务。"""
    svc = _get_service(request)
    tasks = svc.get_cron_tasks()
    return [
        {
            'task_id': t.task_id,
            'name': t.name,
            'cron': t.cron,
            'task': t.task,
            'team_name': t.team_name,
            'entry_agent': t.entry_agent,
            'enabled': t.enabled,
            'push_platform': t.push_platform.value if t.push_platform else None,
            'push_chat_id': t.push_chat_id,
            'last_run': t.last_run,
            'last_result': t.last_result,
        }
        for t in tasks
    ]


@router.post('/cron/tasks')
async def create_cron_task(request: Request) -> Dict[str, Any]:
    """新增 Cron 任务。"""
    svc = _get_service(request)
    body = await request.json()

    try:
        task = CronTask(**body)
        await svc.add_cron_task(task)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f'任务参数错误: {e}')

    return {'status': 'ok', 'task_id': task.task_id}


@router.put('/cron/tasks/{task_id}')
async def update_cron_task(task_id: str, request: Request) -> Dict[str, Any]:
    """更新 Cron 任务。"""
    svc = _get_service(request)
    body = await request.json()
    try:
        updated = await svc.update_cron_task(task_id, body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not updated:
        raise HTTPException(404, f'任务不存在: {task_id}')
    return {'status': 'ok', 'task_id': task_id}


@router.delete('/cron/tasks/{task_id}')
async def delete_cron_task(task_id: str, request: Request) -> Dict[str, Any]:
    """删除 Cron 任务。"""
    svc = _get_service(request)
    deleted = await svc.delete_cron_task(task_id)
    if not deleted:
        raise HTTPException(404, f'任务不存在: {task_id}')
    return {'status': 'ok'}


@router.post('/cron/tasks/{task_id}/trigger')
async def trigger_cron_task(task_id: str, request: Request) -> Dict[str, Any]:
    """手动触发 Cron 任务。"""
    svc = _get_service(request)
    result = await svc.trigger_cron_task(task_id)
    if result is None:
        raise HTTPException(404, f'任务不存在或执行失败: {task_id}')
    return {'status': 'ok', 'result': result[:500] if result else None}


@router.get('/cron/tasks/{task_id}/history')
def get_cron_task_history(task_id: str, request: Request, limit: int = 20) -> Dict[str, Any]:
    """Cron 任务执行历史。"""
    svc = _get_service(request)
    return {'task_id': task_id, 'history': svc.get_cron_history(task_id, limit=limit)}
