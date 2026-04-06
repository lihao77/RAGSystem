# -*- coding: utf-8 -*-
"""
代码沙箱执行引擎 - PTC (Programmatic Tool Calling)

重构目标：
- 保留 Pipe + 子进程隔离
- 支持可配置 timeout（默认 60，最大 300）
- 复用共享审批 request_inline_approval()
- 精简冗余逻辑与死代码
"""

from __future__ import annotations

import base64
import collections
import copy
import csv
import datetime
import decimal
import functools
import hashlib
import io
import itertools
import json
import logging
import math
import multiprocessing
import operator
import re
import statistics
import string
import struct
import textwrap
import time as _time
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any, Optional
import os as _os

from agents.task_registry import get_task_registry  # 兼容现有测试 monkeypatch 路径

from tools.contracts.permissions import RiskLevel
from tools.decorators import tool
from core.path_resolution import (
    get_effective_workspace_root,
    get_session_exports_root,
    get_session_sandbox_root,
    get_session_transient_root,
    get_session_uploads_root,
    get_session_visualizations_root,
    resolve_managed_path,
    to_display_path,
)
from tools.permissions import check_tool_permission
from tools.runtime.approvals import request_inline_approval
from tools.runtime.bash_security import CommandCategory
from tools.runtime.response_builder import error_result, success_result

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 60
_MAX_TIMEOUT = 300
_WRITE_MODES = {"w", "a", "x", "wb", "ab", "xb", "w+", "a+", "r+", "w+b", "a+b", "r+b"}

ALLOWED_MODULES = {
    "math": math,
    "json": json,
    "re": re,
    "csv": csv,
    "datetime": datetime,
    "collections": collections,
    "itertools": itertools,
    "functools": functools,
    "statistics": statistics,
    "time": _time,
    "io": io,
    "string": string,
    "decimal": decimal,
    "operator": operator,
    "copy": copy,
    "textwrap": textwrap,
    "hashlib": hashlib,
    "base64": base64,
    "struct": struct,
}

ALLOWED_IMPORT_NAMES = set(ALLOWED_MODULES.keys()) | {
    "collections.abc", "datetime", "math", "json", "re", "csv", "itertools", "functools", "statistics",
    "_datetime", "_collections", "_collections_abc", "_functools", "_itertools", "_statistics",
    "_json", "json.decoder", "json.encoder", "json.scanner", "time", "_strptime", "_csv",
    "ast", "_ast", "_io", "io", "_decimal", "_pydecimal", "numbers", "_hashlib", "_blake2",
    "_sha256", "_sha512", "_sha1", "_sha3", "_md5", "binascii", "copyreg", "_copy", "_struct",
    "_operator", "_textwrap", "_string",
}

_FORBIDDEN_MODULES = {"os", "sys", "subprocess", "shutil", "socket"}
_FORBIDDEN_CALL_PATTERNS = [
    (re.compile(r"__import__"), "__import__"),
    (re.compile(r"(?<![.\w])eval\s*\("), "eval("),
    (re.compile(r"(?<![.\w])exec\s*\("), "exec("),
    (re.compile(r"(?<![.\w])globals\s*\("), "globals("),
    (re.compile(r"(?<![.\w])locals\s*\("), "locals("),
]
_FORBIDDEN_BARE_CALLS = {"compile"}


class SafePathOps:
    join = staticmethod(_os.path.join)
    basename = staticmethod(_os.path.basename)
    dirname = staticmethod(_os.path.dirname)
    splitext = staticmethod(_os.path.splitext)
    exists = staticmethod(_os.path.exists)
    isfile = staticmethod(_os.path.isfile)
    isdir = staticmethod(_os.path.isdir)
    abspath = staticmethod(_os.path.abspath)
    normpath = staticmethod(_os.path.normpath)


_safe_path_ops = SafePathOps()


