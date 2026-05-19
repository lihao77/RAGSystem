# -*- coding: utf-8 -*-
"""
Session 级 WebSocket 端点。

替代旧的分散式 push / reconnect 通道，
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
from agents.events.client_events import event_to_client_dict, is_critical_event_type

logger = logging.getLogger(__name__)
router = APIRouter()
_PAUSE_SEND_LOOP = object()


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


class WsConnectionState:
    """Per-WebSocket connection state: send serialization, replay gating, delivery sequencing."""

    __slots__ = ('send_lock', 'send_gate', '_seq')

    def __init__(self):
        self.send_lock = asyncio.Lock()
        self.send_gate = asyncio.Event()  # replay 期间 clear() 暂停 send_loop
        self.send_gate.set()
        self._seq: int = 0

    @property
    def last_stream_seq(self) -> int:
        return self._seq

    def stamp(self, payload: dict) -> dict:
        """Attach a per-connection delivery sequence number.

        Event.seq is process-global and may legitimately jump within one session.
        stream_seq is only for client-side delivery continuity on this socket.
        """
        self._seq += 1
        return {**payload, 'stream_seq': self._seq}

    async def send_json(self, ws: WebSocket, payload: dict):
        async with self.send_lock:
            await ws.send_json(self.stamp(payload))


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


def _enqueue_pause_sentinel(queue: asyncio.Queue):
    """唤醒可能已阻塞在 queue.get() 的 send_loop，让它重新检查 send_gate。"""
    try:
        queue.put_nowait(_PAUSE_SEND_LOOP)
    except asyncio.QueueFull:
        _evict_non_critical(queue)
        try:
            queue.put_nowait(_PAUSE_SEND_LOOP)
        except asyncio.QueueFull:
            pass


def _requeue_paused_event(queue: asyncio.Queue, event: Event, session_id: str):
    try:
        queue.put_nowait(event)
    except asyncio.QueueFull:
        if is_critical_event_type(event.type):
            _evict_non_critical(queue)
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning('[WS] replay 暂停期间关键事件回队失败 session=%s type=%s', session_id, _event_type_name(event.type))
        else:
            logger.debug('[WS] replay 暂停期间非关键事件丢弃 session=%s type=%s', session_id, _event_type_name(event.type))


async def _pause_realtime_send_loop(queue: asyncio.Queue, conn: WsConnectionState):
    """原子暂停实时发送，并唤醒 send_loop 避免它继续卡在 queue.get()。"""
    async with conn.send_lock:
        was_open = conn.send_gate.is_set()
        conn.send_gate.clear()
        if was_open:
            _enqueue_pause_sentinel(queue)


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
    conn = WsConnectionState()
    run_changed = asyncio.Event()  # SESSION_RUN_STARTED 时 set，唤醒 watcher
    global_bus = None
    global_sub_id: Optional[str] = None
    closed = threading.Event()
    run_binding = {'run_id': None, 'bus': None, 'subscription_id': None}
    child_tasks: set[asyncio.Task] = set()

    try:
        from runtime.container import get_current_runtime_container
        container = get_current_runtime_container()
        if not container:
            await conn.send_json(ws, {'type': 'error', 'content': 'Runtime not ready'})
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
            event_types=[
                EventType.COMMAND_RESULT,
                EventType.SESSION_RUN_STARTED,
                EventType.SESSION_UPDATED,
                EventType.USER_APPROVAL_GRANTED,
                EventType.USER_APPROVAL_DENIED,
            ],
            handler=_on_event,
            filter_func=lambda e: bool(e.session_id) and e.session_id == session_id,
        )

        # 连接建立后立即绑定当前活跃 run；后续由 watcher 动态切换
        await _sync_active_run_subscription(ws, session_id, container, queue, conn, run_binding, _on_event)

        send_task = asyncio.create_task(_ws_send_loop(ws, queue, session_id, conn))
        recv_task = asyncio.create_task(_ws_recv_loop(ws, session_id, conn))
        watch_task = asyncio.create_task(
            _watch_active_run(ws, session_id, container, queue, conn, run_binding, _on_event, run_changed)
        )
        child_tasks = {send_task, recv_task, watch_task}

        done, pending = await asyncio.wait(
            child_tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        child_tasks.clear()

    except WebSocketDisconnect:
        logger.info('[WS] 客户端断开 session=%s', session_id)
    except asyncio.CancelledError:
        logger.info('[WS] 连接取消 session=%s', session_id)
    except Exception as exc:
        logger.warning('[WS] 异常断开 session=%s: %s', session_id, exc)
    finally:
        closed.set()
        for task in child_tasks:
            if not task.done():
                task.cancel()
        if child_tasks:
            await asyncio.gather(*child_tasks, return_exceptions=True)
        if global_bus is not None and global_sub_id:
            try:
                global_bus.unsubscribe(global_sub_id)
            except Exception:
                pass
        _clear_run_subscription(run_binding)
        _ws_manager.remove(session_id, ws)
        logger.info('[WS] 连接清理完成 session=%s', session_id)


# ── 发送循环 ──────────────────────────────────────────────

async def _ws_send_loop(ws: WebSocket, queue: asyncio.Queue, session_id: str, conn: WsConnectionState):
    """从 queue 取事件并发送到 WebSocket。replay 期间 send_gate 会暂停发送。"""
    last_heartbeat = time.time()
    heartbeat_interval = 20.0

    while True:
        # replay 期间等待 gate 放行
        await conn.send_gate.wait()

        try:
            event = await asyncio.wait_for(queue.get(), timeout=1.0)
        except asyncio.TimeoutError:
            now = time.time()
            if now - last_heartbeat >= heartbeat_interval:
                try:
                    # heartbeat 不递增 stream_seq —— 它不是业务事件，
                    # 只携带 last_stream_seq 供客户端参考当前投递进度。
                    async with conn.send_lock:
                        if not conn.send_gate.is_set():
                            continue
                        await ws.send_json({'type': 'heartbeat', 'timestamp': now, 'last_stream_seq': conn.last_stream_seq})
                except Exception:
                    return
                last_heartbeat = now
            continue

        if event is _PAUSE_SEND_LOOP:
            continue
        if event is None:  # 哨兵
            return

        if not conn.send_gate.is_set():
            _requeue_paused_event(queue, event, session_id)
            continue

        try:
            payload = _event_to_ws_payload(event)
            async with conn.send_lock:
                if not conn.send_gate.is_set():
                    _requeue_paused_event(queue, event, session_id)
                    continue
                await ws.send_json(conn.stamp(payload))
            last_heartbeat = time.time()
        except Exception:
            return  # WS 已断开


# ── 接收循环 ──────────────────────────────────────────────

async def _ws_recv_loop(ws: WebSocket, session_id: str, conn: WsConnectionState):
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
            await _handle_ws_send(ws, session_id, msg, conn)
        elif msg_type == 'stop':
            await _handle_ws_stop(session_id)
        elif msg_type == 'approve':
            await _handle_ws_approve(ws, session_id, msg, conn)
        elif msg_type == 'user_input':
            await _handle_ws_user_input(ws, session_id, msg, conn)


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
        from runtime.container import get_current_runtime_container
        container = get_current_runtime_container()
        if container is not None:
            svc = container.get_execution_service()
        else:
            from dependencies import get_execution_service
            svc = get_execution_service()
        await asyncio.to_thread(svc.cancel_session, session_id, reason='user_stop')
    except Exception as exc:
        logger.warning('[WS] stop 失败 session=%s: %s', session_id, exc)


async def _handle_ws_approve(ws: WebSocket, session_id: str, msg: dict, conn: WsConnectionState):
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
            await conn.send_json(ws, {
                'type': 'approve.error', 'approval_id': msg.get('approval_id', ''),
                'error': '未找到对应的审批请求，可能已超时或不存在',
            })
            return

        from runtime.container import get_current_runtime_container
        container = get_current_runtime_container()
        if container:
            event_type = EventType.USER_APPROVAL_GRANTED if msg.get('approved', False) else EventType.USER_APPROVAL_DENIED
            container.get_event_bus().publish(Event(
                type=event_type,
                data={
                    'approval_id': msg.get('approval_id', ''),
                    'approved': bool(msg.get('approved', False)),
                    'message': msg.get('message', ''),
                },
                session_id=session_id,
            ))
    except Exception as exc:
        logger.warning('[WS] approve 失败 session=%s: %s', session_id, exc)
        try:
            await conn.send_json(ws, {
                'type': 'approve.error', 'approval_id': msg.get('approval_id', ''),
                'error': str(exc),
            })
        except Exception:
            pass


async def _handle_ws_user_input(ws: WebSocket, session_id: str, msg: dict, conn: WsConnectionState):
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
            await conn.send_json(ws, {
                'type': 'user_input.error', 'input_id': msg.get('input_id', ''),
                'error': '未找到对应的输入请求，可能已被取消或不存在',
            })
    except Exception as exc:
        logger.warning('[WS] user_input 失败 session=%s: %s', session_id, exc)
        try:
            await conn.send_json(ws, {
                'type': 'user_input.error', 'input_id': msg.get('input_id', ''),
                'error': str(exc),
            })
        except Exception:
            pass


async def _handle_ws_send(ws: WebSocket, session_id: str, msg: dict, conn: WsConnectionState):
    """处理前端通过 WS 发送的消息/命令。"""
    try:
        from api.v1.stream import execute_task
        result = await execute_task(
            task=msg.get('task', ''),
            session_id=session_id,
            user_id=msg.get('user_id', ''),
            selected_llm=msg.get('selected_llm', ''),
            attachments=msg.get('attachments') or [],
            request_id=msg.get('request_id'),
        )
        await conn.send_json(ws, {'type': 'send.ack', **result})
    except Exception as exc:
        logger.warning('[WS] send 失败 session=%s: %s', session_id, exc)
        try:
            await conn.send_json(ws, {
                'type': 'send.error', 'session_id': session_id,
                'error': str(exc),
            })
        except Exception:
            pass


# ── 动态 run 订阅 / 回放 ───────────────────────────────────

async def _watch_active_run(
    ws: WebSocket,
    session_id: str,
    container,
    queue: asyncio.Queue,
    conn: WsConnectionState,
    run_binding: dict,
    on_event,
    run_changed: asyncio.Event,
):
    """等待 run 变更事件或 30s 兜底轮询，动态切换到正确的 run 事件总线。"""
    while True:
        # 先 clear 再 sync，防止 sync 期间触发的事件被清掉
        run_changed.clear()
        try:
            await _sync_active_run_subscription(ws, session_id, container, queue, conn, run_binding, on_event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug('[WS] 检查活跃 run 失败 session=%s: %s', session_id, exc)
        # 等待事件驱动唤醒或 30s 兜底
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
    conn: WsConnectionState,
    run_binding: dict,
    on_event,
):
    """确保当前 WS 已订阅 session 的活跃 run 总线，并在 run 切换时自动回放。"""
    status = await _get_running_status(container, session_id)
    if not status:
        # run 已结束但 WS 仍持有旧订阅 → 清理并通知前端
        if run_binding.get('run_id'):
            finished_run_id = run_binding['run_id']
            _clear_run_subscription(run_binding)
            try:
                await conn.send_json(ws, {
                    'type': 'run.end',
                    'session_id': session_id,
                    'run_id': finished_run_id,
                    'synthetic': True,
                })
            except Exception:
                pass
        return

    run_id = status.get('run_id')
    if not run_id or run_id == run_binding.get('run_id'):
        return

    _clear_run_subscription(run_binding)
    await _pause_realtime_send_loop(queue, conn)
    try:
        runtime_svc = container.get_agent_api_runtime_service()
        run_bus = runtime_svc.get_run_event_bus(run_id, session_id=session_id)
        run_sub_id = run_bus.subscribe_all(
            handler=on_event,
            filter_func=lambda e: bool(e.session_id) and e.session_id == session_id,
        )
        run_binding['run_id'] = run_id
        run_binding['bus'] = run_bus
        run_binding['subscription_id'] = run_sub_id

        await _replay_run(ws, session_id, run_id, status.get('started_at') or 0, container, queue, conn)
    except asyncio.CancelledError:
        conn.send_gate.set()
        raise
    except Exception:
        conn.send_gate.set()
        raise


async def _replay_run(
    ws: WebSocket,
    session_id: str,
    run_id: str,
    run_started_at: float,
    container,
    queue: asyncio.Queue,
    conn: WsConnectionState,
):
    """对指定 run 做一次回放，并与实时队列去重。replay 期间 send_gate 暂停 send_loop。"""
    logger.info('[WS] 绑定活跃 run session=%s run_id=%s，开始回放', session_id, run_id)

    # 注：调用方 _sync_active_run_subscription 已执行 _pause_realtime_send_loop，
    # 此处 send_gate 已处于 clear 状态，无需再次暂停。

    try:
        runtime_svc = container.get_agent_api_runtime_service()
        event_bus = runtime_svc.get_run_event_bus(run_id, session_id=session_id)
        all_history = await asyncio.to_thread(
            event_bus.get_event_history, session_id=session_id, limit=1000,
        )
        history = [e for e in all_history if getattr(e, 'timestamp', 0) >= run_started_at]

        from dependencies import get_task_registry
        registry = get_task_registry()

        await conn.send_json(ws, {
            'type': 'reconnect_start',
            'session_id': session_id,
            'run_id': run_id,
            'replay_count': len(history),
        })

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
            await conn.send_json(ws, payload)
            seq = getattr(event, 'sequence_number', 0)
            if seq > replay_max_seq:
                replay_max_seq = seq

        await conn.send_json(ws, {'type': 'reconnect_end', 'session_id': session_id})
        _drain_stale_events(queue, replay_max_seq)

    except Exception as exc:
        logger.warning('[WS] 回放失败 session=%s run_id=%s: %s', session_id, run_id, exc)
    finally:
        # 恢复 send_loop
        conn.send_gate.set()


def _drain_stale_events(queue: asyncio.Queue, max_seq: int):
    """移除 queue 中 seq <= max_seq 的 run 事件（保留 command.result 等全局事件）。"""
    kept = []
    while not queue.empty():
        try:
            event = queue.get_nowait()
        except asyncio.QueueEmpty:
            break

        if event is None or event is _PAUSE_SEND_LOOP:
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
        if item is None or item is _PAUSE_SEND_LOOP:
            scanned.append(item)
            continue
        if not evicted and not is_critical_event_type(item.type):
            evicted = True
            continue
        scanned.append(item)
    # 放回未驱逐的元素
    for item in scanned:
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            break
