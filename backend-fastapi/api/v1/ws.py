# -*- coding: utf-8 -*-
"""
Session 级 WebSocket 端点。

替代原有的 SSE push 通道和 /stream/reconnect，
提供单一持久连接承载所有实时事件。
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from agents.events.bus import Event, EventType
from agents.events.sse_adapter import event_to_client_dict, is_critical_event_type

logger = logging.getLogger(__name__)
router = APIRouter()


# ── 连接管理器 ──────────────────────────────────────────────

class SessionWSManager:
    """管理 session → WebSocket 连接映射（支持多 tab）。"""

    def __init__(self):
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)

    def add(self, session_id: str, ws: WebSocket):
        self._connections[session_id].add(ws)

    def remove(self, session_id: str, ws: WebSocket):
        conns = self._connections.get(session_id)
        if conns:
            conns.discard(ws)
            if not conns:
                del self._connections[session_id]

    def get_connections(self, session_id: str) -> set[WebSocket]:
        return self._connections.get(session_id, set())


_ws_manager = SessionWSManager()


# ── 事件格式化 / 发送 ───────────────────────────────────────

def _event_to_ws_payload(event: Event) -> dict:
    """将 Event 转为 WS 发送 payload（event_to_client_dict + observability 注入）。"""
    payload = event_to_client_dict(event)
    try:
        from execution.observability import apply_observability_fields
        apply_observability_fields(payload, event.data or {})
    except Exception:
        pass
    return payload


def _event_type_name(event_type) -> str:
    return event_type.value if hasattr(event_type, 'value') else str(event_type)


async def _send_json(ws: WebSocket, payload: dict, send_lock: asyncio.Lock):
    async with send_lock:
        await ws.send_json(payload)


def _enqueue_event(queue: asyncio.Queue, event: Event, session_id: str):
    """在事件循环线程内安全入队。"""
    critical = is_critical_event_type(event.type)
    event_type = _event_type_name(event.type)
    try:
        queue.put_nowait(event)
    except asyncio.QueueFull:
        if critical:
            _evict_non_critical(queue)
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning('[WS] 关键事件入队失败 session=%s type=%s', session_id, event_type)
        else:
            logger.debug('[WS] 非关键事件丢弃 session=%s type=%s', session_id, event_type)


def _clear_run_subscription(run_binding: dict):
    bus = run_binding.get('bus')
    subscription_id = run_binding.get('subscription_id')
    if bus is not None and subscription_id:
        try:
            bus.unsubscribe(subscription_id)
        except Exception:
            pass
    run_binding['run_id'] = None
    run_binding['bus'] = None
    run_binding['subscription_id'] = None


# ── WebSocket 端点 ──────────────────────────────────────────

@router.websocket('/sessions/{session_id}/ws')
async def session_websocket(ws: WebSocket, session_id: str):
    await ws.accept()
    _ws_manager.add(session_id, ws)
    logger.info('[WS] 连接建立 session=%s', session_id)

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    send_lock = asyncio.Lock()
    send_gate = asyncio.Event()  # replay 期间 clear() 暂停 send_loop
    send_gate.set()
    run_changed = asyncio.Event()  # SESSION_RUN_STARTED 时 set，唤醒 watcher
    global_bus = None
    global_sub_id: Optional[str] = None
    closed = threading.Event()
    run_binding = {'run_id': None, 'bus': None, 'subscription_id': None}

    try:
        from runtime.container import get_current_runtime_container
        container = get_current_runtime_container()
        if not container:
            await _send_json(ws, {'type': 'error', 'content': 'Runtime not ready'}, send_lock)
            await ws.close(code=1011)
            return

        def _on_event(event: Event):
            """EventBus handler（同步，在发布线程调用）。"""
            if closed.is_set():
                return
            try:
                loop.call_soon_threadsafe(_enqueue_event, queue, event, session_id)
                # SESSION_RUN_STARTED 时通知 watcher 立即检查
                if event.type == EventType.SESSION_RUN_STARTED:
                    loop.call_soon_threadsafe(run_changed.set)
            except RuntimeError:
                pass  # loop closed

        # 全局总线仅承接非 run 级事件（当前主要是 command.result / session.run_started）
        global_bus = container.get_event_bus()
        global_sub_id = global_bus.subscribe(
            event_types=[EventType.COMMAND_RESULT, EventType.SESSION_RUN_STARTED, EventType.SESSION_UPDATED],
            handler=_on_event,
            filter_func=lambda e: bool(e.session_id) and e.session_id == session_id,
        )

        # 连接建立后立即绑定当前活跃 run；后续由 watcher 动态切换
        await _sync_active_run_subscription(ws, session_id, container, queue, send_lock, run_binding, _on_event, send_gate)

        send_task = asyncio.create_task(_ws_send_loop(ws, queue, session_id, send_lock, send_gate))
        recv_task = asyncio.create_task(_ws_recv_loop(ws, session_id, send_lock))
        watch_task = asyncio.create_task(
            _watch_active_run(ws, session_id, container, queue, send_lock, run_binding, _on_event, send_gate, run_changed)
        )

        done, pending = await asyncio.wait(
            {send_task, recv_task, watch_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            try:
                await task
            except Exception:
                pass

    except WebSocketDisconnect:
        logger.info('[WS] 客户端断开 session=%s', session_id)
    except Exception as exc:
        logger.warning('[WS] 异常断开 session=%s: %s', session_id, exc)
    finally:
        closed.set()
        if global_bus is not None and global_sub_id:
            try:
                global_bus.unsubscribe(global_sub_id)
            except Exception:
                pass
        _clear_run_subscription(run_binding)
        _ws_manager.remove(session_id, ws)
        logger.info('[WS] 连接清理完成 session=%s', session_id)


# ── 发送循环 ──────────────────────────────────────────────

async def _ws_send_loop(ws: WebSocket, queue: asyncio.Queue, session_id: str, send_lock: asyncio.Lock, send_gate: asyncio.Event):
    """从 queue 取事件并发送到 WebSocket。replay 期间 send_gate 会暂停发送。"""
    last_heartbeat = time.time()
    heartbeat_interval = 20.0

    while True:
        # replay 期间等待 gate 放行
        await send_gate.wait()

        try:
            event = await asyncio.wait_for(queue.get(), timeout=1.0)
        except asyncio.TimeoutError:
            now = time.time()
            if now - last_heartbeat >= heartbeat_interval:
                try:
                    await _send_json(ws, {'type': 'heartbeat', 'timestamp': now}, send_lock)
                except Exception:
                    return
                last_heartbeat = now
            continue

        if event is None:  # 哨兵
            return

        try:
            payload = _event_to_ws_payload(event)
            await _send_json(ws, payload, send_lock)
            last_heartbeat = time.time()
        except Exception:
            return  # WS 已断开


# ── 接收循环 ──────────────────────────────────────────────

async def _ws_recv_loop(ws: WebSocket, session_id: str, send_lock: asyncio.Lock):
    """接收客户端消息（send / stop / approve / user_input）。"""
    while True:
        try:
            raw = await ws.receive_text()
        except WebSocketDisconnect:
            return
        except Exception:
            return

        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue

        msg_type = msg.get('type')
        if msg_type == 'send':
            await _handle_ws_send(ws, session_id, msg, send_lock)
        elif msg_type == 'stop':
            await _handle_ws_stop(session_id)
        elif msg_type == 'approve':
            await _handle_ws_approve(ws, session_id, msg, send_lock)
        elif msg_type == 'user_input':
            await _handle_ws_user_input(ws, session_id, msg, send_lock)


# ── 客户端消息处理 ────────────────────────────────────────

async def _handle_ws_stop(session_id: str):
    # 优先检查系统命令（如 /compact）
    from api.v1.stream import _active_system_commands
    sys_cancel = _active_system_commands.get(session_id)
    if sys_cancel is not None:
        sys_cancel.set()
        logger.info('[WS] 已中断系统命令 session=%s', session_id)
        return
    try:
        from dependencies import get_execution_service
        svc = get_execution_service()
        await asyncio.to_thread(svc.cancel_session, session_id, 'user_stop')
    except Exception as exc:
        logger.warning('[WS] stop 失败 session=%s: %s', session_id, exc)


async def _handle_ws_approve(ws: WebSocket, session_id: str, msg: dict, send_lock: asyncio.Lock):
    try:
        from dependencies import get_task_registry
        registry = get_task_registry()
        ok_result = await asyncio.to_thread(
            registry.resolve_approval,
            session_id,
            msg.get('approval_id', ''),
            msg.get('approved', False),
            msg.get('message', ''),
        )
        if not ok_result:
            await _send_json(ws, {
                'type': 'approve.error', 'approval_id': msg.get('approval_id', ''),
                'error': '未找到对应的审批请求，可能已超时或不存在',
            }, send_lock)
    except Exception as exc:
        logger.warning('[WS] approve 失败 session=%s: %s', session_id, exc)
        try:
            await _send_json(ws, {
                'type': 'approve.error', 'approval_id': msg.get('approval_id', ''),
                'error': str(exc),
            }, send_lock)
        except Exception:
            pass


async def _handle_ws_user_input(ws: WebSocket, session_id: str, msg: dict, send_lock: asyncio.Lock):
    try:
        from dependencies import get_task_registry
        registry = get_task_registry()
        ok_result = await asyncio.to_thread(
            registry.resolve_input,
            session_id,
            msg.get('input_id', ''),
            msg.get('value', ''),
        )
        if not ok_result:
            await _send_json(ws, {
                'type': 'user_input.error', 'input_id': msg.get('input_id', ''),
                'error': '未找到对应的输入请求，可能已被取消或不存在',
            }, send_lock)
    except Exception as exc:
        logger.warning('[WS] user_input 失败 session=%s: %s', session_id, exc)
        try:
            await _send_json(ws, {
                'type': 'user_input.error', 'input_id': msg.get('input_id', ''),
                'error': str(exc),
            }, send_lock)
        except Exception:
            pass


async def _handle_ws_send(ws: WebSocket, session_id: str, msg: dict, send_lock: asyncio.Lock):
    """处理前端通过 WS 发送的消息/命令。"""
    try:
        from api.v1.stream import execute_task, _build_attachment_records
        result = await execute_task(
            task=msg.get('task', ''),
            session_id=session_id,
            user_id=msg.get('user_id', ''),
            selected_llm=msg.get('selected_llm', ''),
            llm_tier=msg.get('llm_tier', ''),
            attachments=msg.get('attachments') or [],
            request_id=msg.get('request_id'),
        )
        await _send_json(ws, {'type': 'send.ack', **result}, send_lock)
    except Exception as exc:
        logger.warning('[WS] send 失败 session=%s: %s', session_id, exc)
        try:
            await _send_json(ws, {
                'type': 'send.error', 'session_id': session_id,
                'error': str(exc),
            }, send_lock)
        except Exception:
            pass


# ── 动态 run 订阅 / 回放 ───────────────────────────────────

async def _watch_active_run(
    ws: WebSocket,
    session_id: str,
    container,
    queue: asyncio.Queue,
    send_lock: asyncio.Lock,
    run_binding: dict,
    on_event,
    send_gate: asyncio.Event,
    run_changed: asyncio.Event,
):
    """等待 run 变更事件或 30s 兜底轮询，动态切换到正确的 run 事件总线。"""
    while True:
        try:
            await _sync_active_run_subscription(ws, session_id, container, queue, send_lock, run_binding, on_event, send_gate)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug('[WS] 检查活跃 run 失败 session=%s: %s', session_id, exc)
        # 等待事件驱动唤醒或 30s 兜底
        run_changed.clear()
        try:
            await asyncio.wait_for(run_changed.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            pass


async def _get_running_status(container, session_id: str) -> Optional[dict]:
    try:
        execution_service = container.get_execution_service()
        status = await asyncio.to_thread(execution_service.get_status_by_session, session_id)
    except Exception:
        return None
    if not status or status.get('status') != 'running':
        return None
    return status


async def _sync_active_run_subscription(
    ws: WebSocket,
    session_id: str,
    container,
    queue: asyncio.Queue,
    send_lock: asyncio.Lock,
    run_binding: dict,
    on_event,
    send_gate: asyncio.Event,
):
    """确保当前 WS 已订阅 session 的活跃 run 总线，并在 run 切换时自动回放。"""
    status = await _get_running_status(container, session_id)
    if not status:
        # run 已结束但 WS 仍持有旧订阅 → 清理并通知前端
        if run_binding.get('run_id'):
            finished_run_id = run_binding['run_id']
            _clear_run_subscription(run_binding)
            try:
                await _send_json(ws, {
                    'type': 'run.end',
                    'session_id': session_id,
                    'run_id': finished_run_id,
                    'synthetic': True,
                }, send_lock)
            except Exception:
                pass
        return

    run_id = status.get('run_id')
    if not run_id or run_id == run_binding.get('run_id'):
        return

    _clear_run_subscription(run_binding)

    runtime_svc = container.get_agent_api_runtime_service()
    run_bus = runtime_svc.get_run_event_bus(run_id, session_id=session_id)
    run_sub_id = run_bus.subscribe_all(
        handler=on_event,
        filter_func=lambda e: bool(e.session_id) and e.session_id == session_id,
    )
    run_binding['run_id'] = run_id
    run_binding['bus'] = run_bus
    run_binding['subscription_id'] = run_sub_id

    await _replay_run(
        ws,
        session_id,
        run_id,
        status.get('started_at') or 0,
        container,
        queue,
        send_lock,
        send_gate,
    )


async def _replay_run(
    ws: WebSocket,
    session_id: str,
    run_id: str,
    run_started_at: float,
    container,
    queue: asyncio.Queue,
    send_lock: asyncio.Lock,
    send_gate: asyncio.Event,
):
    """对指定 run 做一次回放，并与实时队列去重。replay 期间 send_gate 暂停 send_loop。"""
    logger.info('[WS] 绑定活跃 run session=%s run_id=%s，开始回放', session_id, run_id)

    # 暂停 send_loop，防止回放期间实时事件穿插导致乱序
    send_gate.clear()

    try:
        runtime_svc = container.get_agent_api_runtime_service()
        event_bus = runtime_svc.get_run_event_bus(run_id, session_id=session_id)
        all_history = await asyncio.to_thread(
            event_bus.get_event_history, session_id=session_id, limit=1000,
        )
        history = [e for e in all_history if getattr(e, 'timestamp', 0) >= run_started_at]

        from dependencies import get_task_registry
        registry = get_task_registry()

        await _send_json(ws, {
            'type': 'reconnect_start',
            'session_id': session_id,
            'run_id': run_id,
            'replay_count': len(history),
        }, send_lock)

        replay_max_seq = 0
        for event in history:
            if event.type == EventType.USER_APPROVAL_REQUIRED:
                approval_id = (event.data or {}).get('approval_id', '')
                if approval_id and not registry.is_approval_pending(session_id, approval_id):
                    continue
            if event.type == EventType.USER_INPUT_REQUIRED:
                input_id = (event.data or {}).get('input_id', '')
                if input_id and not registry.is_input_pending(session_id, input_id):
                    continue

            payload = _event_to_ws_payload(event)
            await _send_json(ws, payload, send_lock)
            seq = getattr(event, 'sequence_number', 0)
            if seq > replay_max_seq:
                replay_max_seq = seq

        await _send_json(ws, {'type': 'reconnect_end', 'session_id': session_id}, send_lock)
        _drain_stale_events(queue, replay_max_seq)

    except Exception as exc:
        logger.warning('[WS] 回放失败 session=%s run_id=%s: %s', session_id, run_id, exc)
    finally:
        # 恢复 send_loop
        send_gate.set()


def _drain_stale_events(queue: asyncio.Queue, max_seq: int):
    """移除 queue 中 seq <= max_seq 的 run 事件（保留 command.result 等全局事件）。"""
    kept = []
    while not queue.empty():
        try:
            event = queue.get_nowait()
        except asyncio.QueueEmpty:
            break

        if event is None:
            kept.append(event)
            continue

        event_type = _event_type_name(getattr(event, 'type', ''))
        if event_type == EventType.COMMAND_RESULT.value:
            kept.append(event)
            continue

        if getattr(event, 'sequence_number', 0) > max_seq:
            kept.append(event)

    for event in kept:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            break


def _evict_non_critical(queue: asyncio.Queue):
    """从 queue 头部扫描最多 10 个元素，驱逐第一个非关键事件腾出空间。"""
    scanned = []
    evicted = False
    scan_limit = min(10, queue.qsize())
    for _ in range(scan_limit):
        try:
            item = queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        if not evicted and item is not None and not is_critical_event_type(item.type):
            evicted = True
            continue
        scanned.append(item)
    # 放回未驱逐的元素
    for item in scanned:
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            break