def _ensure_serializable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, set):
        return [_ensure_serializable(v) for v in value]
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _ensure_serializable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_ensure_serializable(v) for v in value]
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def _extract_import_code_snippet(code: str, module_name: str, context_lines: int = 2) -> str:
    lines = code.splitlines()
    module_root = module_name.split(".")[0]
    matched_indexes = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "import " not in stripped:
            continue
        if module_name in stripped or module_root in stripped:
            matched_indexes.append(index)
    if not matched_indexes:
        end = min(len(lines), 8)
        return "\n".join(f"{i + 1}: {lines[i]}" for i in range(end))
    snippet_lines = []
    seen = set()
    for match_index in matched_indexes:
        start = max(0, match_index - context_lines)
        end = min(len(lines), match_index + context_lines + 1)
        for line_no in range(start, end):
            if line_no in seen:
                continue
            seen.add(line_no)
            snippet_lines.append(f"{line_no + 1}: {lines[line_no]}")
    return "\n".join(snippet_lines)


def _classify_code_risk(code: str) -> str:
    # 保守字符串估计：注释或字符串字面量中出现这些 token 也会被误判为 WRITE，
    # 但对此函数而言过高估计比漏报更安全（仅用于结果 metadata，不影响执行路径）。
    lowered = code.lower()
    if any(token in lowered for token in ["call_tool(", "open(", "save_file("]):
        return CommandCategory.WRITE.value
    return CommandCategory.READ_ONLY.value


def _request_sandbox_approval(
    event_bus,
    session_id: Optional[str],
    *,
    approval_type: str,
    tool_name: str,
    arguments: dict,
    risk_level: str,
    description: str,
) -> str:
    approved, note = request_inline_approval(
        event_bus=event_bus,
        session_id=session_id,
        tool_name=tool_name,
        approval_type=approval_type,
        arguments=arguments,
        risk_level=risk_level,
        description=description,
        registry_getter=get_task_registry,
    )
    if not approved:
        raise PermissionError(note or "用户拒绝执行此操作")
    return note or ""


def _make_safe_open(approval_granted: list, approval_requester, *, session_id=None, run_id=None, workspace_root=None):
    def safe_open(path, mode="r", encoding=None, **kwargs):
        normalized = mode.replace("t", "")
        is_write = normalized in _WRITE_MODES
        resolved = resolve_managed_path(
            str(path),
            session_id=session_id,
            run_id=run_id,
            caller="code_execution",
            operation="write" if is_write else "read",
            workspace_root=workspace_root,
        )
        if is_write and not approval_granted[0]:
            approval_requester(
                approval_type="sandbox_file_write",
                tool_name="sandbox_file_write",
                arguments={"path": str(resolved), "reason": "沙箱代码写文件"},
                risk_level="high",
                description=f"沙箱代码请求写入文件: {resolved.name}",
            )
            approval_granted[0] = True
            resolved.parent.mkdir(parents=True, exist_ok=True)

        open_kwargs = {}
        if encoding is not None:
            open_kwargs["encoding"] = encoding
        elif "b" not in mode:
            open_kwargs["encoding"] = "utf-8"
        return open(resolved, mode, **{**open_kwargs, **kwargs})

    return safe_open


def _make_save_file(approval_granted: list, approval_requester, *, session_id=None, run_id=None, workspace_root=None):
    def save_file(content, filename: str, space: str = "workspace") -> str:
        if space not in ("workspace", "transient", "exports"):
            raise ValueError("space 必须是 workspace/transient/exports 之一")
        resolved = resolve_managed_path(
            filename,
            session_id=session_id,
            run_id=run_id,
            caller="code_execution",
            operation="write",
            explicit_space=space,
            workspace_root=workspace_root,
        )
        if not approval_granted[0]:
            approval_requester(
                approval_type="sandbox_file_write",
                tool_name="sandbox_file_write",
                arguments={"path": str(resolved), "reason": f"沙箱代码保存文件到 {space}"},
                risk_level="high",
                description=f"沙箱代码请求保存文件: {resolved.name}（→ {space}）",
            )
            approval_granted[0] = True
        resolved.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            with open(resolved, "wb") as f:
                f.write(content)
        elif isinstance(content, str):
            with open(resolved, "w", encoding="utf-8") as f:
                f.write(content)
        else:
            with open(resolved, "w", encoding="utf-8") as f:
                json.dump(content, f, ensure_ascii=False, indent=2)
        return to_display_path(resolved)

    return save_file


def _make_call_tool_function(tool_caller, tool_calls_count: list):
    def call_tool(tool_name: str, arguments: dict) -> Any:
        tool_calls_count[0] += 1
        return tool_caller(tool_name, arguments)

    return call_tool


