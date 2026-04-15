# -*- coding: utf-8 -*-
"""
通用后台任务管理器

bash 后台执行与 call_agent 后台模式共用此模块。
完成后发布 BACKGROUND_TASK_COMPLETED 事件。
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import subprocess
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field, is_dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from tools.contracts.result_models import ToolExecutionResult

logger = logging.getLogger(__name__)


def _ensure_serializable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, set):
        return [_ensure_serializable(v) for v in value]
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if is_dataclass(value):
        return _ensure_serializable(asdict(value))
    if isinstance(value, dict):
        return {str(k): _ensure_serializable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_ensure_serializable(v) for v in value]
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        return str(value)


def _serialize_background_result(result: Any) -> dict[str, Any]:
    if isinstance(result, ToolExecutionResult):
        return {
            "success": True,
            "result_type": "tool_execution_result",
            "result": {
                "success": result.success,
                "tool_name": result.tool_name,
                "summary": result.summary,
                "answer": result.answer,
                "output_type": result.output_type,
                "content": _ensure_serializable(result.content),
                "metadata": _ensure_serializable(result.metadata),
                "artifacts": _ensure_serializable(result.artifacts),
                "llm_hint": result.llm_hint,
            },
        }
    return {
        "success": True,
        "result_type": type(result).__name__,
        "result": _ensure_serializable(result),
    }


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
    run_id: Optional[str] = None
    owner_task_id: Optional[str] = None
    session_id: Optional[str] = None
    completed_at: Optional[float] = None
    result_type: Optional[str] = None
    kind: str = "generic"
    cancel_supported: bool = False

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
        run_id: Optional[str] = None,
        owner_task_id: Optional[str] = None,
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
            run_id=run_id,
            owner_task_id=owner_task_id,
            session_id=session_id,
            kind="bash",
            cancel_supported=True,
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
                            t.result_type = "bash_output"
                            t.completed_at = time.time()
                    logger.info("后台任务完成: task_id=%s rc=%s", task_id, proc.returncode)
                    _publish_completed(
                        task_id,
                        proc.returncode,
                        event_bus,
                        session_id,
                        run_id=run_id,
                        owner_task_id=owner_task_id,
                        output_path=output_path,
                        result_type="bash_output",
                    )
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
        run_id: Optional[str] = None,
        owner_task_id: Optional[str] = None,
    ) -> BackgroundTask:
        """提交任意 callable 在后台线程中执行。"""
        task_id = str(uuid.uuid4())
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"bg_{task_id[:8]}.json"

        task = BackgroundTask(
            task_id=task_id,
            description=description,
            output_path=output_path,
            run_id=run_id,
            owner_task_id=owner_task_id,
            session_id=session_id,
            expires_at=time.time() + self._retention_seconds,
            kind="callable",
            cancel_supported=False,
        )
        with self._tasks_lock:
            self._tasks[task_id] = task

        def _run():
            try:
                result = fn()
                payload = _serialize_background_result(result)
                output_path.write_text(
                    json.dumps(payload, ensure_ascii=False),
                    encoding="utf-8",
                )
                with self._tasks_lock:
                    t = self._tasks.get(task_id)
                    if t:
                        t.status = "completed"
                        t.return_code = 0
                        t.result_type = payload.get("result_type")
                        t.completed_at = time.time()
                _publish_completed(
                    task_id,
                    0,
                    event_bus,
                    session_id,
                    run_id=run_id,
                    owner_task_id=owner_task_id,
                    output_path=output_path,
                    result_type=payload.get("result_type"),
                )
            except Exception as exc:
                failure_payload = {
                    "success": False,
                    "error": str(exc),
                    "result_type": "exception",
                }
                try:
                    output_path.write_text(
                        json.dumps(failure_payload, ensure_ascii=False),
                        encoding="utf-8",
                    )
                except Exception:
                    pass
                with self._tasks_lock:
                    t = self._tasks.get(task_id)
                    if t:
                        t.status = "failed"
                        t.error = str(exc)
                        t.result_type = "exception"
                        t.completed_at = time.time()
                _publish_completed(
                    task_id,
                    1,
                    event_bus,
                    session_id,
                    run_id=run_id,
                    owner_task_id=owner_task_id,
                    output_path=output_path,
                    result_type="exception",
                )

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

    def read_output(self, task_id: str, *, max_chars: Optional[int] = None) -> Optional[str]:
        output = self.get_output(task_id)
        if output is None or max_chars is None or max_chars <= 0:
            return output
        if len(output) <= max_chars:
            return output
        return output[:max_chars]

    def get_task_snapshot(self, task_id: str) -> Optional[dict[str, Any]]:
        task = self.get_task(task_id)
        if task is None:
            return None
        return {
            "task_id": task.task_id,
            "description": task.description,
            "status": task.status,
            "return_code": task.return_code,
            "error": task.error,
            "started_at": task.started_at,
            "completed_at": task.completed_at,
            "result_type": task.result_type,
            "output_path": str(task.output_path),
            "run_id": task.run_id,
            "owner_task_id": task.owner_task_id,
            "session_id": task.session_id,
            "kind": task.kind,
            "cancel_supported": task.cancel_supported,
        }

    def cancel(self, task_id: str) -> bool:
        with self._tasks_lock:
            task = self._tasks.get(task_id)
            proc = self._processes.get(task_id)

        if task is None:
            return False
        if task.is_done() or not task.cancel_supported:
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


def _publish_completed(
    task_id: str, return_code: int, event_bus, session_id: Optional[str],
    *,
    run_id: Optional[str] = None,
    owner_task_id: Optional[str] = None,
    output_path: Optional[Path] = None,
    result_type: Optional[str] = None,
):
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
                "run_id": run_id,
                "owner_task_id": owner_task_id,
                "completed_at": time.time(),
                "output_path": str(output_path) if output_path else None,
                "result_type": result_type,
            },
        ))
    except Exception as exc:
        logger.debug("发布后台任务完成事件失败: %s", exc)


def get_background_task_manager() -> BackgroundTaskManager:
    return BackgroundTaskManager()


__all__ = ["BackgroundTask", "BackgroundTaskManager", "get_background_task_manager"]
