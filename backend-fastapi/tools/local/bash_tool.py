# -*- coding: utf-8 -*-
"""
受限 Bash 命令执行工具

提供只读类 shell 命令执行能力，用于搜索文件内容、统计行数、定位关键信息。
- 命令策略：白名单命令直接执行；非白名单命令先审批，通过后仅本次放行
- 管道安全：逐段检查；若包含非白名单命令则整体进入审批
- 禁止重定向写入（> >>），允许 2>/dev/null 和 2>&1
- 默认工作目录：当前 effective workspace
- 路径语义：working_dir 与 direct 文件工具共享 space="workspace|transient|exports"
- 超时保护：30 秒
"""

import logging
import os
import platform
import re
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from tools.decorators import tool
from tools.contracts.permissions import RiskLevel
from tools.runtime.response_builder import error_result, success_result

logger = logging.getLogger(__name__)

from tools.paths.path_resolution import resolve_managed_directory
from execution.observability import get_current_execution_observability_fields


def _find_bash_executable() -> Optional[str]:
    """在 Windows 上查找 bash 可执行文件路径，非 Windows 返回 None（使用系统默认）。"""
    if platform.system() != "Windows":
        return None
    # 优先 Git Bash
    git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    if git_bash.exists():
        return str(git_bash)
    # fallback: PATH 中查找
    found = shutil.which("bash")
    return found


_BASH_EXECUTABLE = _find_bash_executable()

# 允许的命令白名单（无需审批，直接执行）
ALLOWED_COMMANDS = frozenset({
    # 文件搜索与内容查看
    "grep", "find", "head", "tail", "wc", "cat", "ls",
    "echo", "sort", "uniq", "cut", "awk", "sed",
    # 路径与环境
    "pwd", "which", "whereis", "realpath", "dirname", "basename",
    # 文件信息
    "file", "stat", "du", "df",
    # 文本处理
    "tr", "tee", "xargs", "diff", "comm", "paste", "column",
    # 其他只读
    "env", "printenv", "date", "uname",
})

# 高风险命令：不再硬拒绝，但审批时需要更强提示
DANGEROUS_APPROVAL_COMMANDS = frozenset({
    "rm", "rmdir", "dd", "format", "del",
    "curl", "wget",
    "python", "python3", "node", "npm", "pip",
    "bash", "sh", "powershell", "cmd",
    "shutdown", "reboot", "kill", "pkill",
})
DANGEROUS_APPROVAL_COMMAND_PREFIXES = ("mkfs.",)

VALIDATION_ALLOWED = "allowed"
VALIDATION_APPROVAL_REQUIRED = "approval_required"
VALIDATION_BLOCKED = "blocked"

# 禁止的重定向操作符
_REDIRECT_OPERATORS = {">", ">>"}

# 安全的 stderr 重定向模式（剥离后再检查写重定向）
_SAFE_STDERR_RE = re.compile(r'2>\s*/dev/null|2>&1')


def _split_shell_pipeline(command: str) -> list[str]:
    """按真正的 shell 管道符分段，忽略引号内或被转义的 |。"""
    segments: list[str] = []
    current: list[str] = []
    in_single_quote = False
    in_double_quote = False
    escaped = False

    for ch in command:
        if escaped:
            current.append(ch)
            escaped = False
            continue

        if ch == "\\" and not in_single_quote:
            current.append(ch)
            escaped = True
            continue

        if ch == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
            current.append(ch)
            continue

        if ch == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
            current.append(ch)
            continue

        if ch == "|" and not in_single_quote and not in_double_quote:
            segments.append("".join(current))
            current = []
            continue

        current.append(ch)

    segments.append("".join(current))
    return segments


def _is_dangerous_approval_command(cmd_name: str) -> bool:
    return cmd_name in DANGEROUS_APPROVAL_COMMANDS or any(
        cmd_name.startswith(prefix) for prefix in DANGEROUS_APPROVAL_COMMAND_PREFIXES
    )


def _validate_command(command: str) -> tuple[str, str, list[str]]:
    """
    校验命令安全性。

    Returns:
        (分类结果, 消息, 需要审批的命令列表)
    """
    # 先剥离安全的 stderr 重定向，再检查是否有写重定向
    stripped = _SAFE_STDERR_RE.sub('', command)
    for op in _REDIRECT_OPERATORS:
        if op in stripped:
            return VALIDATION_BLOCKED, f"禁止使用重定向操作符: {op}", []

    approval_commands: list[str] = []

    # 按真正的 shell 管道分段检查
    segments = _split_shell_pipeline(command)
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            # shlex 解析失败，尝试简单空格分割
            tokens = seg.split()
        if not tokens:
            continue

        cmd_name = Path(tokens[0]).name  # 处理 /usr/bin/grep 这种路径
        if cmd_name not in ALLOWED_COMMANDS and cmd_name not in approval_commands:
            approval_commands.append(cmd_name)

    if approval_commands:
        return (
            VALIDATION_APPROVAL_REQUIRED,
            f"命令需要用户审批后才能执行: {', '.join(approval_commands)}",
            approval_commands,
        )

    return VALIDATION_ALLOWED, "", []