def _build_safe_builtins(safe_import):
    return {
        "__import__": safe_import,
        "print": print, "len": len, "range": range, "enumerate": enumerate, "zip": zip,
        "map": map, "filter": filter, "sum": sum, "min": min, "max": max, "abs": abs,
        "round": round, "sorted": sorted, "reversed": reversed, "any": any, "all": all,
        "isinstance": isinstance, "issubclass": issubclass, "hasattr": hasattr, "callable": callable,
        "ascii": ascii, "getattr": getattr, "setattr": setattr, "delattr": delattr,
        "id": id, "hash": hash, "repr": repr, "format": format, "iter": iter, "next": next,
        "chr": chr, "ord": ord, "hex": hex, "oct": oct, "bin": bin, "pow": pow, "divmod": divmod,
        "slice": slice, "int": int, "float": float, "str": str, "bool": bool, "list": list,
        "dict": dict, "set": set, "tuple": tuple, "frozenset": frozenset, "bytes": bytes,
        "bytearray": bytearray, "complex": complex, "type": type, "object": object,
        "property": property, "staticmethod": staticmethod, "classmethod": classmethod, "super": super,
        "Exception": Exception, "BaseException": BaseException, "ValueError": ValueError,
        "TypeError": TypeError, "KeyError": KeyError, "IndexError": IndexError,
        "AttributeError": AttributeError, "RuntimeError": RuntimeError, "StopIteration": StopIteration,
        "ZeroDivisionError": ZeroDivisionError, "OverflowError": OverflowError,
        "PermissionError": PermissionError, "NotImplementedError": NotImplementedError,
        "FileNotFoundError": FileNotFoundError, "IOError": IOError, "ArithmeticError": ArithmeticError,
        "LookupError": LookupError, "True": True, "False": False, "None": None,
    }


def _build_sandbox_globals(*, safe_import, call_tool_func, safe_open_func, save_file_func, sandbox_root, workspace_root, transient_root, uploads_root, visualizations_root, exports_root):
    return {
        "__builtins__": _build_safe_builtins(safe_import),
        **ALLOWED_MODULES,
        "call_tool": call_tool_func,
        "open": safe_open_func,
        "save_file": save_file_func,
        "SANDBOX_DIR": str(sandbox_root),
        "DATA_DIR": str(workspace_root or visualizations_root or sandbox_root),
        "SESSION_TRANSIENT_DIR": str(transient_root or sandbox_root),
        "SESSION_UPLOADS_DIR": str(uploads_root or sandbox_root),
        "SESSION_VISUALIZATIONS_DIR": str(visualizations_root or sandbox_root),
        "SESSION_EXPORTS_DIR": str(exports_root or sandbox_root),
        "SESSION_WORKSPACE_DIR": str(workspace_root or sandbox_root),
        "path_ops": _safe_path_ops,
    }


def _make_parent_tool_caller(agent_config, event_bus, user_role, session_id=None, cancel_event=None, team_name=None, workspace_root=None):
    from tools.refs.result_references import result_error_message, result_primary_content, result_success
    from tools.runtime.executor import execute_tool

    def call_tool(tool_name: str, arguments: dict) -> Any:
        allowed, error_msg = check_tool_permission(
            tool_name=tool_name,
            agent_config=agent_config,
            user_role=user_role,
            caller="code_execution",
        )
        if not allowed:
            raise PermissionError(f"工具 '{tool_name}' 不允许从代码调用: {error_msg}")
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("代码执行已被中断")

        result = execute_tool(
            tool_name=tool_name,
            arguments=arguments,
            agent_config=agent_config,
            event_bus=event_bus,
            user_role=user_role,
            caller="code_execution",
            session_id=session_id,
            team_name=team_name,
            workspace_root=workspace_root,
            cancel_event=cancel_event,
        )
        if not result_success(result):
            raise RuntimeError(f"工具 '{tool_name}' 执行失败: {result_error_message(result)}")
        return result_primary_content(result)

    return call_tool


