# -*- coding: utf-8 -*-
"""
Bash 命令安全校验与分类模块

参考 Claude Code BashTool 适配，提供：
- 命令分类（READ_ONLY / WRITE / DESTRUCTIVE / NETWORK / INTERPRETER）
- 12 项安全规则检查
- 权限规则（替代白名单）
"""

from __future__ import annotations

import re
import shlex
from enum import Enum
from pathlib import Path
from typing import Optional


class CommandCategory(str, Enum):
    READ_ONLY = "read_only"      # grep/find/cat/ls/head/tail/wc...
    WRITE = "write"              # tee/cp/mv/mkdir/sed -i...
    DESTRUCTIVE = "destructive"  # rm/dd/mkfs...
    NETWORK = "network"          # curl/wget/ssh...
    INTERPRETER = "interpreter"  # python/node/bash/sh...
    UNKNOWN = "unknown"          # 无法分类


# ── 各分类的命令集 ────────────────────────────────────────────

_READ_ONLY_CMDS = frozenset({
    "grep", "find", "cat", "ls", "head", "tail", "wc",
    "echo", "sort", "uniq", "cut", "awk", "diff", "comm",
    "paste", "column", "tr", "xargs",
    "pwd", "which", "whereis", "realpath", "dirname", "basename",
    "file", "stat", "du", "df",
    "env", "printenv", "date", "uname", "id", "whoami",
    "ps", "top", "htop", "free", "uptime",
    "less", "more", "strings", "od", "xxd",
    "md5sum", "sha1sum", "sha256sum",
    "jq", "yq", "xmllint",
    # 注意：tar/zip/unzip/gzip/gunzip 按参数单独分类，见 classify_command
})

_WRITE_CMDS = frozenset({
    "cp", "mv", "mkdir", "rmdir", "touch", "chmod", "chown",
    "ln", "tee", "install",
    # 以下命令按参数单独分类（见 classify_command），默认视为写操作
    "sed", "tar", "zip", "unzip", "gzip", "gunzip",
})

_DESTRUCTIVE_CMDS = frozenset({
    "rm", "dd", "shred", "wipe",
    "format", "mkfs", "del", "fdisk", "parted",
    "truncate",
})
_DESTRUCTIVE_PREFIXES = ("mkfs.",)

_NETWORK_CMDS = frozenset({
    "curl", "wget", "ssh", "scp", "sftp", "rsync",
    "nc", "netcat", "ncat", "telnet", "ftp",
    "ping", "traceroute", "nslookup", "dig",
    "git", "svn", "hg",
})

_INTERPRETER_CMDS = frozenset({
    "python", "python3", "python2",
    "node", "nodejs", "deno", "bun",
    "ruby", "perl", "php", "lua",
    "bash", "sh", "zsh", "fish", "dash", "ksh",
    "powershell", "pwsh", "cmd",
    "java", "javac", "scala", "groovy",
    "go", "rustc", "cargo",
    "npm", "yarn", "pnpm", "pip", "pip3",
    "make", "cmake", "ninja",
    "docker", "podman", "kubectl", "helm",
    "sudo", "su", "doas",
    "kill", "pkill", "killall",
    "shutdown", "reboot", "halt", "poweroff",
    "crontab", "at", "batch",
    "mount", "umount",
    "iptables", "ufw", "firewall-cmd",
    "systemctl", "service", "init",
    "useradd", "userdel", "usermod", "passwd", "groupadd",
})


