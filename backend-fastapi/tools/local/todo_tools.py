# -*- coding: utf-8 -*-
"""
Todo 工具：todo_write。

对标 Claude Code TodoWrite，在进程内存中维护 session 级 todo 列表。
重启后丢失（按设计）。

所有 item 均为 completed 时自动清空列表，与 Claude Code 行为一致。
"""

from __future__ import annotations

from typing import Any, Optional

from tools.contracts.permissions import RiskLevel
from tools.decorators import tool
from tools.runtime.response_builder import error_result, success_result

# 进程内 Todo 存储：{session_id: [TodoItem, ...]}
_TODO_STORE: dict[str, list[dict[str, Any]]] = {}

_VALID_STATUSES = {"pending", "in_progress", "completed"}


def _get_todos(session_id: str) -> list[dict[str, Any]]:
    return _TODO_STORE.get(session_id, [])


@tool(
    name="todo_write",
    description=(
        "替换当前 session 的 todo 列表（内存存储，重启丢失）。"
        "适合在多步骤任务执行过程中追踪轻量级进度。"
        "当所有 item 均为 completed 时，列表自动清空。"
        "每次调用均全量替换，不做增量更新。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "todos": {
                "type": "array",
                "description": "todo 列表，全量替换当前 session 的 todo",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "任务描述",
                        },
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed"],
                            "description": "当前状态",
                        },
                        "active_form": {
                            "type": "string",
                            "description": "执行中展示文字，例如 'Running tests'",
                        },
                    },
                    "required": ["content", "status", "active_form"],
                },
            },
        },
        "required": ["todos"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "更新前后的 todo 列表",
        "shape": {
            "old_todos": "list",
            "new_todos": "list",
        },
    },
    source="decorator",
)
def todo_write(
    todos: list[dict[str, Any]],
    session_id: Optional[str] = None,
    **_kwargs: Any,
) -> Any:
    try:
        sid = (session_id or "").strip() or "default"

        # 校验每个 item
        validated: list[dict[str, Any]] = []
        for idx, item in enumerate(todos or []):
            content = str(item.get("content", "")).strip()
            status = str(item.get("status", "pending")).strip()
            active_form = str(item.get("active_form", "")).strip()

            if not content:
                return error_result(
                    f"todos[{idx}].content 不能为空", tool_name="todo_write"
                )
            if status not in _VALID_STATUSES:
                return error_result(
                    f"todos[{idx}].status 非法值 '{status}'，合法值：{sorted(_VALID_STATUSES)}",
                    tool_name="todo_write",
                )
            validated.append(
                {"content": content, "status": status, "active_form": active_form}
            )

        old_todos = list(_get_todos(sid))

        # 全部完成 → 自动清空（对齐 Claude Code 行为）
        if validated and all(item["status"] == "completed" for item in validated):
            _TODO_STORE[sid] = []
            new_todos: list[dict[str, Any]] = []
        else:
            _TODO_STORE[sid] = validated
            new_todos = validated

        pending_count = sum(1 for t in new_todos if t["status"] == "pending")
        in_progress_count = sum(1 for t in new_todos if t["status"] == "in_progress")
        completed_count = sum(1 for t in new_todos if t["status"] == "completed")

        summary = (
            f"todo 列表已更新：{len(new_todos)} 项"
            f"（待处理 {pending_count}，进行中 {in_progress_count}，已完成 {completed_count}）"
        )
        if not new_todos and old_todos:
            summary = "所有 todo 均已完成，列表已自动清空"

        return success_result(
            content={"old_todos": old_todos, "new_todos": new_todos},
            summary=summary,
            output_type="json",
            metadata={
                "session_id": sid,
                "count": len(new_todos),
                "pending": pending_count,
                "in_progress": in_progress_count,
                "completed": completed_count,
            },
            tool_name="todo_write",
        )
    except Exception as e:
        return error_result(f"更新 todo 列表失败: {e}", tool_name="todo_write")