def _make_ipc_tool_caller(conn):
    def call_tool(tool_name: str, arguments: dict) -> Any:
        request_id = f"tool-{_time.monotonic_ns()}"
        conn.send({
            "type": "tool_call",
            "request_id": request_id,
            "tool_name": tool_name,
            "arguments": _ensure_serializable(arguments or {}),
        })
        message = conn.recv()
        if message.get("type") != "tool_result" or message.get("request_id") != request_id:
            raise RuntimeError("收到无效的工具调用响应")
        if not message.get("success"):
            raise RuntimeError(message.get("error") or f"工具 '{tool_name}' 执行失败")
        return message.get("content")

    return call_tool


def _make_ipc_approval_requester(conn):
    def request_approval(*, approval_type: str, tool_name: str, arguments: dict, risk_level: str, description: str) -> str:
        request_id = f"approval-{_time.monotonic_ns()}"
        conn.send({
            "type": "approval_request",
            "request_id": request_id,
            "approval_type": approval_type,
            "tool_name": tool_name,
            "arguments": _ensure_serializable(arguments or {}),
            "risk_level": risk_level,
            "description": description,
        })
        message = conn.recv()
        if message.get("type") != "approval_result" or message.get("request_id") != request_id:
            raise RuntimeError("收到无效的审批响应")
        if not message.get("approved"):
            raise PermissionError(message.get("message") or "用户拒绝执行此操作")
        return message.get("message") or ""

    return request_approval


def _terminate_process(process, *, wait_timeout: float = 1.0) -> None:
    if process is None:
        return
    if process.is_alive():
        process.terminate()
        process.join(wait_timeout)
    if process.is_alive() and hasattr(process, "kill"):
        process.kill()
        process.join(wait_timeout)


def _sandbox_worker(conn, payload: dict):
    stdout_capture = io.StringIO()
    tool_calls_count = [0]
    approval_granted = [False]
    approved_imports = set(ALLOWED_IMPORT_NAMES)
    code = payload["code"]

    approval_requester = _make_ipc_approval_requester(conn)
    safe_open_func = _make_safe_open(
        approval_granted,
        approval_requester,
        session_id=payload.get("session_id"),
        run_id=payload.get("run_id"),
        workspace_root=payload.get("workspace_root"),
    )
    save_file_func = _make_save_file(
        approval_granted,
        approval_requester,
        session_id=payload.get("session_id"),
        run_id=payload.get("run_id"),
        workspace_root=payload.get("workspace_root"),
    )
    call_tool_func = _make_call_tool_function(_make_ipc_tool_caller(conn), tool_calls_count)
    real_import = __import__

    def _safe_import(name, *args, **kwargs):
        module_root = name.split(".")[0]
        if name in ALLOWED_IMPORT_NAMES or name in approved_imports or module_root in approved_imports:
            return real_import(name, *args, **kwargs)
        snippet = _extract_import_code_snippet(code, name)
        try:
            approval_requester(
                approval_type="sandbox_module_import",
                tool_name="sandbox_module_import",
                arguments={"module_name": name, "module_root": module_root, "code_snippet": snippet},
                risk_level="high",
                description=f"沙箱代码请求导入受限模块: {name}",
            )
            approved_imports.add(name)
            approved_imports.add(module_root)
            return real_import(name, *args, **kwargs)
        except PermissionError as exc:
            raise ImportError(f"禁止导入模块: {name}（{exc}）")

    globals_dict = _build_sandbox_globals(
        safe_import=_safe_import,
        call_tool_func=call_tool_func,
        safe_open_func=safe_open_func,
        save_file_func=save_file_func,
        sandbox_root=Path(payload["sandbox_root"]),
        workspace_root=Path(payload["current_workspace_root"]) if payload.get("current_workspace_root") else None,
        transient_root=Path(payload["current_transient_root"]) if payload.get("current_transient_root") else None,
        uploads_root=Path(payload["current_uploads_root"]) if payload.get("current_uploads_root") else None,
        visualizations_root=Path(payload["current_visualizations_root"]) if payload.get("current_visualizations_root") else None,
        exports_root=Path(payload["current_exports_root"]) if payload.get("current_exports_root") else None,
    )

    try:
        with redirect_stdout(stdout_capture):
            exec(code, globals_dict)
        if "result" not in globals_dict:
            conn.send({
                "type": "done",
                "success": False,
                "error": "代码必须设置 result 变量作为输出",
                "stdout": stdout_capture.getvalue(),
                "tool_calls_count": tool_calls_count[0],
            })
            return
        conn.send({
            "type": "done",
            "success": True,
            "result": _ensure_serializable(globals_dict["result"]),
            "stdout": stdout_capture.getvalue(),
            "tool_calls_count": tool_calls_count[0],
        })
    except BaseException as exc:
        conn.send({
            "type": "done",
            "success": False,
            "error": str(exc),
            "stdout": stdout_capture.getvalue(),
            "tool_calls_count": tool_calls_count[0],
        })
    finally:
        conn.close()


