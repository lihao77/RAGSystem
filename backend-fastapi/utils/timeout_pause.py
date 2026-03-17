# -*- coding: utf-8 -*-
"""
线程级暂停时间追踪器。

用户等待（审批、输入、大文件确认）期间暂停超时计时，
避免用户还没操作工具就已经超时。

使用方式：
- _run_with_timeout 创建 PausableTimer，通过 set_current_timer 注入工具执行线程
- 各等待点调用 pause_current() / resume_current()
- 超时判断时读取 timer.paused_duration 扣除暂停时长
"""

from __future__ import annotations

import threading
import time

_local = threading.local()


class PausableTimer:
    """线程安全的暂停时间累加器。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pause_start: float | None = None
        self._total_paused: float = 0.0

    def pause(self) -> None:
        """标记进入用户等待，暂停超时计时。"""
        with self._lock:
            if self._pause_start is None:
                self._pause_start = time.monotonic()

    def resume(self) -> None:
        """标记用户等待结束，恢复超时计时。"""
        with self._lock:
            if self._pause_start is not None:
                self._total_paused += time.monotonic() - self._pause_start
                self._pause_start = None

    @property
    def paused_duration(self) -> float:
        """获取累计暂停时长（秒），含当前正在暂停的时间。"""
        with self._lock:
            total = self._total_paused
            if self._pause_start is not None:
                total += time.monotonic() - self._pause_start
            return total


def set_current_timer(timer: PausableTimer) -> None:
    """将 PausableTimer 绑定到当前线程。"""
    _local.timer = timer


def get_current_timer() -> PausableTimer | None:
    """获取当前线程绑定的 PausableTimer。"""
    return getattr(_local, 'timer', None)


def pause_current() -> None:
    """暂停当前线程的超时计时（若已绑定 timer）。"""
    timer = get_current_timer()
    if timer is not None:
        timer.pause()


def resume_current() -> None:
    """恢复当前线程的超时计时（若已绑定 timer）。"""
    timer = get_current_timer()
    if timer is not None:
        timer.resume()
