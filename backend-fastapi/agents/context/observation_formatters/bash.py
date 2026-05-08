# -*- coding: utf-8 -*-
"""
Bash 工具 Observation Formatter

只提取 LLM 需要的信息：stdout/stderr/return_code，剔除 classification、interrupted 等内部字段。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.contracts.result_models import ToolExecutionResult


class BashObservationFormatter(BaseObservationFormatter):
    """Bash 工具结果格式化器。"""

    name = "bash"
    priority = 35

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        return context.tool_name == "execute_bash" and context.mode == "inline"

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        content = result.content
        summary = result.summary or ""

        estimated_size = self._estimate_size_fast(content)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        if not isinstance(content, dict):
            return f"{summary}\n{content}" if summary else str(content)

        stdout = content.get("stdout", "")
        stderr = content.get("stderr", "")
        return_code = content.get("return_code")
        interrupted = content.get("interrupted", False)
        bg_task_id = content.get("background_task_id")

        # 后台任务
        if bg_task_id:
            parts = ["后台任务已启动", f"task_id: {bg_task_id}"]
            if summary:
                parts.insert(0, summary)
            return "\n".join(parts)

        parts = []
        if summary:
            parts.append(summary)

        # 超时中断
        if interrupted:
            if stdout:
                parts.append(stdout)
            if stderr:
                parts.append(f"[stderr]\n{stderr}")
            return "\n".join(parts)

        # 失败
        if return_code and return_code != 0:
            if stderr:
                parts.append(f"[stderr]\n{stderr}")
            if stdout:
                parts.append(f"[stdout]\n{stdout}")
            return "\n".join(parts)

        # 成功 (rc=0)
        if stdout:
            parts.append(stdout)
        if stderr:
            parts.append(f"[stderr]\n{stderr}")

        return "\n".join(parts) if parts else (summary or "命令执行完成")
