# -*- coding: utf-8 -*-
"""
受限 Bash 命令执行工具

提供只读类 shell 命令执行能力，用于搜索文件内容、统计行数、定位关键信息。
- 命令白名单：仅允许只读/无害命令（grep/find/head/tail/wc/cat/ls/echo/sort/uniq/cut/awk/sed/pwd/which/stat/file/du/df/diff 等）
- 管道安全：逐段检查，禁止非白名单命令出现在管道中
- 禁止重定向写入（> >>），允许 2>/dev/null 和 2>&1
- 默认工作目录：项目根目录（backend-fastapi/）
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
from tools.permissions import RiskLevel
from tools.response_builder import error_result, success_result

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).parent.parent.parent
_DEFAULT_WORK_DIR = _BACKEND_DIR


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

# 允许的命令白名单（只读类）
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

# 显式禁止的危险命令
BLOCKED_COMMANDS = frozenset({
    "rm", "mv", "cp", "chmod", "chown", "dd", "mkfs",
    "rmdir", "mkdir", "touch", "ln", "kill", "pkill",
    "shutdown", "reboot", "curl", "wget", "python",
    "python3", "pip", "node", "npm", "bash", "sh",
    "powershell", "cmd", "del", "format",
})

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


def _validate_command(command: str) -> tuple[bool, str]:
    """
    校验命令安全性。

    Returns:
        (通过, 错误消息)
    """
    # 先剥离安全的 stderr 重定向，再检查是否有写重定向
    stripped = _SAFE_STDERR_RE.sub('', command)
    for op in _REDIRECT_OPERATORS:
        if op in stripped:
            return False, f"禁止使用重定向操作符: {op}"

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
        if cmd_name in BLOCKED_COMMANDS:
            return False, f"禁止执行危险命令: {cmd_name}"
        if cmd_name not in ALLOWED_COMMANDS:
            return False, f"命令不在白名单中: {cmd_name}（允许: {', '.join(sorted(ALLOWED_COMMANDS))}）"

    return True, ""


def _resolve_work_dir(working_dir: Optional[str]) -> tuple[bool, str, Optional[Path]]:
    """
    解析并校验工作目录。

    Returns:
        (通过, 错误消息, 解析后的路径)
    """
    if working_dir is None:
        return True, "", _DEFAULT_WORK_DIR

    p = Path(working_dir).resolve()
    if not p.exists():
        return False, f"工作目录不存在: {working_dir}", None
    if not p.is_dir():
        return False, f"路径不是目录: {working_dir}", None
    return True, "", p

@tool(
    name="execute_bash",
    description="执行受限 bash 命令。默认工作目录为项目根目录（backend-fastapi/），可通过 working_dir 参数指定。支持 grep/find/head/tail/wc/cat/ls/echo/sort/uniq/cut/awk/sed/pwd/which/stat/file/du/df/diff/tr/xargs 等只读命令，支持管道和 2>/dev/null 屏蔽 stderr",
    parameters={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "要执行的 bash 命令（仅允许只读类命令，支持管道和 2>/dev/null、2>&1）",
            },
            "working_dir": {
                "type": "string",
                "description": "工作目录（可选，默认为项目根目录 backend-fastapi/）",
            },
        },
        "required": ["command"],
    },
    risk_level=RiskLevel.MEDIUM,
    requires_approval=False,
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
        "仅允许只读类命令，禁止 rm/mv/cp 等写操作",
        "禁止重定向写入（> >>），但允许 2>/dev/null 和 2>&1",
        "管道中每段命令都必须在白名单内",
        "默认工作目录为项目根目录（backend-fastapi/），可通过 working_dir 参数指定",
        "超时 30 秒自动终止",
    ],
    examples=[
        {"input": {"command": "grep -rn '关键词' .", "working_dir": "./data"}},
        {"input": {"command": "find . -name '*.json' | head -20"}},
        {"input": {"command": "wc -l data.csv"}},
        {"input": {"command": "pwd"}},
        {"input": {"command": "find . -name '*.py' -type f 2>/dev/null | wc -l"}},
    ],
)
def execute_bash(
    command: str,
    working_dir: str = None,
    **kwargs,
):
    """执行受限 bash 命令。"""
    # 1. 校验命令安全性
    valid, err_msg = _validate_command(command)
    if not valid:
        return error_result(err_msg, tool_name="execute_bash")

    # 2. 解析工作目录
    ok, dir_err, cwd = _resolve_work_dir(working_dir)
    if not ok:
        return error_result(dir_err, tool_name="execute_bash")

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

    return success_result(
        content=content,
        summary=summary,
        output_type="text",
        metadata={
            "return_code": proc.returncode,
            "stderr": stderr[:2000] if stderr else "",
            "command": command,
            "working_dir": str(cwd),
            "truncated": truncated,
        },
        tool_name="execute_bash",
    )
