# -*- coding: utf-8 -*-
"""
Task 存储层（JSON 文件，按 session 隔离）。

存储路径：DATA_ROOT/tasks/{session_id}/{task_id}.json
计数器路径：DATA_ROOT/tasks/{session_id}/counter.json

设计原则：无副作用纯函数，线程安全（单进程 FastAPI 场景）。
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from core.path_resolution import DATA_ROOT

_lock = threading.Lock()

# ── 路径工具 ─────────────────────────────────────────────────────


def get_task_dir(session_id: str) -> Path:
    """返回并确保 session 的 task 目录存在。"""
    p = Path(DATA_ROOT) / "tasks" / session_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _counter_path(session_id: str) -> Path:
    return get_task_dir(session_id) / "counter.json"


def _task_path(session_id: str, task_id: str) -> Path:
    return get_task_dir(session_id) / f"{task_id}.json"


# ── ID 生成 ──────────────────────────────────────────────────────


def _next_task_id(session_id: str) -> str:
    """原子自增整数 task_id，返回字符串 "1","2",..."""
    cp = _counter_path(session_id)
    with _lock:
        if cp.exists():
            data = json.loads(cp.read_text(encoding="utf-8"))
            current = int(data.get("counter", 0))
        else:
            current = 0
        next_id = current + 1
        cp.write_text(json.dumps({"counter": next_id}), encoding="utf-8")
    return str(next_id)


# ── CRUD ─────────────────────────────────────────────────────────


def create_task(
    session_id: str,
    subject: str,
    description: str,
    active_form: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """创建任务并持久化，返回任务 dict。"""
    task_id = _next_task_id(session_id)
    task: dict[str, Any] = {
        "id": task_id,
        "subject": subject,
        "description": description,
        "active_form": active_form or "",
        "owner": "",
        "status": "pending",
        "blocks": [],
        "blocked_by": [],
        "metadata": metadata or {},
    }
    with _lock:
        _task_path(session_id, task_id).write_text(
            json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return task


def get_task(session_id: str, task_id: str) -> dict[str, Any] | None:
    """读取单个任务，不存在返回 None。"""
    p = _task_path(session_id, task_id)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def list_tasks(session_id: str) -> list[dict[str, Any]]:
    """返回 session 下全部任务（排除 counter.json），按 id 数值升序。"""
    task_dir = get_task_dir(session_id)
    tasks = []
    for fp in task_dir.glob("*.json"):
        if fp.name == "counter.json":
            continue
        try:
            tasks.append(json.loads(fp.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            pass
    tasks.sort(key=lambda t: int(t.get("id", "0")))
    return tasks


def update_task(session_id: str, task_id: str, **updates: Any) -> dict[str, Any] | None:
    """
    更新任务字段，返回更新后的任务 dict。

    支持的 updates key：
    - subject / description / active_form / owner / status
    - add_blocks: list[str]  — 追加到 blocks（去重），并同步更新被阻塞任务的 blocked_by
    - add_blocked_by: list[str]  — 追加到 blocked_by（去重），并同步更新阻塞任务的 blocks
    - metadata: dict  — merge 合并，value=None 则删除该 key

    status="deleted" 触发 delete_task()，返回 None。
    """
    with _lock:
        task = get_task(session_id, task_id)
        if task is None:
            return None

        # status=deleted 特殊处理
        if updates.get("status") == "deleted":
            _task_path(session_id, task_id).unlink(missing_ok=True)
            return None

        # 简单字段更新
        for key in ("subject", "description", "active_form", "owner", "status"):
            if key in updates:
                task[key] = updates[key]

        # add_blocks：追加到当前任务的 blocks，并在对方的 blocked_by 中补充本任务
        for bid in updates.get("add_blocks", []) or []:
            bid = str(bid)
            if bid not in task["blocks"]:
                task["blocks"].append(bid)
            # 同步对方 blocked_by
            other = get_task(session_id, bid)
            if other and task_id not in other["blocked_by"]:
                other["blocked_by"].append(task_id)
                _task_path(session_id, bid).write_text(
                    json.dumps(other, ensure_ascii=False, indent=2), encoding="utf-8"
                )

        # add_blocked_by：追加到当前任务的 blocked_by，并在对方的 blocks 中补充本任务
        for bid in updates.get("add_blocked_by", []) or []:
            bid = str(bid)
            if bid not in task["blocked_by"]:
                task["blocked_by"].append(bid)
            # 同步对方 blocks
            other = get_task(session_id, bid)
            if other and task_id not in other["blocks"]:
                other["blocks"].append(task_id)
                _task_path(session_id, bid).write_text(
                    json.dumps(other, ensure_ascii=False, indent=2), encoding="utf-8"
                )

        # metadata merge
        if "metadata" in updates and isinstance(updates["metadata"], dict):
            for k, v in updates["metadata"].items():
                if v is None:
                    task["metadata"].pop(k, None)
                else:
                    task["metadata"][k] = v

        _task_path(session_id, task_id).write_text(
            json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return task


def delete_task(session_id: str, task_id: str) -> bool:
    """删除任务文件，返回是否成功删除。"""
    p = _task_path(session_id, task_id)
    if p.exists():
        p.unlink()
        return True
    return False
