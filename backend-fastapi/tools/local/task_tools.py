# -*- coding: utf-8 -*-
"""
Task 工具：task_create / task_get / task_update / task_list。

对标 Claude Code TaskCreate/Get/Update/List，支持 Agent 在多步骤任务中
追踪进度、建立依赖关系、向用户展示执行状态。

存储：JSON 文件，按 session_id 隔离（见 task_store.py）。
"""

from __future__ import annotations

from typing import Any, Optional
import json

from tools.contracts.permissions import RiskLevel
from tools.decorators import tool
from tools.local.task_store import create_task, get_task, list_tasks, update_task
from tools.runtime.background_tasks import get_background_task_manager
from tools.runtime.response_builder import error_result, success_result

# ── task_create ──────────────────────────────────────────────────


@tool(
    name="task_create",
    description=(
        "创建一个任务并持久化到当前 session。返回 task_id，后续可用 task_get/task_update 操作。"
        "适合多步骤任务开始前建立追踪条目。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "subject": {
                "type": "string",
                "description": "任务标题（祈使句式，简短），例如 'Fix authentication bug'",
            },
            "description": {
                "type": "string",
                "description": "详细描述与验收标准",
            },
            "active_form": {
                "type": "string",
                "description": "任务执行中状态的展示文字，例如 'Fixing authentication bug'（可选）",
            },
            "metadata": {
                "type": "object",
                "description": "附加键值元数据（可选）",
            },
        },
        "required": ["subject", "description"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "创建结果，包含 task 详情",
        "shape": {"task": {"id": "string", "subject": "string", "status": "string"}},
    },
    source="task",
)
def task_create(
    subject: str,
    description: str,
    active_form: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
    session_id: Optional[str] = None,
    **_kwargs: Any,
) -> Any:
    try:
        sid = (session_id or "").strip() or "default"
        task = create_task(
            session_id=sid,
            subject=subject,
            description=description,
            active_form=active_form,
            metadata=metadata,
        )
        return success_result(
            content={"task": task},
            summary=f"已创建任务 #{task['id']}: {subject}",
            output_type="json",
            metadata={"task_id": task["id"], "session_id": sid},
            tool_name="task_create",
        )
    except Exception as e:
        return error_result(f"创建任务失败: {e}", tool_name="task_create")


# ── task_get ─────────────────────────────────────────────────────


@tool(
    name="task_get",
    description=(
        "获取单个任务的完整详情，包括 subject、description、status、blocks、blocked_by、owner 等字段。"
        "建议在开始处理某个任务前先调用以确认最新状态。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "任务 ID，由 task_create 返回",
            },
        },
        "required": ["task_id"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "任务详情，不存在时 task 为 null",
        "shape": {"task": "object | null"},
    },
    source="task",
)
def task_get(
    task_id: str,
    session_id: Optional[str] = None,
    **_kwargs: Any,
) -> Any:
    try:
        sid = (session_id or "").strip() or "default"
        task = get_task(session_id=sid, task_id=str(task_id))
        if task is None:
            return success_result(
                content={"task": None},
                summary=f"任务 #{task_id} 不存在",
                output_type="json",
                metadata={"task_id": task_id, "found": False},
                tool_name="task_get",
            )
        return success_result(
            content={"task": task},
            summary=f"已获取任务 #{task_id}: {task.get('subject', '')}",
            output_type="json",
            metadata={"task_id": task_id, "status": task.get("status")},
            tool_name="task_get",
        )
    except Exception as e:
        return error_result(f"获取任务失败: {e}", tool_name="task_get")


# ── task_update ──────────────────────────────────────────────────


