# -*- coding: utf-8 -*-
"""
Cron 调度引擎。

基于 asyncio 的轻量定时任务调度器，支持标准 5 段 cron 表达式。
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from daemon.models import CronTask

if TYPE_CHECKING:
    from daemon.service import DaemonService

logger = logging.getLogger(__name__)


def _parse_cron_field(field: str, min_val: int, max_val: int) -> List[int]:
    """解析单个 cron 字段为值列表。

    支持格式: *, */N, N, N-M, N,M,K
    """
    if field == '*':
        return list(range(min_val, max_val + 1))

    values = set()
    for part in field.split(','):
        if '/' in part:
            base, step = part.split('/', 1)
            step = int(step)
            if base == '*':
                start = min_val
            else:
                start = int(base)
            values.update(range(start, max_val + 1, step))
        elif '-' in part:
            start, end = part.split('-', 1)
            values.update(range(int(start), int(end) + 1))
        else:
            values.add(int(part))

    return sorted(v for v in values if min_val <= v <= max_val)


def matches_cron(cron_expr: str, dt: datetime) -> bool:
    """判断给定时间是否匹配 cron 表达式。

    标准 cron 语义：当 dom 和 dow 均被限定（非 ``*``）时，
    满足**任一**即触发（OR）；否则分别匹配。
    """
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        logger.warning('无效 cron 表达式（需 5 段）: %s', cron_expr)
        return False

    minute, hour, dom, month, dow = parts

    # cron dow: 0=Sunday, 1=Monday, ..., 6=Saturday
    # Python weekday(): 0=Monday, ..., 6=Sunday
    cron_dow = (dt.weekday() + 1) % 7  # Monday=1, ..., Saturday=6, Sunday=0

    if dt.minute not in _parse_cron_field(minute, 0, 59):
        return False
    if dt.hour not in _parse_cron_field(hour, 0, 23):
        return False
    if dt.month not in _parse_cron_field(month, 1, 12):
        return False

    dom_restricted = dom != '*'
    dow_restricted = dow != '*'
    if dom_restricted and dow_restricted:
        # 两者都限定 → OR 语义：满足任一即触发
        return (dt.day in _parse_cron_field(dom, 1, 31)
                or cron_dow in _parse_cron_field(dow, 0, 6))
    return (dt.day in _parse_cron_field(dom, 1, 31)
            and cron_dow in _parse_cron_field(dow, 0, 6))


def next_cron_time(cron_expr: str, after: Optional[datetime] = None) -> datetime:
    """计算下一个匹配时间（逐级跳过优化）。"""
    from datetime import timedelta
    dt = (after or datetime.now()).replace(second=0, microsecond=0) + timedelta(minutes=1)
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        return dt

    minutes = set(_parse_cron_field(parts[0], 0, 59))
    hours = set(_parse_cron_field(parts[1], 0, 23))
    doms = set(_parse_cron_field(parts[2], 1, 31))
    months = set(_parse_cron_field(parts[3], 1, 12))
    dows = set(_parse_cron_field(parts[4], 0, 6))

    limit = dt + timedelta(days=366)
    while dt < limit:
        # 月份不匹配 → 跳到下一个匹配月的1号 00:00
        if dt.month not in months:
            next_month = None
            for m in sorted(months):
                if m > dt.month:
                    next_month = m
                    break
            if next_month is None:
                dt = dt.replace(year=dt.year + 1, month=min(months), day=1, hour=0, minute=0)
            else:
                dt = dt.replace(month=next_month, day=1, hour=0, minute=0)
            continue

        # 小时不匹配 → 跳到下一个匹配小时
        if dt.hour not in hours:
            next_hour = None
            for h in sorted(hours):
                if h > dt.hour:
                    next_hour = h
                    break
            if next_hour is None:
                dt = dt.replace(hour=0, minute=0) + timedelta(days=1)
            else:
                dt = dt.replace(hour=next_hour, minute=0)
            continue

        # 日+星期（标准 cron：dom 和 dow 均被限定时取 OR 语义）
        cron_dow = (dt.weekday() + 1) % 7
        dom_restricted = parts[2] != '*'
        dow_restricted = parts[4] != '*'
        if dom_restricted and dow_restricted:
            day_match = dt.day in doms or cron_dow in dows
        else:
            day_match = dt.day in doms and cron_dow in dows
        if not day_match:
            dt += timedelta(days=1)
            dt = dt.replace(hour=0, minute=0)
            continue

        # 分钟匹配检查
        if dt.minute in minutes:
            return dt
        dt += timedelta(minutes=1)
    return dt


class CronScheduler:
    """Cron 调度引擎。"""

    def __init__(self, tasks: List[CronTask], daemon_service: DaemonService):
        self._tasks: Dict[str, CronTask] = {t.task_id: t for t in tasks if t.enabled}
        self._daemon_service = daemon_service
        self._running = False
        self._task_handle: Optional[asyncio.Task] = None
        self._pending_tasks: set[asyncio.Task] = set()
        self._history: Dict[str, List[Dict[str, Any]]] = {}

    async def start(self) -> None:
        """启动调度器。"""
        if self._running:
            return
        self._running = True
        # 计算每个任务的 next_run
        for task in self._tasks.values():
            task.next_run = next_cron_time(task.cron).timestamp()
        self._task_handle = asyncio.create_task(self._run_loop())
        logger.info('Cron 调度器启动，%d 个活跃任务', len(self._tasks))

    async def stop(self) -> None:
        """停止调度器，取消主循环和所有进行中的任务。"""
        self._running = False
        if self._task_handle:
            self._task_handle.cancel()
            try:
                await self._task_handle
            except asyncio.CancelledError:
                pass
            self._task_handle = None
        # 取消所有进行中的执行任务
        for t in list(self._pending_tasks):
            t.cancel()
        if self._pending_tasks:
            await asyncio.gather(*self._pending_tasks, return_exceptions=True)
            self._pending_tasks.clear()

    async def _run_loop(self) -> None:
        """主调度循环：每分钟检查一次到期任务。"""
        last_check_minute = -1
        while self._running:
            now = datetime.now()
            current_minute = now.hour * 60 + now.minute
            if current_minute != last_check_minute:
                last_check_minute = current_minute
                await self._check_and_execute(now)

            # 重新获取时间后对齐到下一分钟
            now = datetime.now()
            sleep_secs = 60 - now.second - now.microsecond / 1_000_000 + 0.1
            if sleep_secs <= 0:
                sleep_secs = 0.1
            await asyncio.sleep(sleep_secs)

    async def _check_and_execute(self, now: datetime) -> None:
        """检查并执行到期任务。"""
        for task_id, task in list(self._tasks.items()):
            if not task.enabled:
                continue
            try:
                if matches_cron(task.cron, now):
                    logger.info('触发 Cron 任务 [%s]: %s', task_id, task.name)
                    t = asyncio.create_task(self._execute_task(task))
                    self._pending_tasks.add(t)
                    t.add_done_callback(self._pending_tasks.discard)
            except Exception as e:
                logger.error('Cron 检查失败 [%s]: %s', task_id, e)

    async def _execute_task(self, task: CronTask) -> None:
        """执行单个 Cron 任务（最长 5 分钟超时）。"""
        start = time.time()
        try:
            result = await asyncio.wait_for(
                self._daemon_service.execute_cron_task(task),
                timeout=300,
            )
            elapsed = time.time() - start
            self._record_history(task.task_id, success=True, result=result, elapsed=elapsed)
        except asyncio.TimeoutError:
            elapsed = time.time() - start
            logger.error('Cron 任务执行超时 [%s] elapsed=%.1fs', task.task_id, elapsed)
            self._record_history(task.task_id, success=False, error='执行超时（>300s）', elapsed=elapsed)
        except Exception as e:
            elapsed = time.time() - start
            self._record_history(task.task_id, success=False, error=str(e), elapsed=elapsed)
        # 更新 next_run
        try:
            task.next_run = next_cron_time(task.cron).timestamp()
        except Exception:
            task.next_run = None

    def _record_history(
        self,
        task_id: str,
        *,
        success: bool,
        result: Optional[str] = None,
        error: Optional[str] = None,
        elapsed: float = 0,
    ) -> None:
        history = self._history.setdefault(task_id, [])
        history.append({
            'timestamp': time.time(),
            'success': success,
            'result': (result or '')[:200],
            'error': error,
            'elapsed': elapsed,
        })
        # 保留最近 50 条
        if len(history) > 50:
            self._history[task_id] = history[-50:]

    def get_history(self, task_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        return self._history.get(task_id, [])[-limit:]
