# -*- coding: utf-8 -*-
"""Agent-first memory tools backed by markdown memory store."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from agents.config import get_config_manager
from tools.contracts.permissions import RiskLevel
from tools.decorators import tool
from tools.runtime.response_builder import error_result, success_result
from services.memory_store import MemoryStore


_MEMORY_STORE = MemoryStore()


def _resolve_memory_config(agent_name: Optional[str]):
    if not agent_name:
        return None
    agent_config = get_config_manager().get_config(agent_name)
    return getattr(agent_config, 'memory', None) if agent_config else None


def _ensure_memory_enabled(tool_name: str, agent_name: Optional[str]):
    memory_config = _resolve_memory_config(agent_name)
    if memory_config is None:
        return f"当前 Agent 未启用 memory 能力: {agent_name or 'unknown'}"
    allowed_scopes = list(getattr(memory_config, 'allowed_scopes', []) or [])
    write_scopes = list(getattr(memory_config, 'write_scopes', []) or [])
    archive_scopes = list(getattr(memory_config, 'archive_scopes', []) or [])
    if not (allowed_scopes or write_scopes or archive_scopes):
        return f"当前 Agent 未启用 memory 能力: {agent_name or 'unknown'}"
    return None


def _ensure_scope_allowed(memory_config, scope: str, mode: str) -> Optional[str]:
    scope_name = (scope or '').strip().lower()
    allowed_scopes = set(getattr(memory_config, 'allowed_scopes', []) or ['project', 'session'])
    if scope_name not in allowed_scopes:
        return f"当前 Agent 不允许访问 memory scope: {scope}"
    if mode == 'write':
        write_scopes = set(getattr(memory_config, 'write_scopes', []) or [])
        if scope_name not in write_scopes:
            return f"当前 Agent 不允许写入 memory scope: {scope}"
    if mode == 'archive':
        archive_scopes = set(getattr(memory_config, 'archive_scopes', []) or [])
        if scope_name not in archive_scopes:
            return f"当前 Agent 不允许归档 memory scope: {scope}"
    return None


@tool(
    name="list_memory_index",
    description="读取指定作用域的 MEMORY.md 索引头部，让 Agent 先了解可用记忆，再决定是否读取具体记忆文件。",
    parameters={
        "type": "object",
        "properties": {
            "scope": {"type": "string", "description": "memory 作用域：project/session/agent/workspace"},
            "session_id": {"type": "string", "description": "session 作用域标识；direct/runtime 调用通常会自动注入，无需手填"},
            "agent_name": {"type": "string", "description": "agent 作用域时必填"},
            "workspace_key": {"type": "string", "description": "workspace 作用域时必填"},
        },
        "required": ["scope"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "返回 MEMORY.md 索引头部和索引文件路径",
        "shape": {
            "content": "string",
            "metadata": {
                "scope": "string",
                "index_file_path": "string",
            },
        },
    },
    usage_contract=[
        "先调用 list_memory_index 再决定是否读取具体记忆文件",
        "该工具只返回 MEMORY.md 头部，不返回所有记忆正文",
    ],
    source="decorator",
)
def list_memory_index(
    scope: str,
    session_id: Optional[str] = None,
    agent_name: Optional[str] = None,
    workspace_key: Optional[str] = None,
    current_agent_name: Optional[str] = None,
) -> Any:
    try:
        error = _ensure_memory_enabled('list_memory_index', current_agent_name)
        if error:
            return error_result(error, tool_name='list_memory_index')
        memory_config = _resolve_memory_config(current_agent_name)
        scope_error = _ensure_scope_allowed(memory_config, scope, 'read')
        if scope_error:
            return error_result(scope_error, tool_name='list_memory_index')
        scope_root = _MEMORY_STORE.ensure_scope(
            scope=scope,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
        )
        index_path = _MEMORY_STORE.get_index_path(scope_root)
        content = _MEMORY_STORE.load_index_head(
            scope=scope,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
        )
        return success_result(
            content=content,
            summary=f"已读取 {scope} MEMORY 索引",
            output_type="text",
            metadata={
                "scope": scope,
                "index_file_path": str(index_path),
            },
            tool_name="list_memory_index",
        )
    except Exception as e:
        return error_result(f"读取 memory 索引失败: {str(e)}", tool_name="list_memory_index")


@tool(
    name="read_memory_entry",
    description="按作用域与文件名读取单条记忆正文，供 Agent 在看到 MEMORY.md 索引后按需展开细节。",
    parameters={
        "type": "object",
        "properties": {
            "scope": {"type": "string", "description": "memory 作用域：project/session/agent/workspace"},
            "file_name": {"type": "string", "description": "记忆文件名，例如 preference_xxx.md"},
            "session_id": {"type": "string", "description": "session 作用域标识；direct/runtime 调用通常会自动注入，无需手填"},
            "agent_name": {"type": "string", "description": "agent 作用域时必填"},
            "workspace_key": {"type": "string", "description": "workspace 作用域时必填"},
        },
        "required": ["scope", "file_name"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "返回单条记忆正文和文件路径",
        "shape": {
            "content": "string",
            "metadata": {
                "file_path": "string",
                "scope": "string",
            },
        },
    },
    usage_contract=[
        "通常先通过 list_memory_index 或 prompt 中给出的 memory 文件路径定位 file_name，再调用本工具",
        "该工具只读取一条具体记忆，不做全文检索",
    ],
    source="decorator",
)
def read_memory_entry(
    scope: str,
    file_name: str,
    session_id: Optional[str] = None,
    agent_name: Optional[str] = None,
    workspace_key: Optional[str] = None,
    current_agent_name: Optional[str] = None,
) -> Any:
    try:
        error = _ensure_memory_enabled('read_memory_entry', current_agent_name)
        if error:
            return error_result(error, tool_name='read_memory_entry')
        memory_config = _resolve_memory_config(current_agent_name)
        scope_error = _ensure_scope_allowed(memory_config, scope, 'read')
        if scope_error:
            return error_result(scope_error, tool_name='read_memory_entry')
        scope_root = _MEMORY_STORE.ensure_scope(
            scope=scope,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
        )
        file_path = scope_root / Path(file_name).name
        if not file_path.exists():
            return error_result(f"memory 文件不存在: {file_name}", tool_name="read_memory_entry")
        content = file_path.read_text(encoding="utf-8")
        return success_result(
            content=content,
            summary=f"已读取记忆文件: {file_name}",
            output_type="text",
            metadata={
                "file_path": str(file_path),
                "scope": scope,
            },
            tool_name="read_memory_entry",
        )
    except Exception as e:
        return error_result(f"读取 memory 文件失败: {str(e)}", tool_name="read_memory_entry")


@tool(
    name="write_memory",
    description="为指定作用域新增或更新一条记忆。memory 会写入 Markdown 文件并同步更新该作用域的 MEMORY.md 索引。",
    parameters={
        "type": "object",
        "properties": {
            "scope": {"type": "string", "description": "memory 作用域：project/session/agent/workspace"},
            "name": {"type": "string", "description": "记忆名称"},
            "description": {"type": "string", "description": "记忆简述，用于 MEMORY.md 索引"},
            "memory_type": {"type": "string", "description": "记忆类型：preference/constraint/goal/fact/profile"},
            "content": {"type": "string", "description": "记忆正文"},
            "why": {"type": "string", "description": "可选，Why 段落"},
            "how_to_apply": {"type": "string", "description": "可选，How to apply 段落"},
            "session_id": {"type": "string", "description": "session 作用域标识；direct/runtime 调用通常会自动注入，无需手填"},
            "agent_name": {"type": "string", "description": "agent 作用域时必填；session 作用域时可作为来源 agent"},
            "workspace_key": {"type": "string", "description": "workspace 作用域时必填"},
            "source_run_id": {"type": "string", "description": "来源 run_id"},
            "source_message_id": {"type": "string", "description": "来源 message_id"},
        },
        "required": ["scope", "name", "description", "memory_type", "content"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "返回写入后的 memory 文件路径",
        "shape": {
            "content": {
                "file_path": "string",
                "file_name": "string",
                "scope": "string",
            }
        },
    },
    usage_contract=[
        "写入前应确认该记忆属于长期可复用信息，而不是一次性临时任务状态",
        "写入后系统会自动同步更新该作用域的 MEMORY.md 索引",
    ],
    source="decorator",
)
def write_memory(
    scope: str,
    name: str,
    description: str,
    memory_type: str,
    content: str,
    why: Optional[str] = None,
    how_to_apply: Optional[str] = None,
    session_id: Optional[str] = None,
    agent_name: Optional[str] = None,
    workspace_key: Optional[str] = None,
    source_run_id: Optional[str] = None,
    source_message_id: Optional[str] = None,
    current_agent_name: Optional[str] = None,
) -> Any:
    try:
        error = _ensure_memory_enabled('write_memory', current_agent_name)
        if error:
            return error_result(error, tool_name='write_memory')
        memory_config = _resolve_memory_config(current_agent_name)
        scope_error = _ensure_scope_allowed(memory_config, scope, 'write')
        if scope_error:
            return error_result(scope_error, tool_name='write_memory')
        path = _MEMORY_STORE.save_memory(
            scope=scope,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
            name=name,
            description=description,
            memory_type=memory_type,
            content=content,
            why=why,
            how_to_apply=how_to_apply,
            source_run_id=source_run_id,
            source_message_id=source_message_id,
        )
        return success_result(
            content={
                "file_path": str(path),
                "file_name": path.name,
                "scope": scope,
            },
            summary=f"已写入 {scope} memory: {path.name}",
            output_type="json",
            metadata={"file_path": str(path), "scope": scope},
            tool_name="write_memory",
        )
    except Exception as e:
        return error_result(f"写入 memory 失败: {str(e)}", tool_name="write_memory")


@tool(
    name="archive_memory",
    description="归档指定作用域下的一条记忆，使其不再参与默认记忆索引与检索。",
    parameters={
        "type": "object",
        "properties": {
            "scope": {"type": "string", "description": "memory 作用域：project/session/agent/workspace"},
            "file_name": {"type": "string", "description": "待归档的记忆文件名"},
            "session_id": {"type": "string", "description": "session 作用域标识；direct/runtime 调用通常会自动注入，无需手填"},
            "agent_name": {"type": "string", "description": "agent 作用域时必填"},
            "workspace_key": {"type": "string", "description": "workspace 作用域时必填"},
        },
        "required": ["scope", "file_name"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "返回归档结果",
        "shape": {
            "content": {
                "archived": "boolean",
                "file_name": "string",
                "scope": "string",
            }
        },
    },
    usage_contract=[
        "archive_memory 会把记忆标记为 archived，并重建 MEMORY.md 索引",
        "P1 默认不提供 delete_memory，长期记忆优先归档而非直接删除",
    ],
    source="decorator",
)
def archive_memory(
    scope: str,
    file_name: str,
    session_id: Optional[str] = None,
    agent_name: Optional[str] = None,
    workspace_key: Optional[str] = None,
    current_agent_name: Optional[str] = None,
) -> Any:
    try:
        error = _ensure_memory_enabled('archive_memory', current_agent_name)
        if error:
            return error_result(error, tool_name='archive_memory')
        memory_config = _resolve_memory_config(current_agent_name)
        scope_error = _ensure_scope_allowed(memory_config, scope, 'archive')
        if scope_error:
            return error_result(scope_error, tool_name='archive_memory')
        archived = _MEMORY_STORE.archive_memory(
            scope=scope,
            file_name=file_name,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
        )
        if not archived:
            return error_result(f"未找到可归档的 memory: {file_name}", tool_name="archive_memory")
        return success_result(
            content={
                "archived": True,
                "file_name": file_name,
                "scope": scope,
            },
            summary=f"已归档 {scope} memory: {file_name}",
            output_type="json",
            metadata={"file_name": file_name, "scope": scope},
            tool_name="archive_memory",
        )
    except Exception as e:
        return error_result(f"归档 memory 失败: {str(e)}", tool_name="archive_memory")
