# -*- coding: utf-8 -*-
"""
持久化 Shell Session 管理

每个 session_id 维护一个长生命周期的 bash 进程（sentinel 模式），
跨 execute_bash 调用保留 cwd 和环境变量。

对标 Claude Code BashTool 持久 shell 实现。
"""

from __future__ import annotations

import logging
import os
import platform
import select
import subprocess
import threading
import time
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

_IS_WINDOWS = platform.system() == "Windows"


class PersistentShellSession:
    """
    单个 session 的持久 bash 进程。

    使用 sentinel 模式：每条命令包裹成
        ( {command} ); _EC=$?; echo '__SENTINEL_{uuid}_EXIT_'$_EC'__'
    读取 stdout 直到遇到 sentinel 行，以此获取退出码。
    """

    def __init__(self, bash_executable: Optional[str] = None):
        self._lock = threading.Lock()
        self._bash = bash_executable

        kwargs: dict = dict(
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={**os.environ, "LC_ALL": "C.UTF-8"},
        )
        if _IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP

        if self._bash:
            self.proc = subprocess.Popen([self._bash], **kwargs)
        else:
            self.proc = subprocess.Popen(
                ["bash"] if not _IS_WINDOWS else "bash",
                shell=_IS_WINDOWS,
                **kwargs,
            )

    # ── 核心执行 ────────────────────────────────────────────

    def execute(
        self,
        command: str,
        *,
        timeout: int,
        cancel_event: Optional[threading.Event] = None,
        event_bus=None,
        session_id: Optional[str] = None,
    ) -> tuple[str, str, int, bool]:
        """
        在持久 bash 中执行命令。

        Returns:
            (stdout, stderr, return_code, interrupted)
        """
        sentinel_id = uuid.uuid4().hex[:16]
        sentinel = f"__SENTINEL_{sentinel_id}_EXIT_"

        wrapped = (
            f"{command}\n"
            f"_EC=$?; "
            f"echo '{sentinel}'$_EC'__'\n"
        )

        with self._lock:
            stdout_lines: list[str] = []
            return_code = -1
            interrupted = False

            self.proc.stdin.write(wrapped)
            self.proc.stdin.flush()

            started = time.monotonic()
            last_progress = started

            while True:
                elapsed = time.monotonic() - started
                if cancel_event and cancel_event.is_set() and not interrupted:
                    self._interrupt()
                    interrupted = True
                if elapsed >= timeout and not interrupted:
                    self._interrupt()
                    interrupted = True

                line = self._readline_nonblocking(self.proc.stdout, timeout_sec=0.2)
                if line is None:
                    if interrupted and self.proc.poll() is not None:
                        break
                    now = time.monotonic()
                    if now - last_progress >= 2.0:
                        _publish_progress(
                            event_bus, session_id,
                            command=command,
                            elapsed=elapsed,
                        )
                        last_progress = now
                    continue

                if sentinel in line:
                    try:
                        suffix = line.split(sentinel, 1)[1]
                        rc_str = suffix.split("__")[0]
                        return_code = int(rc_str)
                    except (IndexError, ValueError):
                        return_code = 0
                    break
                stdout_lines.append(line)

            stderr_out = self._drain_stderr()
            if interrupted and return_code == -1 and self.proc.poll() is not None:
                return_code = self.proc.returncode or -1
            return "".join(stdout_lines), stderr_out, return_code, interrupted

    # ── 辅助 ────────────────────────────────────────────────

    def _readline_nonblocking(self, stream, timeout_sec: float) -> Optional[str]:
        """优先用 select 非阻塞读；Windows 回退到短轮询。"""
        if _IS_WINDOWS:
            deadline = time.monotonic() + timeout_sec
            while time.monotonic() < deadline:
                line = stream.readline()
                if line:
                    return line
                time.sleep(0.01)
            return None

        ready, _, _ = select.select([stream], [], [], timeout_sec)
        if not ready:
            return None
        line = stream.readline()
        return line if line else None

    def _drain_stderr(self) -> str:
        """非阻塞读取所有可用 stderr。"""
        lines: list[str] = []
        while True:
            line = self._readline_nonblocking(self.proc.stderr, 0.05)
            if line is None:
                break
            lines.append(line)
        return "".join(lines)

    def _interrupt(self):
        """向 bash 进程发送中断信号。"""
        try:
            if _IS_WINDOWS:
                import signal
                os.kill(self.proc.pid, signal.CTRL_C_EVENT)
            else:
                import signal
                os.kill(self.proc.pid, signal.SIGINT)
        except Exception as exc:
            logger.debug("发送中断信号失败: %s", exc)

    def close(self):
        """关闭持久 shell。"""
        try:
            self.proc.stdin.write("exit\n")
            self.proc.stdin.flush()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=3)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass

    @property
    def is_alive(self) -> bool:
        return self.proc.poll() is None


