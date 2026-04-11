# -*- coding: utf-8 -*-
"""
斜杠命令注册表与解析器。
"""

from dataclasses import dataclass
from typing import Callable, Literal, Optional


@dataclass
class CommandDefinition:
    name: str                                    # '/help', '/compact'
    mode: Literal['system', 'prompt']            # system=直接执行，prompt=展开模板走 Agent
    description: str
    template: str | None = None                  # prompt 命令模板，{args} 占位
    handler: Callable | None = None              # system 命令的 async handler(session_id, args, **kw) -> dict


@dataclass
class ParsedCommand:
    cmd_name: str
    args: str
    defn: Optional[CommandDefinition]            # None 表示命令名已识别为斜杠命令但未注册


_REGISTRY: dict[str, CommandDefinition] = {}


def register(defn: CommandDefinition) -> None:
    _REGISTRY[defn.name] = defn


def get_all() -> list[CommandDefinition]:
    return list(_REGISTRY.values())


def parse_slash_command(task: str) -> Optional[ParsedCommand]:
    """解析斜杠命令。非斜杠命令返回 None；斜杠命令返回 ParsedCommand（defn=None 表示未注册）。"""
    stripped = task.strip()
    if not stripped.startswith('/'):
        return None
    parts = stripped.split(None, 1)
    cmd_name = parts[0].lower()
    args = parts[1] if len(parts) > 1 else ''
    return ParsedCommand(cmd_name=cmd_name, args=args, defn=_REGISTRY.get(cmd_name))
