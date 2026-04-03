# -*- coding: utf-8 -*-
"""
通用后台任务管理器

bash 后台执行与 call_agent 后台模式共用此模块。
完成后发布 BACKGROUND_TASK_COMPLETED 事件。
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


@dataclass
class BackgroundTask:
    task_id: str
    description: str
    output_path: Path
    started_at: float = field(default_factory=time.time)
    status: str = "running"   # running | completed | failed | cancelled
    return_code: Optional[int] = None
    error: Optional[str] = None
    expires_at: Optional[float] = None

    def is_done(self) -> bool:
        return self.status in ("completed", "failed", "cancelled")


class BackgroundTaskManager:
    """单例后台任务管理器。"""

    _instance: Optional["BackgroundTaskManager"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "BackgroundTaskManager":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._tasks: dict[str, BackgroundTask] = {}
                cls._instance._processes: dict[str, subprocess.Popen] = {}
                cls._instance._tasks_lock = threading.Lock()
                cls._instance._retention_seconds = 2 * 60 * 60
        return cls._instance

    # ── bash 后台执行 ─────────────────────────────────────────

    def spawn_bash(
        self,
        command: str,
        *,
        bash_executable: Optional[str],
        cwd: Path,
        output_dir: Path,
        description: str = "",
        env: dict | None = None,
        max_runtime_seconds: int | None = None,
        event_bus=None,
        session_id: Optional[str] = None,
    ) -> BackgroundTask:
        """
        启动后台 bash 命令，stdout/stderr 写入文件。

        Returns:
            BackgroundTask（status=running）
        """
        task_id = str(uuid.uuid4())
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"bg_{task_id[:8]}.log"

        task = BackgroundTask(
            task_id=task_id,
            description=description or command[:80],
            output_path=output_path,
            expires_at=time.time() + self._retention_seconds,
        )

        with self._tasks_lock:
            self._tasks[task_id] = task

        merged_env = {**os.environ, "LC_ALL": "C.UTF-8", **(env or {})}

        try:
            out_fh = open(output_path, "w", encoding="utf-8")
            if bash_executable:
                proc = subprocess.Popen(
                    [bash_executable, "-c", command],
                    cwd=str(cwd),
                    stdout=out_fh,
                    stderr=subprocess.STDOUT,
                    env=merged_env,
                )
            else:
                proc = subprocess.Popen(
                    command,
                    shell=True,
                    cwd=str(cwd),
                    stdout=out_fh,
                    stderr=subprocess.STDOUT,
                    env=merged_env,
                )

            with self._tasks_lock:
                self._processes[task_id] = proc

            # 监控线程
            def _monitor():
                try:
                    if max_runtime_seconds and max_runtime_seconds > 0:
                        deadline = time.time() + max_runtime_seconds
                        while proc.poll() is None:
                            if time.time() >= deadline:
                                proc.terminate()
                                try:
                                    proc.wait(timeout=1)
                                except Exception:
                                    proc.kill()
                                break
                            time.sleep(0.5)
                    proc.wait()
                    out_fh.close()
                    with self._tasks_lock:
                        t = self._tasks.get(task_id)
                        if t and not t.is_done():
                            t.return_code = proc.returncode
                            t.status = "completed" if proc.returncode == 0 else "failed"
                    logger.info("后台任务完成: task_id=%s rc=%s", task_id, proc.returncode)
                    _publish_completed(task_id, proc.returncode, event_bus, session_id)
                except Exception as exc:
                    logger.warning("后台任务监控异常: %s", exc)
                finally:
                    try:
                        out_fh.close()
                    except Exception:
                        pass
                    with self._tasks_lock:
                        self._processes.pop(task_id, None)

            t = threading.Thread(target=_monitor, daemon=True)
            t.start()

        except Exception as exc:
            task.status = "failed"
            task.error = str(exc)
            logger.error("后台任务启动失败: %s", exc)

        return task

    # ── callable 后台提交（供 call_agent 等使用）─────────────

    def submit_callable(
        self,
        fn: Callable[[], Any],
        *,
        description: str = "",
        output_dir: Path,
        event_bus=None,
        session_id: Optional[str] = None,
    ) -> BackgroundTask:
        """提交任意 callable 在后台线程中执行。"""
        task_id = str(uuid.uuid4())
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"bg_{task_id[:8]}.json"

        task = BackgroundTask(
            task_id=task_id,
            description=description,
            output_path=output_path,
        )
        with self._tasks_lock:
            self._tasks[task_id] = task

        def _run():
            try:
                result = fn()
                import json
                output_path.write_text(
                    json.dumps({"success": True, "result": str(result)}, ensure_ascii=False),
                    encoding="utf-8",
                )
                with self._tasks_lock:
                    t = self._tasks.get(task_id)
                    if t:
                        t.status = "completed"
                        t.return_code = 0
                _publish_completed(task_id, 0, event_bus, session_id)
            except Exception as exc:
                with self._tasks_lock:
                    t = self._tasks.get(task_id)
                    if t:
                        t.status = "failed"
                        t.error = str(exc)
                _publish_completed(task_id, 1, event_bus, session_id)

        threading.Thread(target=_run, daemon=True).start()
        return task

    # ── 查询 / 取消 ───────────────────────────────────────────

    def _cleanup_expired_tasks(self) -> None:
        now = time.time()
        with self._tasks_lock:
            expired_ids = [
                task_id for task_id, task in self._tasks.items()
                if task.is_done() and task.expires_at is not None and task.expires_at <= now
            ]
            for task_id in expired_ids:
                self._tasks.pop(task_id, None)
                self._processes.pop(task_id, None)

    def get_task(self, task_id: str) -> Optional[BackgroundTask]:
        self._cleanup_expired_tasks()
        with self._tasks_lock:
            return self._tasks.get(task_id)

    def get_output(self, task_id: str) -> Optional[str]:
        with self._tasks_lock:
            task = self._tasks.get(task_id)
        if task is None or not task.output_path.exists():
            return None
        try:
            return task.output_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None

    def cancel(self, task_id: str) -> bool:
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            proc = self._processes.get(task_id)

        if task is None:
            return False
        if task.is_done():
            return False

        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass

        with self._tasks_lock:
            if task_id in self._tasks:
                self._tasks[task_id].status = "cancelled"

        return True


def _publish_completed(task_id: str, return_code: int, event_bus, session_id: Optional[str]):
    if not event_bus:
        return
    try:
        from agents.events.bus import Event, EventType
        event_bus.publish(Event(
            type=EventType.BACKGROUND_TASK_COMPLETED,
            session_id=session_id,
            data={
                "task_id": task_id,
                "return_code": return_code,
                "success": return_code == 0,
            },
        ))
    except Exception as exc:
        logger.debug("发布后台任务完成事件失败: %s", exc)


def get_background_task_manager() -> BackgroundTaskManager:
    return BackgroundTaskManager()


__all__ = ["BackgroundTask", "BackgroundTaskManager", "get_background_task_manager"]