@tool(
    name="task_update",
    description=(
        "更新任务字段、状态或阻塞关系。"
        "status 可选值：pending / in_progress / completed / deleted（deleted 会删除文件）。"
        "add_blocks / add_blocked_by 追加依赖关系并自动双向同步。"
        "metadata 做 merge 合并，value=null 删除对应 key。"
        "开始处理任务前设 status=in_progress，完成后设 status=completed。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "任务 ID"},
            "subject": {"type": "string", "description": "新标题（可选）"},
            "description": {"type": "string", "description": "新描述（可选）"},
            "active_form": {"type": "string", "description": "执行中展示文字（可选）"},
            "owner": {"type": "string", "description": "认领任务的 agent 名（可选）"},
            "status": {
                "type": "string",
                "enum": ["pending", "in_progress", "completed", "deleted"],
                "description": "新状态（可选）",
            },
            "add_blocks": {
                "type": "array",
                "items": {"type": "string"},
                "description": "追加到 blocks 列表的 task_id（本任务阻塞这些任务）",
            },
            "add_blocked_by": {
                "type": "array",
                "items": {"type": "string"},
                "description": "追加到 blocked_by 列表的 task_id（这些任务阻塞本任务）",
            },
            "metadata": {
                "type": "object",
                "description": "merge 合并到 metadata，value=null 删除对应 key",
            },
        },
        "required": ["task_id"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "更新结果",
        "shape": {
            "success": "boolean",
            "task_id": "string",
            "updated_fields": "list[string]",
            "status_change": "object | null",
        },
    },
    source="task",
)
def task_update(
    task_id: str,
    subject: Optional[str] = None,
    description: Optional[str] = None,
    active_form: Optional[str] = None,
    owner: Optional[str] = None,
    status: Optional[str] = None,
    add_blocks: Optional[list[str]] = None,
    add_blocked_by: Optional[list[str]] = None,
    metadata: Optional[dict[str, Any]] = None,
    session_id: Optional[str] = None,
    **_kwargs: Any,
) -> Any:
    try:
        sid = (session_id or "").strip() or "default"
        old_task = get_task(session_id=sid, task_id=str(task_id))
        old_status = old_task.get("status") if old_task else None

        updates: dict[str, Any] = {}
        updated_fields: list[str] = []

        for key, val in [
            ("subject", subject),
            ("description", description),
            ("active_form", active_form),
            ("owner", owner),
            ("status", status),
        ]:
            if val is not None:
                updates[key] = val
                updated_fields.append(key)

        if add_blocks:
            updates["add_blocks"] = add_blocks
            updated_fields.append("blocks")

        if add_blocked_by:
            updates["add_blocked_by"] = add_blocked_by
            updated_fields.append("blocked_by")

        if metadata is not None:
            updates["metadata"] = metadata
            updated_fields.append("metadata")

        result = update_task(session_id=sid, task_id=str(task_id), **updates)

        # status=deleted 时 result 为 None
        if status == "deleted":
            return success_result(
                content={
                    "success": True,
                    "task_id": str(task_id),
                    "updated_fields": ["status"],
                    "status_change": {"from": old_status, "to": "deleted"},
                },
                summary=f"已删除任务 #{task_id}",
                output_type="json",
                tool_name="task_update",
            )

        if result is None:
            return error_result(f"任务 #{task_id} 不存在", tool_name="task_update")

        new_status = result.get("status")
        status_change = (
            {"from": old_status, "to": new_status}
            if old_status != new_status
            else None
        )

        return success_result(
            content={
                "success": True,
                "task_id": str(task_id),
                "updated_fields": updated_fields,
                "status_change": status_change,
            },
            summary=f"已更新任务 #{task_id}（{', '.join(updated_fields) or '无变更'}）",
            output_type="json",
            metadata={"task_id": task_id, "status": new_status},
            tool_name="task_update",
        )
    except Exception as e:
        return error_result(f"更新任务失败: {e}", tool_name="task_update")


