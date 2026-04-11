# -*- coding: utf-8 -*-
"""
斜杠命令注册表与解析器。
"""

from dataclasses import dataclass
from typing import Callable, Literal


@dataclass
class CommandDefinition:
    name: str                                    # '/help', '/compact'
    mode: Literal['system', 'prompt']            # system=直接执行，prompt=展开模板走 Agent
    description: str
    template: str | None = None                  # prompt 命令模板，{args} 占位
    handler: Callable | None = None              # system 命令的 async handler(session_id, args, **kw) -> dict


_REGISTRY: dict[str, CommandDefinition] = {}


def register(defn: CommandDefinition) -> None:
    _REGISTRY[defn.name] = defn


def get_all() -> list[CommandDefinition]:
    return list(_REGISTRY.values())


def parse_slash_command(task: str) -> tuple[CommandDefinition | None, str, str] | None:
    """解析斜杠命令，返回 (definition | None, command_name, args) 或 None。"""
    stripped = task.strip()
    if not stripped.startswith('/'):
        return None
    parts = stripped.split(None, 1)
    cmd_name = parts[0].lower()
    args = parts[1] if len(parts) > 1 else ''
    return (_REGISTRY.get(cmd_name), cmd_name, args)
