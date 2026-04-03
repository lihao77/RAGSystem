# -*- coding: utf-8 -*-
"""
Bash 命令执行工具

重构目标：
- 用“命令分类 + 安全规则”替代白名单
- 支持后台执行
- 长命令前台执行期间上报 TOOL_PROGRESS
- 返回结构化结果
"""

from __future__ import annotations

import logging
import os
import platform
import shlex
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

from execution.observability import get_current_execution_observability_fields
from tools.contracts.permissions import RiskLevel
from tools.decorators import tool
from tools.paths.path_resolution import (
    get_session_sandbox_root,
    get_session_transient_root,
    resolve_managed_directory,
    to_display_path,
)
from tools.runtime.approvals import request_inline_approval
from tools.runtime.background_tasks import get_background_task_manager
from tools.runtime.bash_security import (
    CommandCategory,
    _split_shell_chain,
    _split_shell_pipeline,
    classify_command_name,
    classify_pipeline,
    get_category_label,
    get_category_risk,
    validate_command_security,
)
from tools.runtime.persistent_shell import get_persistent_shell_manager
from tools.runtime.response_builder import error_result, success_result

logger = logging.getLogger(__name__)

_MAX_TIMEOUT = 600
_DEFAULT_TIMEOUT = 120
_MAX_OUTPUT = 50000


def _find_bash_executable() -> Optional[str]:
    if platform.system() != "Windows":
        return None
    git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    if git_bash.exists():
        return str(git_bash)
    return shutil.which("bash")


_BASH_EXECUTABLE = _find_bash_executable()

VALIDATION_ALLOWED = "allowed"
VALIDATION_APPROVAL_REQUIRED = "approval_required"
VALIDATION_BLOCKED = "blocked"


def _validate_command(command: str) -> tuple[str, str, list[str], CommandCategory]:
    """
    校验命令安全性并分类。

    Returns:
        (status, error_message, approval_commands, classification)
    """
    passed, error = validate_command_security(command)
    if not passed:
        return VALIDATION_BLOCKED, error or "命令安全检查失败", [], CommandCategory.UNKNOWN

    approval_commands: list[str] = []
    seg_categories: list[CommandCategory] = []
    for seg in _split_shell_chain(command):
        seg = seg.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            tokens = seg.split()
        if not tokens:
            continue
        cmd_name = Path(tokens[0]).name
        category = classify_pipeline(seg)
        seg_categories.append(category)
        if category != CommandCategory.READ_ONLY and cmd_name not in approval_commands:
            approval_commands.append(cmd_name)

    # 整体分类取各段最高风险，避免对完整 command 重复调用 classify_pipeline
    _CATEGORY_ORDER = [
        CommandCategory.READ_ONLY,
        CommandCategory.WRITE,
        CommandCategory.UNKNOWN,
        CommandCategory.NETWORK,
        CommandCategory.INTERPRETER,
        CommandCategory.DESTRUCTIVE,
    ]
    _FALLBACK_INDEX = _CATEGORY_ORDER.index(CommandCategory.UNKNOWN)  # 未知类别默认为 UNKNOWN 风险级别
    if seg_categories:
        classification = max(seg_categories, key=lambda c: _CATEGORY_ORDER.index(c) if c in _CATEGORY_ORDER else _FALLBACK_INDEX)
    else:
        classification = classify_pipeline(command)

    if approval_commands:
        return (
            VALIDATION_APPROVAL_REQUIRED,
            f"命令需要用户审批后才能执行: {', '.join(approval_commands)}",
            approval_commands,
            classification,
        )
    return VALIDATION_ALLOWED, "", [], classification