def _build_background_output_content(task_snapshot: dict[str, Any], raw_output: str | None) -> dict[str, Any]:
    result_type = task_snapshot.get("result_type")
    parsed_output: Any = None
    if raw_output:
        if result_type != "bash_output":
            try:
                parsed_output = json.loads(raw_output)
            except Exception:
                parsed_output = raw_output
        else:
            parsed_output = raw_output
    return {
        "task_id": task_snapshot.get("task_id"),
        "description": task_snapshot.get("description", ""),
        "status": task_snapshot.get("status"),
        "completed": task_snapshot.get("status") in {"completed", "failed", "cancelled"},
        "return_code": task_snapshot.get("return_code"),
        "error": task_snapshot.get("error"),
        "result_type": result_type,
        "started_at": task_snapshot.get("started_at"),
        "completed_at": task_snapshot.get("completed_at"),
        "output_path": task_snapshot.get("output_path"),
        "kind": task_snapshot.get("kind"),
        "cancel_supported": task_snapshot.get("cancel_supported", False),
        "output": parsed_output,
    }


# ── task_output / task_stop ─────────────────────────────────────


@tool(
    name="task_output",
    description=(
        "读取后台任务当前结果或等待其完成。"
        "block=false 时立即返回当前状态；block=true 时若任务尚未完成，会触发显式等待并在完成后继续返回结果。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "后台任务 ID"},
            "block": {"type": "boolean", "description": "是否等待任务完成", "default": False},
            "timeout": {
                "type": "integer",
                "description": "block=true 时的最大等待毫秒数，默认 30000",
                "minimum": 0,
                "maximum": 600000,
            },
            "max_chars": {
                "type": "integer",
                "description": "读取输出的最大字符数，默认 8000",
                "minimum": 200,
            },
        },
        "required": ["task_id"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "后台任务状态与输出；block=true 且任务未完成时会返回显式等待提示",
        "shape": {
            "task_id": "string",
            "status": "string",
            "completed": "boolean",
            "return_code": "number|null",
            "result_type": "string|null",
            "output": "any",
        },
    },
    source="task",
)
def task_output(
    task_id: str,
    block: bool = False,
    timeout: int = 30000,
    max_chars: int = 8000,
    session_id: Optional[str] = None,
    **_kwargs: Any,
) -> Any:
    del session_id
    try:
        bg_manager = get_background_task_manager()
        snapshot = bg_manager.get_task_snapshot(str(task_id))
        if snapshot is None:
            return error_result(f"后台任务 {task_id} 不存在", tool_name="task_output")

        raw_output = bg_manager.read_output(str(task_id), max_chars=max_chars)
        content = _build_background_output_content(snapshot, raw_output)
        completed = content["completed"]
        wait_timeout_ms = max(0, min(int(timeout or 30000), 600000))

        if block and not completed:
            return success_result(
                content={
                    **content,
                    "background_task_id": str(task_id),
                    "suggest_wait": True,
                    "wait_timeout_ms": wait_timeout_ms,
                },
                summary=f"后台任务 {task_id} 仍在运行，已进入等待",
                output_type="json",
                metadata={
                    "background_task_id": str(task_id),
                    "suggest_wait": True,
                    "wait_timeout_ms": wait_timeout_ms,
                },
                tool_name="task_output",
            )

        summary = f"后台任务 {task_id} 当前状态：{content['status']}"
        if completed:
            summary = f"后台任务 {task_id} 已完成，状态：{content['status']}"
        return success_result(
            content=content,
            summary=summary,
            output_type="json",
            metadata={
                "task_id": str(task_id),
                "status": content["status"],
                "completed": completed,
            },
            tool_name="task_output",
        )
    except Exception as e:
        return error_result(f"读取后台任务失败: {e}", tool_name="task_output")