def classify_command(cmd_name: str, tokens: list[str] | None = None) -> CommandCategory:
    """
    对单个命令名进行分类。

    tokens 为完整命令 token 列表（含命令名本身），传 None 时按保守最高风险处理。
    """
    name = Path(cmd_name).name.lower()
    token_list = tokens or []
    # 去掉命令名本身，只看参数
    args = token_list[1:]
    # 短选项集合（如 -tvf → {'t','v','f'}）及长选项集合
    short_flags: set[str] = set()
    long_flags: set[str] = set()
    for t in args:
        if t.startswith("--"):
            long_flags.add(t.lstrip("-"))
        elif t.startswith("-") and len(t) > 1:
            short_flags.update(t[1:])

    if name == "sed":
        # -i 开启原地编辑；-i.bak / -i '' 也满足 startswith("-i") 且 len>2
        if "i" in short_flags or any(
            t == "-i" or (t.startswith("-i") and not t.startswith("--"))
            for t in args
        ):
            return CommandCategory.WRITE
        return CommandCategory.READ_ONLY

    if name == "tar":
        # -t / --list → 只列出内容；-x / -c / -r / -u / -d / -A → 写
        write_ops = short_flags & {"x", "c", "r", "u", "d", "A"}
        write_ops |= long_flags & {"extract", "get", "create", "append", "update", "delete", "concatenate"}
        list_ops = short_flags & {"t"} | long_flags & {"list"}
        if list_ops and not write_ops:
            return CommandCategory.READ_ONLY
        return CommandCategory.WRITE

    if name == "zip":
        # zip -l 列出内容 → 只读；其余情况默认写
        if "l" in short_flags or "list" in long_flags or "show-stored-files" in long_flags:
            return CommandCategory.READ_ONLY
        return CommandCategory.WRITE

    if name == "unzip":
        # unzip -l / -v 列出内容 → 只读；其余解压为写
        if "l" in short_flags or "v" in short_flags:
            return CommandCategory.READ_ONLY
        return CommandCategory.WRITE

    if name == "gzip":
        # gzip -l / -t 查询/测试 → 只读；其余压缩为写
        if "l" in short_flags or "t" in short_flags or "list" in long_flags or "test" in long_flags:
            return CommandCategory.READ_ONLY
        return CommandCategory.WRITE

    if name == "gunzip":
        # gunzip 总是解压并删除源文件
        return CommandCategory.WRITE

    if name in _INTERPRETER_CMDS:
        return CommandCategory.INTERPRETER
    if name in _DESTRUCTIVE_CMDS or any(name.startswith(p) for p in _DESTRUCTIVE_PREFIXES):
        return CommandCategory.DESTRUCTIVE
    if name in _NETWORK_CMDS:
        return CommandCategory.NETWORK
    if name in _WRITE_CMDS:
        return CommandCategory.WRITE
    if name in _READ_ONLY_CMDS:
        return CommandCategory.READ_ONLY
    return CommandCategory.UNKNOWN


def classify_command_name(name: str) -> CommandCategory:
    """
    对单个命令名（无参数上下文）按保守最高风险分类。

    用于对 approval_commands 列表中的单个命令名分类，此时没有参数信息，
    因此 tar/zip/sed 等按写操作（最坏情况）返回。
    """
    return classify_command(name, tokens=None)


def classify_pipeline(command: str) -> CommandCategory:
    """对整条命令（可含管道和链式操作符）取最高风险分类。"""
    segments = _split_shell_chain(command)
    highest = CommandCategory.READ_ONLY
    priority = [
        CommandCategory.INTERPRETER,
        CommandCategory.DESTRUCTIVE,
        CommandCategory.NETWORK,
        CommandCategory.WRITE,
        CommandCategory.UNKNOWN,
        CommandCategory.READ_ONLY,
    ]

    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            tokens = seg.split()
        if not tokens:
            continue
        cat = classify_command(tokens[0], tokens)
        if priority.index(cat) < priority.index(highest):
            highest = cat
    return highest


# ── 12 项安全检查 ─────────────────────────────────────────────

# 安全的 stderr 重定向（检查前先剥离）
_SAFE_STDERR_RE = re.compile(r'2>\s*/dev/null|2>&1')

# 控制字符（不含普通空白）
_CONTROL_CHAR_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')

# Unicode 伪空格
_UNICODE_SPACE_RE = re.compile(r'[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]')

# 混淆 flags：如 --x=$(...) 或 -e$(...)
_OBFUSCATED_FLAG_RE = re.compile(r'--?\w+=.*\$\(|--?\w+=.*`')

# 危险变量
_DANGEROUS_VARS = re.compile(
    r'\b(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONPATH|DYLD_INSERT_LIBRARIES'
    r'|IFS|BASH_ENV|ENV|PROMPT_COMMAND|PS1|PS2)\s*='
)

# /proc/*/environ 访问
_PROC_ENVIRON_RE = re.compile(r'/proc/[^/]*/environ')

# 花括号展开攻击：{a,b,c} 含 ../
_BRACE_TRAVERSAL_RE = re.compile(r'\{[^}]*\.\.[^}]*\}')