def _resolve_work_dir(
    working_dir: Optional[str],
    *,
    working_dir_space: Optional[str] = None,
    session_id: Optional[str] = None,
    workspace_root: Optional[str] = None,
    run_id: Optional[str] = None,
) -> tuple[bool, str, Optional[Path]]:
    """
    解析并校验工作目录。

    Returns:
        (通过, 错误消息, 解析后的路径)
    """
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
    working_dir: str | None,
    working_dir_space: str | None,
    cwd: Path,
    event_bus=None,
    session_id: str | None = None,
) -> tuple[bool, str, str]:
    if not event_bus:
        return False, '命令需要用户授权，但当前上下文不支持审批', ''
    if not session_id:
        return False, '命令需要用户授权，但当前上下文无法等待审批', ''

    dangerous_commands = [cmd for cmd in approval_commands if _is_dangerous_approval_command(cmd)]
    danger_summary = ''
    if dangerous_commands:
        danger_summary = (
            '【高风险命令】本次申请包含潜在危险操作：'
            + ', '.join(dangerous_commands)
            + '。这类命令可能导致删除文件、下载远程内容、启动解释器/子 shell、终止进程或影响系统状态，请谨慎确认。'
        )

    try:
        import uuid as _uuid
        from agents.events import Event, EventType
        from agents.task_registry import get_task_registry
        from utils.timeout_pause import pause_current, resume_current

        approval_id = str(_uuid.uuid4())
        registry = get_task_registry()
        wait_evt = registry.add_pending_approval(session_id, approval_id)

        event_bus.publish(Event(
            type=EventType.USER_APPROVAL_REQUIRED,
            session_id=session_id,
            data={
                'approval_id': approval_id,
                'tool_name': 'execute_bash',
                'approval_type': 'bash_command',
                'arguments': {
                    'command': command,
                    'working_dir': working_dir if working_dir is not None else '.',
                    'working_dir_space': working_dir_space or 'workspace',
                },
                'risk_level': RiskLevel.HIGH.value if dangerous_commands else RiskLevel.MEDIUM.value,
                'description': (
                    f"execute_bash 申请临时放行非白名单命令：{', '.join(approval_commands)}"
                    + (f"\n{danger_summary}" if danger_summary else '')
                ),
                'command': command,
                'command_segments': approval_commands,
                'dangerous_command_segments': dangerous_commands,
                'working_dir': str(cwd),
            }
        ))

        if wait_evt is None:
            return False, '命令需要用户授权，但当前上下文无法等待审批', ''

        pause_current()
        try:
            wait_evt.wait()
        finally:
            resume_current()

        approved, approval_note = registry.get_approval_result(session_id, approval_id)
        if not approved:
            deny_reason = approval_note if approval_note else '用户拒绝执行此操作'
            return False, f'execute_bash 执行已被拒绝：{deny_reason}', ''
        return True, '', approval_note or ''
    except Exception as error:
        logger.error('bash 审批流程异常: %s', error)
        return False, f'审批流程异常: {error}', ''


