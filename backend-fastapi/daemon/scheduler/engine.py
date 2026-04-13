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
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

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
    """判断给定时间是否匹配 cron 表达式。"""
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        logger.warning('无效 cron 表达式（需 5 段）: %s', cron_expr)
        return False

    minute, hour, dom, month, dow = parts

    # cron dow: 0=Sunday, 1=Monday, ..., 6=Saturday
    # Python weekday(): 0=Monday, ..., 6=Sunday
    python_dow = dt.weekday()
    cron_dow = (python_dow + 1) % 7  # Monday=1, ..., Saturday=6, Sunday=0

    checks = [
        (_parse_cron_field(minute, 0, 59), dt.minute),
        (_parse_cron_field(hour, 0, 23), dt.hour),
        (_parse_cron_field(dom, 1, 31), dt.day),
        (_parse_cron_field(month, 1, 12), dt.month),
        (_parse_cron_field(dow, 0, 6), cron_dow),
    ]

    return all(val in allowed for allowed, val in checks)


def next_cron_time(cron_expr: str, after: Optional[datetime] = None) -> datetime:
    """计算下一个匹配时间（简单实现，逐分钟迭代）。"""
    from datetime import timedelta
    dt = after or datetime.now()
    dt = dt.replace(second=0, microsecond=0)
    # 最多搜索 1 年
    limit = dt + timedelta(days=366)
    dt += timedelta(minutes=1)
    while dt < limit:
        try:
            if matches_cron(cron_expr, dt):
                return dt
        except (ValueError, OverflowError):
            break
        dt += timedelta(minutes=1)
    return dt


class CronScheduler:
    """Cron 调度引擎。"""

    def __init__(self, tasks: List[CronTask], daemon_service: Any):
        self._tasks: Dict[str, CronTask] = {t.task_id: t for t in tasks if t.enabled}
        self._daemon_service = daemon_service
        self._running = False
        self._task_handle: Optional[asyncio.Task] = None
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
        """停止调度器。"""
        self._running = False
        if self._task_handle:
            self._task_handle.cancel()
            try:
                await self._task_handle
            except asyncio.CancelledError:
                pass
            self._task_handle = None

    async def _run_loop(self) -> None:
        """主调度循环：每分钟检查一次到期任务。"""
        last_check_minute = -1
        while self._running:
            now = datetime.now()
            current_minute = now.hour * 60 + now.minute
            if current_minute != last_check_minute:
                last_check_minute = current_minute
                await self._check_and_execute(now)

            # 对齐到下一分钟
            sleep_secs = 60 - now.second + 1
            await asyncio.sleep(sleep_secs)

    async def _check_and_execute(self, now: datetime) -> None:
        """检查并执行到期任务。"""
        for task_id, task in list(self._tasks.items()):
            if not task.enabled:
                continue
            try:
                if matches_cron(task.cron, now):
                    logger.info('触发 Cron 任务 [%s]: %s', task_id, task.name)
                    asyncio.create_task(self._execute_task(task))
            except Exception as e:
                logger.error('Cron 检查失败 [%s]: %s', task_id, e)

    async def _execute_task(self, task: CronTask) -> None:
        """执行单个 Cron 任务。"""
        start = time.time()
        try:
            result = await self._daemon_service.execute_cron_task(task)
            elapsed = time.time() - start
            self._record_history(task.task_id, success=True, result=result, elapsed=elapsed)
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