def _static_code_check(code: str) -> tuple[bool, Optional[str]]:
    import ast

    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] in _FORBIDDEN_MODULES:
                        return False, f"禁止导入模块: {alias.name}"
            elif isinstance(node, ast.ImportFrom):
                if node.module and node.module.split(".")[0] in _FORBIDDEN_MODULES:
                    return False, f"禁止导入模块: {node.module}"
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in _FORBIDDEN_BARE_CALLS:
                    return False, f"禁止使用: {node.func.id}()"
    except SyntaxError:
        for line in code.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            for mod in _FORBIDDEN_MODULES:
                if f"import {mod}" in stripped or f"from {mod}" in stripped:
                    return False, f"禁止导入模块: {mod}"

    for line in code.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        for regex, label in _FORBIDDEN_CALL_PATTERNS:
            if regex.search(stripped):
                return False, f"禁止使用: {label}"
    return True, None


def _publish_execution_event(event_bus, phase: str, **kwargs):
    if not event_bus:
        return
    try:
        from agents.events.bus import Event, EventType
        session_id = kwargs.get("session_id")
        if phase == "start":
            event = Event(
                type=EventType.CODE_EXECUTION_START,
                data={
                    "description": kwargs.get("description", ""),
                    "code_preview": kwargs.get("code_preview", ""),
                    "classification": kwargs.get("classification", CommandCategory.READ_ONLY.value),
                },
                session_id=session_id,
            )
        else:
            event = Event(
                type=EventType.CODE_EXECUTION_END,
                data={
                    "result_preview": str(kwargs.get("result", ""))[:500],
                    "execution_time": kwargs.get("execution_time", 0),
                    "tool_calls_count": kwargs.get("tool_calls_count", 0),
                },
                session_id=session_id,
            )
        event_bus.publish(event)
    except Exception as exc:
        logger.debug("发布代码执行事件失败: %s", exc)