@tool(
    name="execute_bash",
    description="执行受限 bash 命令。白名单命令可直接执行；所有非白名单命令都会触发一次性用户审批；其中删除、远程下载、解释器/子 shell、进程控制等高风险命令会在审批提示中额外高亮。默认工作目录为当前 workspace；working_dir 支持与 direct 文件工具一致的 space=\"workspace|transient|exports\" 语义。支持管道和 2>/dev/null 屏蔽 stderr",
    parameters={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "要执行的 bash 命令。白名单命令直接执行；所有非白名单命令需审批；若涉及删除、下载、解释器、子 shell、进程控制等高风险操作，审批提示会额外高亮。支持管道和 2>/dev/null、2>&1",
            },
            "working_dir": {
                "type": "string",
                "description": "工作目录（可选）。相对目录默认按当前 workspace 解析；也可配合 XML 写法 <working_dir space=\"workspace|transient|exports\">...</working_dir> 显式指定受管目录桶。",
            },
            "working_dir_space": {
                "type": "string",
                "enum": ["workspace", "transient", "exports"],
                "description": "working_dir 的可选目录空间。仅影响相对 working_dir 的解析根；绝对路径仍只做受管边界校验。推荐通过 XML 属性 <working_dir space=\"...\">...</working_dir> 传入。",
            },
        },
        "required": ["command"],
    },
    risk_level=RiskLevel.HIGH,
    timeout_seconds=30,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "命令执行结果",
        "shape": {
            "content": "stdout 输出文本",
            "metadata": {
                "return_code": "number",
                "stderr": "string",
                "command": "string",
                "working_dir": "string",
            },
        },
    },
    usage_contract=[
        "白名单命令可直接执行；所有非白名单命令都会先请求用户审批，审批仅对本次命令生效",
        "删除、远程下载、解释器/子 shell、进程控制、系统控制等高风险命令不会再被直接拦截，但审批提示会明确高亮风险",
        "禁止重定向写入（> >>），但允许 2>/dev/null 和 2>&1",
        "管道中的任一非白名单命令都会触发整条命令审批",
        "工作目录支持 workspace/transient/exports 三个受管目录；统一规则见下方“受管目录 space 说明”",
        "working_dir_space=exports 需要当前运行上下文提供 run_id",
        "超时 30 秒自动终止",
    ],
    examples=[
        {"input": {"command": "pwd"}},
        {
            "input": {"command": "grep -rn '关键词' .", "working_dir": "."},
            "xml_attrs": {"working_dir": {"space": "workspace"}},
        },
    ],
)
def execute_bash(
    command: str,
    working_dir: str = None,
    working_dir_space: str = None,
    session_id: str = None,
    agent_config=None,
    event_bus=None,
    **kwargs,
):
    """执行受限 bash 命令。"""
    del kwargs
    workspace_root = None
    if agent_config and hasattr(agent_config, "custom_params"):
        custom_params = agent_config.custom_params if isinstance(agent_config.custom_params, dict) else {}
        workspace_root = custom_params.get("workspace_root")
    current_fields = get_current_execution_observability_fields()
    run_id = current_fields.get("run_id")

    # 1. 解析工作目录
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

    # 2. 校验命令安全性 / 触发审批
    validation_status, message, approval_commands = _validate_command(command)
    if validation_status == VALIDATION_BLOCKED:
        return error_result(message, tool_name="execute_bash")
    approval_message = ""
    if validation_status == VALIDATION_APPROVAL_REQUIRED:
        approved, approval_error, approval_message = _request_bash_command_approval(
            command=command,
            approval_commands=approval_commands,
            working_dir=working_dir,
            working_dir_space=working_dir_space,
            cwd=cwd,
            event_bus=event_bus,
            session_id=session_id,
        )
        if not approved:
            return error_result(
                approval_error,
                tool_name="execute_bash",
                metadata={
                    "command": command,
                    "working_dir": str(cwd),
                    "approval_required_commands": approval_commands,
                },
            )

    # 3. 执行命令
    logger.info("execute_bash: command=%r, cwd=%s", command, cwd)
    try:
        if _BASH_EXECUTABLE:
            # Windows: 直接调用 bash -c，避免 shell=True 路径空格问题
            proc = subprocess.run(
                [_BASH_EXECUTABLE, "-c", command],
                cwd=str(cwd),
                capture_output=True,
                text=True,
                timeout=30,
                env={**os.environ, "LC_ALL": "C.UTF-8"},
            )
        else:
            # Linux/macOS: 使用系统默认 shell
            proc = subprocess.run(
                command,
                shell=True,
                cwd=str(cwd),
                capture_output=True,
                text=True,
                timeout=30,
                env={**os.environ, "LC_ALL": "C.UTF-8"},
            )
    except subprocess.TimeoutExpired:
        return error_result("命令执行超时（超过 30 秒）", tool_name="execute_bash")
    except Exception as e:
        return error_result(f"命令执行失败: {e}", tool_name="execute_bash")

    # 4. 构建返回
    stdout = proc.stdout or ""
    stderr = proc.stderr or ""

    # 截断过长输出（保留前 50000 字符）
    max_output = 50000
    truncated = False
    if len(stdout) > max_output:
        stdout = stdout[:max_output]
        truncated = True

    content = stdout
    if not content and stderr:
        content = f"[stderr] {stderr}"

    summary = f"命令执行完成，返回码 {proc.returncode}"
    if truncated:
        summary += "（输出已截断）"

    metadata = {
        "return_code": proc.returncode,
        "stderr": stderr[:2000] if stderr else "",
        "command": command,
        "working_dir": str(cwd),
        "truncated": truncated,
    }
    if validation_status == VALIDATION_APPROVAL_REQUIRED:
        metadata["approval_required_commands"] = approval_commands
    if approval_message:
        metadata["approval_message"] = approval_message

    return success_result(
        content=content,
        summary=summary,
        output_type="text",
        metadata=metadata,
        tool_name="execute_bash",
    )
