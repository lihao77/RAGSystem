# -*- coding: utf-8 -*-
"""
受限 Bash 命令执行工具

提供只读类 shell 命令执行能力，用于搜索文件内容、统计行数、定位关键信息。
- 命令白名单：仅允许 grep/find/head/tail/wc/cat/ls/echo/sort/uniq/cut/awk/sed
- 管道安全：逐段检查，禁止非白名单命令出现在管道中
- 禁止重定向写入（> >>）
- 工作目录限制：仅限项目数据目录
- 超时保护：30 秒
"""

import logging
import os
import platform
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
_DEFAULT_WORK_DIR = _BACKEND_DIR / "data"


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
    "grep", "find", "head", "tail", "wc", "cat", "ls",
    "echo", "sort", "uniq", "cut", "awk", "sed",
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

def _validate_command(command: str) -> tuple[bool, str]:
    """
    校验命令安全性。

    Returns:
        (通过, 错误消息)
    """
    # 禁止重定向写入
    for op in _REDIRECT_OPERATORS:
        if op in command:
            return False, f"禁止使用重定向操作符: {op}"

    # 按管道分段检查
    segments = command.split("|")
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
        _DEFAULT_WORK_DIR.mkdir(parents=True, exist_ok=True)
        return True, "", _DEFAULT_WORK_DIR

    p = Path(working_dir).resolve()
    if not p.exists():
        return False, f"工作目录不存在: {working_dir}", None
    if not p.is_dir():
        return False, f"路径不是目录: {working_dir}", None
    return True, "", p

@tool(
    name="execute_bash",
    description="执行受限 bash 命令，支持 grep/find/head/tail/wc 等只读命令，用于搜索文件内容、统计行数、定位关键信息",
    parameters={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "要执行的 bash 命令（仅允许 grep/find/head/tail/wc/cat/ls/echo/sort/uniq/cut/awk/sed）",
            },
            "working_dir": {
                "type": "string",
                "description": "工作目录（可选，默认为项目数据目录）",
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
        "禁止重定向写入（> >>）",
        "管道中每段命令都必须在白名单内",
        "超时 30 秒自动终止",
    ],
    examples=[
        {"input": {"command": "grep -rn '关键词' .", "working_dir": "./data"}},
        {"input": {"command": "find . -name '*.json' | head -20"}},
        {"input": {"command": "wc -l data.csv"}},
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
        proc = subprocess.run(
            command,
            shell=True,
            executable=_BASH_EXECUTABLE,
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