def _resolve_work_dir(
    working_dir: Optional[str],
    *,
    working_dir_space: Optional[str] = None,
    session_id: Optional[str] = None,
    workspace_root: Optional[str] = None,
    run_id: Optional[str] = None,
) -> tuple[bool, str, Optional[Path]]:
    raw_working_dir = None if working_dir is None else str(working_dir).strip()
    requested_dir = raw_working_dir if raw_working_dir else "."
    try:
        resolved = resolve_managed_directory(
            requested_dir,
            session_id=session_id,
            run_id=run_id,
            caller="direct",
            workspace_root=workspace_root,
            explicit_space=working_dir_space,
            default_space="workspace",
        )
    except ValueError as exc:
        message = str(exc)
        if "workspace 路径缺少可用目录" in message:
            message = "bash 默认工作目录为 workspace，但当前缺少可用 workspace 上下文"
        return False, message, None
    except PermissionError as exc:
        return False, str(exc), None

    if not resolved.exists():
        return False, f"工作目录不存在: {working_dir or requested_dir}", None
    if not resolved.is_dir():
        return False, f"路径不是目录: {working_dir or requested_dir}", None
    return True, "", resolved


def _request_bash_command_approval(
    *,
    command: str,
    approval_commands: list[str],
    classification: CommandCategory,
    working_dir: str | None,
    working_dir_space: str | None,
    cwd: Path,
    description: str,
    event_bus=None,
    session_id: str | None = None,
) -> tuple[bool, str]:
    # 使用 classify_command_name 对单个命令名保守分类（无参数上下文）
    dangerous_commands = [
        cmd for cmd in approval_commands
        if classify_command_name(cmd) in {
            CommandCategory.DESTRUCTIVE,
            CommandCategory.NETWORK,
            CommandCategory.INTERPRETER,
        }
    ]
    desc = f"execute_bash 申请执行{get_category_label(classification)}：{description or command[:120]}"
    if dangerous_commands:
        desc += "。高风险命令可能导致删除文件、下载远程内容、启动解释器/子 shell 或影响系统状态。"

    approved, note = request_inline_approval(
        event_bus=event_bus,
        session_id=session_id,
        tool_name="execute_bash",
        approval_type="bash_command",
        arguments={
            "command": command,
            "working_dir": working_dir if working_dir is not None else ".",
            "working_dir_space": working_dir_space or "workspace",
            "description": description or "",
            "classification": classification.value,
            "command_segments": approval_commands,
            "dangerous_command_segments": dangerous_commands,
        },
        risk_level=get_category_risk(classification).value,
        description=desc,
    )
    return approved, note or ""



def _publish_progress(event_bus, session_id: Optional[str], *, command: str, elapsed: float, cwd: Path):
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
                "working_dir": str(cwd),
            },
        ))
    except Exception as exc:
        logger.debug("发布 bash 进度事件失败: %s", exc)


def _run_foreground_command(
    command: str,
    *,
    cwd: Path,
    timeout: int,
    event_bus=None,
    session_id: Optional[str] = None,
) -> tuple[str, str, int, bool]:
    env = {**os.environ, "LC_ALL": "C.UTF-8"}
    interrupted = False

    if _BASH_EXECUTABLE:
        proc = subprocess.Popen(
            [_BASH_EXECUTABLE, "-c", command],
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
    else:
        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )

    started_at = time.monotonic()
    last_progress = started_at

    try:
        while True:
            try:
                stdout, stderr = proc.communicate(timeout=0.2)
                return stdout or "", stderr or "", proc.returncode or 0, interrupted
            except subprocess.TimeoutExpired:
                now = time.monotonic()
                elapsed = now - started_at
                if elapsed >= timeout:
                    interrupted = True
                    proc.kill()
                    stdout, stderr = proc.communicate()
                    return stdout or "", stderr or "", proc.returncode or -1, interrupted
                if now - last_progress >= 2.0:
                    _publish_progress(event_bus, session_id, command=command, elapsed=elapsed, cwd=cwd)
                    last_progress = now
    finally:
        try:
            if proc.poll() is None:
                proc.kill()
        except Exception:
            pass