@tool(
    name="task_stop",
    description="停止后台任务。若任务已完成或不支持取消，会返回明确状态说明。",
    parameters={
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "后台任务 ID"},
        },
        "required": ["task_id"],
    },
    risk_level=RiskLevel.MEDIUM,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "停止后台任务的结果",
        "shape": {
            "task_id": "string",
            "found": "boolean",
            "stop_requested": "boolean",
            "current_status": "string|null",
            "cancel_supported": "boolean",
        },
    },
    source="task",
)
def task_stop(
    task_id: str,
    session_id: Optional[str] = None,
    **_kwargs: Any,
) -> Any:
    del session_id
    try:
        bg_manager = get_background_task_manager()
        snapshot = bg_manager.get_task_snapshot(str(task_id))
        if snapshot is None:
            return error_result(f"后台任务 {task_id} 不存在", tool_name="task_stop")

        if snapshot.get("status") in {"completed", "failed", "cancelled"}:
            return success_result(
                content={
                    "task_id": str(task_id),
                    "found": True,
                    "stop_requested": False,
                    "previous_status": snapshot.get("status"),
                    "current_status": snapshot.get("status"),
                    "cancel_supported": snapshot.get("cancel_supported", False),
                },
                summary=f"后台任务 {task_id} 已结束，无需停止",
                output_type="json",
                metadata={"task_id": str(task_id), "status": snapshot.get("status")},
                tool_name="task_stop",
            )

        if not snapshot.get("cancel_supported", False):
            return error_result(
                f"后台任务 {task_id} 当前类型不支持可靠停止",
                tool_name="task_stop",
                metadata={"task_id": str(task_id), "status": snapshot.get("status")},
            )

        stopped = bg_manager.cancel(str(task_id))
        updated = bg_manager.get_task_snapshot(str(task_id)) or snapshot
        if not stopped:
            return error_result(
                f"后台任务 {task_id} 停止失败",
                tool_name="task_stop",
                metadata={"task_id": str(task_id), "status": updated.get("status")},
            )

        return success_result(
            content={
                "task_id": str(task_id),
                "found": True,
                "stop_requested": True,
                "previous_status": snapshot.get("status"),
                "current_status": updated.get("status"),
                "cancel_supported": updated.get("cancel_supported", False),
            },
            summary=f"已请求停止后台任务 {task_id}",
            output_type="json",
            metadata={"task_id": str(task_id), "status": updated.get("status")},
            tool_name="task_stop",
        )
    except Exception as e:
        return error_result(f"停止后台任务失败: {e}", tool_name="task_stop")


# ── task_list ────────────────────────────────────────────────────


@tool(
    name="task_list",
    description=(
        "列出当前 session 所有任务的摘要，含 id / subject / status / owner / blocked_by。"
        "blocked_by 字段只保留状态不为 completed 的阻塞任务 ID。"
        "内部任务（metadata._internal=true）不返回。"
        "优先处理 ID 最小的未阻塞任务。"
    ),
    parameters={
        "type": "object",
        "properties": {},
        "required": [],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "任务摘要列表",
        "shape": {
            "tasks": [
                {
                    "id": "string",
                    "subject": "string",
                    "status": "string",
                    "owner": "string",
                    "blocked_by": "list[string]",
                }
            ]
        },
    },
    source="task",
)
def task_list(
    session_id: Optional[str] = None,
    **_kwargs: Any,
) -> Any:
    try:
        sid = (session_id or "").strip() or "default"
        all_tasks = list_tasks(session_id=sid)

        # 构建 status 快查表（用于 blocked_by 过滤）
        status_map: dict[str, str] = {t["id"]: t.get("status", "") for t in all_tasks}

        summaries = []
        for task in all_tasks:
            # 跳过内部任务
            if task.get("metadata", {}).get("_internal"):
                continue
            # blocked_by 只保留未完成的阻塞者
            active_blockers = [
                bid
                for bid in task.get("blocked_by", [])
                if status_map.get(str(bid), "") != "completed"
            ]
            summaries.append({
                "id": task["id"],
                "subject": task.get("subject", ""),
                "status": task.get("status", "pending"),
                "owner": task.get("owner", ""),
                "blocked_by": active_blockers,
            })

        return success_result(
            content={"tasks": summaries},
            summary=f"共 {len(summaries)} 个任务",
            output_type="json",
            metadata={"count": len(summaries), "session_id": sid},
            tool_name="task_list",
        )
    except Exception as e:
        return error_result(f"列出任务失败: {e}", tool_name="task_list")