# ── 进度事件 ─────────────────────────────────────────────────

def _publish_progress(event_bus, session_id: Optional[str], *, command: str, elapsed: float):
    if not event_bus:
        return
    try:
        from agents.events.bus import Event, EventType
        event_bus.publish(Event(
            type=EventType.TOOL_PROGRESS,
            session_id=session_id,
            data={
                "tool_name": "execute_bash",
                "command": command,
                "elapsed_seconds": round(elapsed, 1),
                "persistent_shell": True,
            },
        ))
    except Exception as exc:
        logger.debug("发布 bash 进度事件失败: %s", exc)


# ── 管理器 ───────────────────────────────────────────────────

class PersistentShellManager:
    """
    单例，管理所有 session 的持久 shell 实例。
    session 结束时通过 SESSION_END 事件自动清理。
    """

    _instance: Optional["PersistentShellManager"] = None
    _instance_lock = threading.Lock()

    def __new__(cls) -> "PersistentShellManager":
        with cls._instance_lock:
            if cls._instance is None:
                inst = super().__new__(cls)
                inst._sessions: dict[str, PersistentShellSession] = {}
                inst._lock = threading.Lock()
                inst._subscribed_buses: set[int] = set()
                cls._instance = inst
        return cls._instance

    def get_session(
        self,
        session_id: str,
        *,
        event_bus=None,
        bash_executable: Optional[str] = None,
    ) -> PersistentShellSession:
        """懒创建持久 shell，并订阅 SESSION_END 事件。"""
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess and sess.is_alive:
                return sess
            # 旧 session 已死，重建
            if sess:
                try:
                    sess.close()
                except Exception:
                    pass
            new_sess = PersistentShellSession(bash_executable=bash_executable)
            self._sessions[session_id] = new_sess

        # 订阅 SESSION_END（每个 event_bus 只订阅一次）
        if event_bus is not None:
            bus_id = id(event_bus)
            with self._lock:
                already = bus_id in self._subscribed_buses
                if not already:
                    self._subscribed_buses.add(bus_id)
            if not already:
                self._subscribe_session_end(event_bus)

        return new_sess

    def _subscribe_session_end(self, event_bus):
        manager = self

        def _on_session_end(event):
            sid = event.session_id or (event.data or {}).get("session_id")
            if sid:
                manager.close_session(sid)

        try:
            from agents.events.bus import EventType
            event_bus.subscribe([EventType.SESSION_END], _on_session_end)
        except Exception as exc:
            logger.debug("订阅 SESSION_END 失败: %s", exc)

    def close_session(self, session_id: str):
        with self._lock:
            sess = self._sessions.pop(session_id, None)
        if sess:
            try:
                sess.close()
            except Exception as exc:
                logger.debug("关闭持久 shell 失败 session=%s: %s", session_id, exc)


def get_persistent_shell_manager() -> PersistentShellManager:
    return PersistentShellManager()


__all__ = [
    "PersistentShellSession",
    "PersistentShellManager",
    "get_persistent_shell_manager",
]