@tool(
    name="execute_bash",
    description="执行 bash 命令。基于命令分类和安全规则决定风险：只读命令直接执行，写操作/未知命令通常需审批，破坏性/网络/解释器命令为高风险审批。支持后台执行、超时控制和进度事件。",
    parameters={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "要执行的 bash 命令。禁止使用命令替换、写重定向、换行隐藏命令。链式命令（&&/||/;）中每段独立分类和审批。",
            },
            "working_dir": {
                "type": "string",
                "description": "工作目录（可选）。相对目录默认按 workspace 解析。",
            },
            "working_dir_space": {
                "type": "string",
                "enum": ["workspace", "transient", "exports"],
                "description": "working_dir 的目录空间。",
            },
            "timeout": {
                "type": "integer",
                "description": "超时时间，默认 120 秒，最大 600 秒。",
                "minimum": 1,
                "maximum": 600,
            },
            "run_in_background": {
                "type": "boolean",
                "description": "是否后台执行。true 时立即返回 background_task_id。",
            },
            "description": {
                "type": "string",
                "description": "对本次命令用途的简短描述，用于审批和后台任务展示。",
            },
        },
        "required": ["command"],
    },
    risk_level=RiskLevel.HIGH,
    timeout_seconds=120,
    allowed_callers=["direct"],
    extended_usage="""### 后台执行说明

设置 `run_in_background: true` 后，命令在后台执行，立即返回 `background_task_id`。后台任务完成后，系统会发送完成事件，包含 stdout、stderr、exit_code。

**后台执行示例**：
```xml
<execute_bash>
<command>npm run build</command>
<run_in_background>true</run_in_background>
<description>构建前端项目</description>
</execute_bash>
```

返回：`{"background_task_id": "task_123"}`

### 工作目录说明

三个受管目录空间：`workspace`（默认）、`transient`（临时）、`exports`（导出）。

- 相对路径：默认按 `workspace` 解析
- 绝对路径：必须在受管目录内
- 指定空间：使用 `working_dir_space` 参数

**示例**：
```xml
<execute_bash>
<command>ls -la</command>
<working_dir>data</working_dir>
<working_dir_space>transient</working_dir_space>
</execute_bash>
```

### 安全限制

**禁止的操作**：
- 命令替换：`$(...)` 或反引号
- 写重定向：`>` 或 `>>`
- IFS 变量修改
- 危险环境变量赋值（PATH、LD_PRELOAD 等）
- 换行字符（隐藏命令）
- Brace expansion 路径遍历

**链式命令处理**：
使用 `&&`、`||`、`;` 连接的命令会独立分类。如果任何一段是高风险命令，整体需要审批。

**命令分类**：
- `READ_ONLY`：grep, ls, cat, head, tail 等 → 直接执行
- `WRITE`：cp, mv, mkdir, sed 等 → 中风险审批
- `DESTRUCTIVE`：rm, dd, shred 等 → 高风险审批
- `NETWORK`：curl, wget, ssh, git 等 → 高风险审批
- `INTERPRETER`：python, node, docker, sudo 等 → 高风险审批
- `UNKNOWN`：未知命令 → 中风险审批""",
)
def execute_bash(
    command: str,
    working_dir: str = None,
    working_dir_space: str = None,
    timeout: int = _DEFAULT_TIMEOUT,
    run_in_background: bool = False,
    description: str = "",
    session_id: str = None,
    agent_config=None,
    event_bus=None,
    caller: str = "direct",
    cancel_event: "threading.Event | None" = None,
    **kwargs,
):
    del kwargs

    timeout = max(1, min(int(timeout or _DEFAULT_TIMEOUT), _MAX_TIMEOUT))

    workspace_root = None
    if agent_config and hasattr(agent_config, "custom_params"):
        custom_params = agent_config.custom_params if isinstance(agent_config.custom_params, dict) else {}
        workspace_root = custom_params.get("workspace_root")

    current_fields = get_current_execution_observability_fields()
    run_id = current_fields.get("run_id")

    ok, dir_err, cwd = _resolve_work_dir(
        working_dir,
        working_dir_space=working_dir_space,
        session_id=session_id,
        workspace_root=workspace_root,
        run_id=run_id,
    )
    if not ok:
        return error_result(
            dir_err,
            tool_name="execute_bash",
            metadata={
                "command": command,
                "working_dir": working_dir if working_dir is not None else ".",
                "working_dir_space": working_dir_space or "workspace",
            },
        )

    validation_status, security_error, approval_commands, classification = _validate_command(command)
    if validation_status == VALIDATION_BLOCKED:
        return error_result(
            f"命令安全检查失败: {security_error}",
            tool_name="execute_bash",
            metadata={"command": command},
        )

    risk_level = get_category_risk(classification)
    approval_message = ""

    if validation_status == VALIDATION_APPROVAL_REQUIRED:
        approved, note = _request_bash_command_approval(
            command=command,
            approval_commands=approval_commands,
            classification=classification,
            working_dir=working_dir,
            working_dir_space=working_dir_space,
            cwd=cwd,
            description=description,
            event_bus=event_bus,
            session_id=session_id,
        )
        if not approved:
            return error_result(
                f"execute_bash 执行已被拒绝：{note or '用户拒绝执行此操作'}",
                tool_name="execute_bash",
                metadata={
                    "command": command,
                    "working_dir": str(cwd),
                    "classification": classification.value,
                    "approval_required_commands": approval_commands,
                },
            )
        approval_message = note or ""

    if run_in_background:
        if not session_id:
            return error_result(
                "后台执行需要 session_id（无 session_id 时无法路由完成通知）",
                tool_name="execute_bash",
                metadata={"command": command},
            )
        output_dir = get_session_transient_root(session_id)
        task = get_background_task_manager().spawn_bash(
            command,
            bash_executable=_BASH_EXECUTABLE,
            cwd=cwd,
            output_dir=output_dir,
            description=description or command[:80],
            max_runtime_seconds=timeout,
            event_bus=event_bus,
            session_id=session_id,
        )
        return success_result(
            content={
                "stdout": "",
                "stderr": "",
                "return_code": None,
                "interrupted": False,
                "background_task_id": task.task_id,
                "classification": classification.value,
            },
            summary="后台任务已启动",
            output_type="json",
            metadata={
                "command": command,
                "working_dir": str(cwd),
                "classification": classification.value,
                "risk_level": risk_level.value,
                "background_task_id": task.task_id,
                "background_output_path": to_display_path(task.output_path),
                "cwd_isolated": caller != "direct",
                **({"approval_required_commands": approval_commands} if approval_commands else {}),
                **({"approval_message": approval_message} if approval_message else {}),
            },
            tool_name="execute_bash",
        )

    try:
        if session_id:
            shell = get_persistent_shell_manager().get_session(
                session_id,
                event_bus=event_bus,
                bash_executable=_BASH_EXECUTABLE,
            )
            cd_prefix = f"cd '{cwd}' && " if cwd else ""
            stdout, stderr, return_code, interrupted = shell.execute(
                cd_prefix + command,
                timeout=timeout,
                cancel_event=cancel_event,
                event_bus=event_bus,
                session_id=session_id,
            )
        else:
            stdout, stderr, return_code, interrupted = _run_foreground_command(
                command,
                cwd=cwd,
                timeout=timeout,
                event_bus=event_bus,
                session_id=session_id,
            )
    except Exception as exc:
        return error_result(f"命令执行失败: {exc}", tool_name="execute_bash")

    truncated = False
    if len(stdout) > _MAX_OUTPUT:
        stdout = stdout[:_MAX_OUTPUT]
        truncated = True
    if len(stderr) > 2000:
        stderr = stderr[:2000]

    content = {
        "stdout": stdout,
        "stderr": stderr,
        "return_code": return_code,
        "interrupted": interrupted,
        "background_task_id": None,
        "classification": classification.value,
    }
    summary = f"命令执行完成，返回码 {return_code}"
    if interrupted:
        summary = f"命令执行超时（{timeout} 秒），进程已终止"
    elif truncated:
        summary += "（stdout 已截断）"

    return success_result(
        content=content,
        summary=summary,
        output_type="json",
        metadata={
            "command": command,
            "working_dir": str(cwd),
            "classification": classification.value,
            "risk_level": risk_level.value,
            "truncated": truncated,
            "cwd_isolated": caller != "direct",
            **({"approval_required_commands": approval_commands} if approval_commands else {}),
            **({"approval_message": approval_message} if approval_message else {}),
        },
        tool_name="execute_bash",
    )