@tool(
    name="execute_code",
    description="在受限沙箱中执行 Python 代码进行复杂工具编排与数据处理。支持 call_tool、受限 open()、save_file()，必须设置 result 变量作为输出。",
    parameters={
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Python 代码。必须设置 result 变量作为最终输出。"},
            "description": {"type": "string", "description": "代码用途说明（可选）"},
            "timeout": {"type": "integer", "description": "超时时间，默认 60 秒，最大 300 秒。", "minimum": 1, "maximum": 300},
        },
        "required": ["code"],
    },
    risk_level=RiskLevel.HIGH,
    # 外层 safety-net 超时应大于内层最大值（_MAX_TIMEOUT=300）加审批等待 buffer
    timeout_seconds=600,
    allowed_callers=["direct"],
    extended_usage="""### 模块与全局变量

**禁止导入的模块**：`os`、`sys`、`subprocess`、`shutil`、`socket`。

**允许导入的模块**（白名单）：`math`、`json`、`re`、`csv`、`datetime`、`collections`、`itertools`、`functools`、`statistics`、`time`、`io`、`string`、`decimal`、`operator`、`copy`、`textwrap`、`hashlib`、`base64`、`struct`、`ast`（用于 `ast.literal_eval`）。

**已注入的全局变量**（无需 import，直接使用）：
- `path_ops` — 安全路径操作，提供 `join`、`basename`、`dirname`、`splitext`、`exists`、`isfile`、`isdir`、`abspath`、`normpath`，替代被禁的 `os.path`
- `call_tool(tool_name, arguments)` — 调用其他工具（仅限 `allowed_callers` 包含 `"code_execution"` 的工具）
- `save_file(content, filename, space='workspace')` — 保存文件到受管目录
- `open(path, mode='r', ...)` — 受限文件读写
- `SESSION_WORKSPACE_DIR`、`SESSION_TRANSIENT_DIR`、`SESSION_EXPORTS_DIR`、`SESSION_UPLOADS_DIR`、`SESSION_VISUALIZATIONS_DIR`、`SANDBOX_DIR`、`DATA_DIR` — 目录路径常量

### 文件操作规则

三个受管目录 `space` 与 direct 文件工具、`execute_bash` 一致：`workspace` / `transient` / `exports`。在代码里优先使用 `SESSION_WORKSPACE_DIR`、`SESSION_TRANSIENT_DIR`、`SESSION_EXPORTS_DIR`，不要自己猜路径，也不要拼接 `data/sessions/...` 这类内部路径。

文件读写不要再通过 `call_tool('read_file'/'write_file'/'edit_file', ...)` 完成；这 3 个工具现在只允许 direct 调用。在 `execute_code` 里直接使用受限 `open()` 读写文件。

**保存规则**：
- 临时中间产物：写到 `SESSION_TRANSIENT_DIR`
- 需要给用户下载/查看的结果文件：优先使用 `save_file(content, filename, space='exports')`
- 明确属于当前工作区内容的文件：写到 `SESSION_WORKSPACE_DIR`

**文件示例**：
```python
file_path = path_ops.join(SESSION_TRANSIENT_DIR, 'demo.txt')
with open(file_path, 'w', encoding='utf-8') as f:
    f.write('hello')
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()
result = {'content': content}
```

**导出结果示例**：
```python
display_path = save_file({'ok': True}, 'report.json', space='exports')
result = {'display_path': display_path}
```

### call_tool 使用说明

`call_tool()` 只返回工具的主内容，也就是 `ToolExecutionResult.content`；如果需要完整响应壳，不要假设它会返回 `content / summary / metadata` 结构。

**错误示例**：
```python
value = call_tool('tool_name', {
    'param_name': 'value'
})['content']  # ❌ call_tool 已经返回主内容，不要再访问 ['content']
```

**正确示例**：
```python
value = call_tool('tool_name', {
    'param_name': 'value'
})  # ✅ 直接使用返回值
result = {'tool_output': value}
```""",
)
def execute_code_sandbox(
    code: str,
    description: str = "",
    timeout: int = _DEFAULT_TIMEOUT,
    agent_config=None,
    event_bus=None,
    user_role=None,
    session_id: Optional[str] = None,
    cancel_event=None,
    run_id: Optional[str] = None,
):
    timeout = max(1, min(int(timeout or _DEFAULT_TIMEOUT), _MAX_TIMEOUT))
    logger.info("执行代码沙箱: %s", description or "无描述")
    start_time = _time.time()

    code_classification = _classify_code_risk(code)
    _publish_execution_event(
        event_bus,
        "start",
        session_id=session_id,
        description=description,
        code_preview=code[:200],
        classification=code_classification,
    )

    passed, error_msg = _static_code_check(code)
    if not passed:
        return error_result(f"代码安全检查失败: {error_msg}", tool_name="execute_code")

    if session_id:
        sandbox_root = get_session_sandbox_root(session_id)
    else:
        sandbox_root = get_session_sandbox_root("anonymous")
    sandbox_root.mkdir(parents=True, exist_ok=True)

    workspace_root = None
    if agent_config and hasattr(agent_config, "custom_params"):
        custom_params = agent_config.custom_params if isinstance(agent_config.custom_params, dict) else {}
        workspace_root = custom_params.get("workspace_root")

    if run_id is None:
        try:
            from execution.observability import get_current_execution_observability_fields
            run_id = get_current_execution_observability_fields().get("run_id")
        except Exception:
            run_id = None

    current_workspace_root = get_effective_workspace_root(session_id, workspace_root)
    current_transient_root = get_session_transient_root(session_id) if session_id else None
    current_uploads_root = get_session_uploads_root(session_id) if session_id else None
    current_visualizations_root = get_session_visualizations_root(session_id) if session_id else None
    current_exports_root = get_session_exports_root(session_id) if session_id else None

    parent_tool_caller = _make_parent_tool_caller(
        agent_config,
        event_bus,
        user_role,
        session_id=session_id,
        cancel_event=cancel_event,
        team_name=team_name,
        workspace_root=workspace_root,
    )
    ipc_approval_requester = lambda **kwargs: _request_sandbox_approval(event_bus, session_id, **kwargs)

    ctx = multiprocessing.get_context("spawn")
    parent_conn, child_conn = ctx.Pipe(duplex=True)

    process = ctx.Process(
        target=_sandbox_worker,
        args=(child_conn, {
            "code": code,
            "session_id": session_id,
            "run_id": run_id,
            "workspace_root": workspace_root,
            "sandbox_root": str(sandbox_root),
            "current_workspace_root": str(current_workspace_root) if current_workspace_root else None,
            "current_transient_root": str(current_transient_root) if current_transient_root else None,
            "current_uploads_root": str(current_uploads_root) if current_uploads_root else None,
            "current_visualizations_root": str(current_visualizations_root) if current_visualizations_root else None,
            "current_exports_root": str(current_exports_root) if current_exports_root else None,
        }),
    )
    process.daemon = True
    process.start()
    child_conn.close()

    done_message = None
    paused_duration = 0.0
    try:
        started_at = _time.monotonic()
        while True:
            if cancel_event is not None and cancel_event.is_set():
                _terminate_process(process)
                return error_result("代码执行失败: 执行已取消", tool_name="execute_code")

            if _time.monotonic() - started_at - paused_duration >= timeout:
                _terminate_process(process)
                return error_result(f"代码执行失败: 代码执行超时（超过 {timeout} 秒）", tool_name="execute_code")

            if parent_conn.poll(0.1):
                try:
                    message = parent_conn.recv()
                except EOFError:
                    break

                msg_type = message.get("type")
                if msg_type == "tool_call":
                    try:
                        content = parent_tool_caller(message.get("tool_name"), message.get("arguments") or {})
                        parent_conn.send({
                            "type": "tool_result",
                            "request_id": message.get("request_id"),
                            "success": True,
                            "content": _ensure_serializable(content),
                        })
                    except BaseException as exc:
                        parent_conn.send({
                            "type": "tool_result",
                            "request_id": message.get("request_id"),
                            "success": False,
                            "error": str(exc),
                            "content": None,
                        })
                elif msg_type == "approval_request":
                    try:
                        approval_started = _time.monotonic()
                        approval_message = ipc_approval_requester(
                            approval_type=message.get("approval_type"),
                            tool_name=message.get("tool_name"),
                            arguments=message.get("arguments") or {},
                            risk_level=message.get("risk_level") or "high",
                            description=message.get("description") or "",
                        )
                        paused_duration += _time.monotonic() - approval_started
                        parent_conn.send({
                            "type": "approval_result",
                            "request_id": message.get("request_id"),
                            "approved": True,
                            "message": approval_message,
                        })
                    except PermissionError as exc:
                        paused_duration += _time.monotonic() - approval_started
                        parent_conn.send({
                            "type": "approval_result",
                            "request_id": message.get("request_id"),
                            "approved": False,
                            "message": str(exc),
                        })
                elif msg_type == "done":
                    done_message = message
                    break

            if not process.is_alive() and not parent_conn.poll():
                break

        process.join(timeout=1.0)
        if done_message is None:
            return error_result("代码执行失败: 沙箱进程异常退出", tool_name="execute_code")
        if not done_message.get("success"):
            return error_result(f"代码执行失败: {done_message.get('error')}", tool_name="execute_code")

        result_value = done_message.get("result")
        stdout_text = done_message.get("stdout", "")
        tool_calls_count = done_message.get("tool_calls_count", 0)
        execution_time = _time.time() - start_time

        _publish_execution_event(
            event_bus,
            "end",
            session_id=session_id,
            result=result_value,
            execution_time=execution_time,
            tool_calls_count=tool_calls_count,
        )
        return success_result(
            content=result_value,
            metadata={
                "stdout": stdout_text,
                "tool_calls_count": tool_calls_count,
                "execution_time": execution_time,
                "classification": code_classification,
            },
            summary=f"代码执行成功，工具调用 {tool_calls_count} 次",
            output_type="json" if not isinstance(result_value, str) else "text",
            tool_name="execute_code",
        )
    except Exception as exc:
        logger.error("代码沙箱异常: %s", exc, exc_info=True)
        return error_result(f"代码执行异常: {exc}", tool_name="execute_code")
    finally:
        _terminate_process(process)
        parent_conn.close()