def validate_command_security(command: str) -> tuple[bool, Optional[str]]:
    """
    执行 12 项安全规则检查。

    Returns:
        (passed, error_message) — passed=True 表示通过
    """
    # 先剥离安全 stderr 重定向，避免误报
    stripped = _SAFE_STDERR_RE.sub('', command)

    # 1. 命令替换 $() / 反引号
    if '$(' in stripped or '`' in stripped:
        return False, "禁止命令替换: $() 或反引号"

    # 2. 危险写重定向 > 或 >> （不含已剥离的 2>/dev/null）
    if re.search(r'(?<![12&])>(?!>?\s*/dev/null)', stripped):
        return False, "禁止写重定向操作符: > 或 >>"

    # 3. IFS 注入
    if re.search(r'\bIFS\s*=', stripped):
        return False, "禁止修改 IFS 变量"

    # 4. 控制字符 / null bytes
    if _CONTROL_CHAR_RE.search(command):
        return False, "禁止包含控制字符或 null byte"

    # 5. Unicode 伪空格
    if _UNICODE_SPACE_RE.search(command):
        return False, "禁止包含 Unicode 伪空格字符"

    # 6. 混淆 flags
    if _OBFUSCATED_FLAG_RE.search(stripped):
        return False, "禁止在 flag 参数中嵌入命令替换"

    # 7. 危险变量赋值
    if _DANGEROUS_VARS.search(stripped):
        return False, "禁止修改危险环境变量（PATH/LD_PRELOAD 等）"

    # 8. 换行隐藏命令
    if '\n' in command or '\r' in command:
        return False, "禁止在命令中包含换行符"

    # 9. 花括号展开路径穿越
    if _BRACE_TRAVERSAL_RE.search(stripped):
        return False, "禁止花括号展开中包含路径穿越"

    # 10. /proc/*/environ 访问
    if _PROC_ENVIRON_RE.search(stripped):
        return False, "禁止访问 /proc/*/environ"

    # 11. 反斜杠转义换行（可隐藏命令）
    if re.search(r'\\[\n\r]', command):
        return False, "禁止反斜杠转义换行"

    return True, None


# ── 辅助：管道分割 ────────────────────────────────────────────

def _split_shell_pipeline(command: str) -> list[str]:
    """按 | 分段，忽略引号内的 |。"""
    segments: list[str] = []
    current: list[str] = []
    in_single = False
    in_double = False
    escaped = False

    for ch in command:
        if escaped:
            current.append(ch)
            escaped = False
            continue
        if ch == '\\' and not in_single:
            current.append(ch)
            escaped = True
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            current.append(ch)
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            current.append(ch)
            continue
        if ch == '|' and not in_single and not in_double:
            segments.append(''.join(current))
            current = []
            continue
        current.append(ch)

    segments.append(''.join(current))
    return segments


def _split_shell_chain(command: str) -> list[str]:
    """
    按 ;、&&、|| 分段（忽略引号内），再对每段按管道分段。

    返回所有原子命令段的列表，供分类和审批覆盖链式命令。
    """
    # 第一步：按 ;、&&、|| 分段
    chain_segments: list[str] = []
    current: list[str] = []
    in_single = False
    in_double = False
    escaped = False
    i = 0
    s = command

    while i < len(s):
        ch = s[i]
        if escaped:
            current.append(ch)
            escaped = False
            i += 1
            continue
        if ch == '\\' and not in_single:
            current.append(ch)
            escaped = True
            i += 1
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            current.append(ch)
            i += 1
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            current.append(ch)
            i += 1
            continue
        if not in_single and not in_double:
            # 检测 && 或 ||
            if s[i:i+2] in ('&&', '||'):
                chain_segments.append(''.join(current))
                current = []
                i += 2
                continue
            # 检测 ; (排除 2> 中的 stderr 重定向不影响，但 ; 不是 stderr 相关字符)
            if ch == ';':
                chain_segments.append(''.join(current))
                current = []
                i += 1
                continue
        current.append(ch)
        i += 1

    chain_segments.append(''.join(current))

    # 第二步：对每个链段再按管道分段
    result: list[str] = []
    for seg in chain_segments:
        result.extend(_split_shell_pipeline(seg))
    return result


# ── 权限规则映射 ──────────────────────────────────────────────

from tools.contracts.permissions import RiskLevel  # noqa: E402


def get_category_risk(category: CommandCategory) -> RiskLevel:
    """根据分类返回对应的风险等级。"""
    return {
        CommandCategory.READ_ONLY: RiskLevel.LOW,
        CommandCategory.WRITE: RiskLevel.MEDIUM,
        CommandCategory.DESTRUCTIVE: RiskLevel.HIGH,
        CommandCategory.NETWORK: RiskLevel.HIGH,
        CommandCategory.INTERPRETER: RiskLevel.HIGH,
        CommandCategory.UNKNOWN: RiskLevel.MEDIUM,
    }[category]


def get_category_label(category: CommandCategory) -> str:
    return {
        CommandCategory.READ_ONLY: "只读命令",
        CommandCategory.WRITE: "写操作命令",
        CommandCategory.DESTRUCTIVE: "破坏性命令",
        CommandCategory.NETWORK: "网络命令",
        CommandCategory.INTERPRETER: "解释器/系统控制命令",
        CommandCategory.UNKNOWN: "未知命令",
    }[category]


__all__ = [
    "CommandCategory",
    "classify_command",
    "classify_command_name",
    "classify_pipeline",
    "validate_command_security",
    "get_category_risk",
    "get_category_label",
    "_split_shell_pipeline",
    "_split_shell_chain",
]
