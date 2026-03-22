# -*- coding: utf-8 -*-
"""
代码沙箱执行引擎 - PTC (Programmatic Tool Calling)

- 受限 Python 执行环境
- 支持在代码中调用其他工具（call_tool）
- 支持受限文件读写与审批
- 使用子进程承载 exec()，确保超时/取消可以真正回收执行体
"""

import io
import os
import math
import json
import re
import csv
import datetime
import collections
import itertools
import functools
import statistics
import logging
import multiprocessing
import time as _time
import string
import decimal
import operator
import copy
import textwrap
import hashlib
import base64
import struct
from pathlib import Path
from typing import Any, Optional
from contextlib import redirect_stdout

from agents.task_registry import get_task_registry
from tools.response_builder import success_result, error_result
from tools.permissions import check_tool_permission, RiskLevel
from tools.decorators import tool
from tools.path_resolution import (
    resolve_managed_path,
    get_session_sandbox_root,
    get_session_workspace_root,
    get_session_transient_root,
    get_session_uploads_root,
    get_session_visualizations_root,
    get_session_exports_root,
    get_code_execution_session_root,
)

logger = logging.getLogger(__name__)

SANDBOX_ROOT = get_session_sandbox_root("anonymous")
SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)

_WRITE_MODES = {'w', 'a', 'x', 'wb', 'ab', 'xb', 'w+', 'a+', 'r+', 'w+b', 'a+b', 'r+b'}

ALLOWED_MODULES = {
    'math': math,
    'json': json,
    're': re,
    'csv': csv,
    'datetime': datetime,
    'collections': collections,
    'itertools': itertools,
    'functools': functools,
    'statistics': statistics,
    'time': _time,
    'io': io,
    'string': string,
    'decimal': decimal,
    'operator': operator,
    'copy': copy,
    'textwrap': textwrap,
    'hashlib': hashlib,
    'base64': base64,
    'struct': struct,
}

ALLOWED_IMPORT_NAMES = set(ALLOWED_MODULES.keys()) | {
    'collections.abc', 'datetime', 'math', 'json', 're', 'csv', 'itertools', 'functools', 'statistics',
    '_datetime', '_collections', '_collections_abc', '_functools', '_itertools', '_statistics',
    '_json', 'json.decoder', 'json.encoder', 'json.scanner', 'time', '_strptime', '_csv',
    'ast', '_ast', '_io', 'io', '_decimal', '_pydecimal', 'numbers', '_hashlib', '_blake2',
    '_sha256', '_sha512', '_sha1', '_sha3', '_md5', 'binascii', 'copyreg', '_copy', '_struct',
    '_operator', '_textwrap', '_string',
}

_FORBIDDEN_MODULES = {'os', 'sys', 'subprocess', 'shutil', 'socket'}
_FORBIDDEN_CALL_PATTERNS = [
    (re.compile(r'__import__'), '__import__'),
    (re.compile(r'(?<![.\w])eval\s*\('), 'eval('),
    (re.compile(r'(?<![.\w])exec\s*\('), 'exec('),
    (re.compile(r'(?<![.\w])globals\s*\('), 'globals('),
    (re.compile(r'(?<![.\w])locals\s*\('), 'locals('),
]
_FORBIDDEN_BARE_CALLS = {'compile'}


class SafePathOps:
    join = staticmethod(os.path.join)
    basename = staticmethod(os.path.basename)
    dirname = staticmethod(os.path.dirname)
    splitext = staticmethod(os.path.splitext)
    exists = staticmethod(os.path.exists)
    isfile = staticmethod(os.path.isfile)
    isdir = staticmethod(os.path.isdir)
    abspath = staticmethod(os.path.abspath)
    normpath = staticmethod(os.path.normpath)


_safe_path_ops = SafePathOps()


def _ensure_serializable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, set):
        return [_ensure_serializable(v) for v in value]
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
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
    if not lines:
        return ""

    module_root = module_name.split('.')[0]
    matched_indexes = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or 'import ' not in stripped:
            continue
        if module_name in stripped or module_root in stripped:
            matched_indexes.append(index)

    if not matched_indexes:
        end = min(len(lines), 8)
        return "\n".join(f"{line_no + 1}: {lines[line_no]}" for line_no in range(end))

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
    if not event_bus:
        raise PermissionError("当前上下文无事件总线，无法发起审批")
    if not session_id:
        raise PermissionError("当前上下文缺少 session_id，无法等待用户审批")

    try:
        import uuid
        from agents.events import Event, EventType
        from utils.timeout_pause import pause_current, resume_current

        approval_id = str(uuid.uuid4())
        registry = get_task_registry()
        wait_evt = registry.add_pending_approval(session_id, approval_id)
        if wait_evt is None:
            raise PermissionError("当前上下文无法注册审批请求")

        event_bus.publish(Event(
            type=EventType.USER_APPROVAL_REQUIRED,
            session_id=session_id,
            data={
                'approval_id': approval_id,
                'approval_type': approval_type,
                'tool_name': tool_name,
                'arguments': arguments,
                'risk_level': risk_level,
                'description': description,
            },
        ))

        pause_current()
        try:
            wait_evt.wait()
        finally:
            resume_current()
        approved, approval_message = registry.get_approval_result(session_id, approval_id)
    except PermissionError:
        raise
    except Exception as e:
        logger.error('发起沙箱审批失败: %s', e)
        raise PermissionError(f"审批请求发送失败: {e}")

    if not approved:
        raise PermissionError(approval_message or '用户拒绝执行此操作')
    return approval_message or ''


def _make_safe_open(approval_granted: list, *, session_id=None, run_id=None, workspace_root=None):
    def safe_open(path, mode='r', encoding=None, **kwargs):
        normalized = mode.replace('t', '')
        is_write = normalized in _WRITE_MODES
        resolved = resolve_managed_path(
            str(path),
            session_id=session_id,
            run_id=run_id,
            caller='code_execution',
            operation='write' if is_write else 'read',
            workspace_root=workspace_root,
        )
        if is_write:
            if not approval_granted[0]:
                raise PermissionError('文件写操作需要用户审批，请先调用 request_write_approval(path) 获取授权')
            resolved.parent.mkdir(parents=True, exist_ok=True)
            logger.info('沙箱写文件: %s', resolved)

        open_kwargs = {}
        if encoding is not None:
            open_kwargs['encoding'] = encoding
        elif 'b' not in mode:
            open_kwargs['encoding'] = 'utf-8'
        return open(resolved, mode, **{**open_kwargs, **kwargs})

    return safe_open


def _make_request_write_approval(approval_granted: list, approval_requester, *, session_id=None, run_id=None, workspace_root=None):
    def request_write_approval(path: str, reason: str = ''):
        resolved = resolve_managed_path(
            str(path),
            session_id=session_id,
            run_id=run_id,
            caller='code_execution',
            operation='write',
            workspace_root=workspace_root,
        )
        try:
            approval_requester(
                approval_type='sandbox_file_write',
                tool_name='sandbox_file_write',
                arguments={'path': str(resolved), 'reason': reason},
                risk_level='high',
                description=f"沙箱代码请求写入文件: {resolved.name}" + (f"，原因：{reason}" if reason else ''),
            )
        except PermissionError as e:
            raise PermissionError(f"文件写操作已取消: {resolved}，原因: {e}")
        approval_granted[0] = True
        logger.info('文件写操作已获批准: %s', resolved)
        return True

    return request_write_approval


def _make_call_tool_function(tool_caller, tool_calls_count: list):
    def call_tool(tool_name: str, arguments: dict) -> Any:
        tool_calls_count[0] += 1
        return tool_caller(tool_name, arguments)

    return call_tool


def _build_safe_builtins(safe_import):
    return {
        '__import__': safe_import,
        'print': print, 'len': len, 'range': range, 'enumerate': enumerate, 'zip': zip,
        'map': map, 'filter': filter, 'sum': sum, 'min': min, 'max': max, 'abs': abs,
        'round': round, 'sorted': sorted, 'reversed': reversed, 'any': any, 'all': all,
        'isinstance': isinstance, 'issubclass': issubclass, 'hasattr': hasattr, 'callable': callable,
        'ascii': ascii, 'getattr': getattr, 'setattr': setattr, 'delattr': delattr,
        'id': id, 'hash': hash, 'repr': repr, 'format': format, 'iter': iter, 'next': next,
        'chr': chr, 'ord': ord, 'hex': hex, 'oct': oct, 'bin': bin, 'pow': pow, 'divmod': divmod,
        'slice': slice, 'int': int, 'float': float, 'str': str, 'bool': bool, 'list': list,
        'dict': dict, 'set': set, 'tuple': tuple, 'frozenset': frozenset, 'bytes': bytes,
        'bytearray': bytearray, 'complex': complex, 'type': type, 'object': object,
        'property': property, 'staticmethod': staticmethod, 'classmethod': classmethod, 'super': super,
        'Exception': Exception, 'BaseException': BaseException, 'ValueError': ValueError,
        'TypeError': TypeError, 'KeyError': KeyError, 'IndexError': IndexError,
        'AttributeError': AttributeError, 'RuntimeError': RuntimeError, 'StopIteration': StopIteration,
        'ZeroDivisionError': ZeroDivisionError, 'OverflowError': OverflowError,
        'PermissionError': PermissionError, 'NotImplementedError': NotImplementedError,
        'FileNotFoundError': FileNotFoundError, 'IOError': IOError, 'ArithmeticError': ArithmeticError,
        'LookupError': LookupError, 'True': True, 'False': False, 'None': None,
    }


def _build_sandbox_globals(*, safe_import, call_tool_func, safe_open_func, request_write_approval_func, sandbox_root, workspace_root, transient_root, uploads_root, visualizations_root, exports_root):
    return {
        '__builtins__': _build_safe_builtins(safe_import),
        **ALLOWED_MODULES,
        'call_tool': call_tool_func,
        'open': safe_open_func,
        'request_write_approval': request_write_approval_func,
        'SANDBOX_DIR': str(sandbox_root),
        'DATA_DIR': str(workspace_root or visualizations_root or sandbox_root),
        'SESSION_TRANSIENT_DIR': str(transient_root or sandbox_root),
        'SESSION_UPLOADS_DIR': str(uploads_root or sandbox_root),
        'SESSION_VISUALIZATIONS_DIR': str(visualizations_root or sandbox_root),
        'SESSION_EXPORTS_DIR': str(exports_root or sandbox_root),
        'SESSION_WORKSPACE_DIR': str(workspace_root or sandbox_root),
        'path_ops': _safe_path_ops,
    }


def _make_parent_tool_caller(agent_config, event_bus, user_role, session_id=None, cancel_event=None):
    from tools.result_references import result_error_message, result_primary_content, result_success
    from tools.tool_executor import execute_tool

    def call_tool(tool_name: str, arguments: dict) -> Any:
        allowed, error_msg = check_tool_permission(
            tool_name=tool_name,
            agent_config=agent_config,
            user_role=user_role,
            caller='code_execution',
        )
        if not allowed:
            raise PermissionError(f"工具 '{tool_name}' 不允许从代码调用: {error_msg}")
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError('代码执行已被中断')

        result = execute_tool(
            tool_name=tool_name,
            arguments=arguments,
            agent_config=agent_config,
            event_bus=event_bus,
            user_role=user_role,
            caller='code_execution',
            session_id=session_id,
            cancel_event=cancel_event,
        )
        if not result_success(result):
            raise RuntimeError(f"工具 '{tool_name}' 执行失败: {result_error_message(result)}")
        return result_primary_content(result)

    return call_tool


def _make_ipc_tool_caller(conn):
    def call_tool(tool_name: str, arguments: dict) -> Any:
        request_id = f"tool-{_time.monotonic_ns()}"
        conn.send({'type': 'tool_call', 'request_id': request_id, 'tool_name': tool_name, 'arguments': _ensure_serializable(arguments or {})})
        while True:
            message = conn.recv()
            if message.get('type') == 'tool_result' and message.get('request_id') == request_id:
                if not message.get('success'):
                    raise RuntimeError(message.get('error') or f"工具 '{tool_name}' 执行失败")
                return message.get('content')
            raise RuntimeError('收到无效的工具调用响应')

    return call_tool


def _make_ipc_approval_requester(conn):
    def request_approval(*, approval_type: str, tool_name: str, arguments: dict, risk_level: str, description: str) -> str:
        request_id = f"approval-{_time.monotonic_ns()}"
        conn.send({
            'type': 'approval_request',
            'request_id': request_id,
            'approval_type': approval_type,
            'tool_name': tool_name,
            'arguments': _ensure_serializable(arguments or {}),
            'risk_level': risk_level,
            'description': description,
        })
        while True:
            message = conn.recv()
            if message.get('type') == 'approval_result' and message.get('request_id') == request_id:
                if not message.get('approved'):
                    raise PermissionError(message.get('message') or '用户拒绝执行此操作')
                return message.get('message') or ''
            raise RuntimeError('收到无效的审批响应')

    return request_approval


def _result_to_ipc_payload(result) -> dict:
    return {
        'success': bool(getattr(result, 'success', False)),
        'content': _ensure_serializable(getattr(result, 'content', None)),
        'error': _ensure_serializable(getattr(result, 'content', None) if not getattr(result, 'success', False) else None),
    }


def _terminate_process(process, *, wait_timeout: float = 1.0) -> None:
    if process is None:
        return
    if process.is_alive():
        process.terminate()
        process.join(wait_timeout)
    if process.is_alive() and hasattr(process, 'kill'):
        process.kill()
        process.join(wait_timeout)


def _sandbox_worker(conn, payload: dict):
    stdout_capture = io.StringIO()
    tool_calls_count = [0]
    approval_granted = [False]
    approved_imports = set(ALLOWED_IMPORT_NAMES)
    code = payload['code']

    safe_open_func = _make_safe_open(approval_granted, session_id=payload.get('session_id'), run_id=payload.get('run_id'), workspace_root=payload.get('workspace_root'))
    approval_requester = _make_ipc_approval_requester(conn)
    request_write_approval_func = _make_request_write_approval(approval_granted, approval_requester, session_id=payload.get('session_id'), run_id=payload.get('run_id'), workspace_root=payload.get('workspace_root'))
    call_tool_func = _make_call_tool_function(_make_ipc_tool_caller(conn), tool_calls_count)
    real_import = __import__

    def _safe_import(name, *args, **kwargs):
        module_root = name.split('.')[0]
        if name in ALLOWED_IMPORT_NAMES or name in approved_imports or module_root in approved_imports:
            return real_import(name, *args, **kwargs)
        snippet = _extract_import_code_snippet(code, name)
        try:
            approval_requester(
                approval_type='sandbox_module_import',
                tool_name='sandbox_module_import',
                arguments={'module_name': name, 'module_root': module_root, 'code_snippet': snippet},
                risk_level='high',
                description=f'沙箱代码请求导入受限模块: {name}',
            )
            approved_imports.add(name)
            approved_imports.add(module_root)
            return real_import(name, *args, **kwargs)
        except PermissionError as e:
            raise ImportError(f'禁止导入模块: {name}（{e}）')

    globals_dict = _build_sandbox_globals(
        safe_import=_safe_import,
        call_tool_func=call_tool_func,
        safe_open_func=safe_open_func,
        request_write_approval_func=request_write_approval_func,
        sandbox_root=Path(payload['sandbox_root']),
        workspace_root=Path(payload['current_workspace_root']) if payload.get('current_workspace_root') else None,
        transient_root=Path(payload['current_transient_root']) if payload.get('current_transient_root') else None,
        uploads_root=Path(payload['current_uploads_root']) if payload.get('current_uploads_root') else None,
        visualizations_root=Path(payload['current_visualizations_root']) if payload.get('current_visualizations_root') else None,
        exports_root=Path(payload['current_exports_root']) if payload.get('current_exports_root') else None,
    )

    try:
        with redirect_stdout(stdout_capture):
            exec(code, globals_dict)
        if 'result' not in globals_dict:
            conn.send({'type': 'done', 'success': False, 'error': '代码必须设置 result 变量作为输出', 'stdout': stdout_capture.getvalue(), 'tool_calls_count': tool_calls_count[0]})
            return
        conn.send({'type': 'done', 'success': True, 'result': _ensure_serializable(globals_dict['result']), 'stdout': stdout_capture.getvalue(), 'tool_calls_count': tool_calls_count[0]})
    except BaseException as e:
        conn.send({'type': 'done', 'success': False, 'error': str(e), 'stdout': stdout_capture.getvalue(), 'tool_calls_count': tool_calls_count[0]})
    finally:
        conn.close()


def _static_code_check(code: str) -> tuple[bool, Optional[str]]:
    import ast

    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split('.')[0] in _FORBIDDEN_MODULES:
                        return False, f"禁止导入模块: {alias.name}"
            elif isinstance(node, ast.ImportFrom):
                if node.module and node.module.split('.')[0] in _FORBIDDEN_MODULES:
                    return False, f"禁止导入模块: {node.module}"
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in _FORBIDDEN_BARE_CALLS:
                    return False, f"禁止使用: {node.func.id}()"
    except SyntaxError:
        for line in code.splitlines():
            stripped = line.strip()
            if stripped.startswith('#'):
                continue
            for mod in _FORBIDDEN_MODULES:
                if f'import {mod}' in stripped or f'from {mod}' in stripped:
                    return False, f"禁止导入模块: {mod}"

    for line in code.splitlines():
        stripped = line.strip()
        if stripped.startswith('#'):
            continue
        for regex, label in _FORBIDDEN_CALL_PATTERNS:
            if regex.search(stripped):
                return False, f"禁止使用: {label}"
    return True, None


@tool(
    name="execute_code",
    description="在受限沙箱中执行 Python 代码进行复杂工具编排与数据处理。支持通过 call_tool 调用仍允许 code_execution 的工具；文件读写应使用沙箱内置的受限 open() 与 request_write_approval()，必须设置 result 变量作为输出。",
    parameters={
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Python 代码。必须设置 result 变量作为最终输出。"},
            "description": {"type": "string", "description": "代码用途说明（可选）"}
        },
        "required": ["code"]
    },
    risk_level=RiskLevel.MEDIUM,
    requires_approval=False,
    timeout_seconds=60,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "成功时返回代码中 result 变量的值",
        "shape": {
            "content": "任意 JSON 值或字符串",
            "metadata": {"stdout": "string", "tool_calls_count": "number", "execution_time": "number"},
        },
    },
    usage_contract=[
        "代码必须设置 result 变量作为最终输出",
        "需要调用工具时使用 call_tool(tool_name, arguments)，返回值是工具主内容（不是完整响应壳）",
        "call_tool() 只能调用 allowed_callers 包含 code_execution 的工具；read_file/write_file/edit_file 不再允许从 execute_code 中调用",
        "不要对 call_tool(...) 再取 ['content']；当前拿到的就是工具主内容，需要自行处理",
        "在沙箱内读取文件请直接使用受限 open(path, mode='r')；路径会按 code_execution 的受管边界解析",
        "在沙箱内写文件前，必须先调用 request_write_approval(path, reason) 获取授权；获批后再用 open(path, 'w'/'a'/...) 写入",
        "如果返回内容是标准 JSON 字符串（双引号），用 json.loads() 解析",
        "如果文件内容是 Python 字面量格式（单引号），用 ast.literal_eval() 解析（需先 import ast）",
        "禁止导入 os/sys/subprocess/shutil/socket，路径操作使用内置的 path_ops（如 path_ops.join, path_ops.basename）",
        "读取会话受管文件时优先使用 SESSION_WORKSPACE_DIR / SESSION_UPLOADS_DIR / SESSION_VISUALIZATIONS_DIR / SESSION_EXPORTS_DIR 等内置目录变量，写入沙箱文件使用 SANDBOX_DIR",
        "可用模块：math, json, re, csv, datetime, collections, itertools, functools, statistics, time, io, string, decimal, copy, textwrap, hashlib, base64",
        "复杂数据转换优先在 execute_code 内完成，再交给其他工具",
    ],
    examples=[
        {"input": {"code": "text = open('sample.json', 'r', encoding='utf-8').read()\ndata = json.loads(text)\nresult = {'name': data.get('name')}", "description": "在沙箱内读取 JSON 文件并解析"}},
        {"input": {"code": "request_write_approval('result.txt', '保存处理结果')\nwith open('result.txt', 'w', encoding='utf-8') as f:\n    f.write('done')\nresult = {'saved_to': path_ops.join(SANDBOX_DIR, 'result.txt')}", "description": "在沙箱内申请写权限后保存结果文件"}},
    ],
)
def execute_code_sandbox(code: str, description: str = "", timeout: int = 30, agent_config=None, event_bus=None, user_role=None, session_id: Optional[str] = None, cancel_event=None):
    logger.info('执行代码沙箱: %s', description or '无描述')
    start_time = _time.time()

    _publish_execution_event(event_bus, 'start', session_id=session_id, description=description, code_preview=code[:200])

    passed, error_msg = _static_code_check(code)
    if not passed:
        return error_result(f"代码安全检查失败: {error_msg}", tool_name='execute_code')

    sandbox_root = get_code_execution_session_root(session_id) if session_id else SANDBOX_ROOT
    sandbox_root.mkdir(parents=True, exist_ok=True)

    workspace_root = None
    if agent_config and hasattr(agent_config, 'custom_params'):
        custom_params = agent_config.custom_params if isinstance(agent_config.custom_params, dict) else {}
        workspace_root = custom_params.get('workspace_root')

    try:
        from execution.observability import get_current_execution_observability_fields
        current_run_id = get_current_execution_observability_fields().get('run_id')
    except Exception:
        current_run_id = None

    current_workspace_root = get_session_workspace_root(session_id) if session_id else None
    current_transient_root = get_session_transient_root(session_id) if session_id else None
    current_uploads_root = get_session_uploads_root(session_id) if session_id else None
    current_visualizations_root = get_session_visualizations_root(session_id) if session_id else None
    current_exports_root = get_session_exports_root(session_id) if session_id else None

    from utils.timeout_pause import PausableTimer, get_current_timer, set_current_timer

    timer = get_current_timer()
    if timer is None:
        timer = PausableTimer()
        set_current_timer(timer)
    paused_at_start = timer.paused_duration
    started_at = _time.monotonic()

    parent_tool_caller = _make_parent_tool_caller(agent_config, event_bus, user_role, session_id=session_id, cancel_event=cancel_event)
    ipc_approval_requester = lambda **kwargs: _request_sandbox_approval(event_bus, session_id, **kwargs)

    ctx = multiprocessing.get_context('spawn')
    parent_conn, child_conn = ctx.Pipe(duplex=True)
    process = ctx.Process(
        target=_sandbox_worker,
        args=(child_conn, {
            'code': code,
            'session_id': session_id,
            'run_id': current_run_id,
            'workspace_root': workspace_root,
            'sandbox_root': str(sandbox_root),
            'current_workspace_root': str(current_workspace_root) if current_workspace_root else None,
            'current_transient_root': str(current_transient_root) if current_transient_root else None,
            'current_uploads_root': str(current_uploads_root) if current_uploads_root else None,
            'current_visualizations_root': str(current_visualizations_root) if current_visualizations_root else None,
            'current_exports_root': str(current_exports_root) if current_exports_root else None,
        }),
    )
    process.daemon = True
    process.start()
    child_conn.close()

    done_message = None
    try:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                _terminate_process(process)
                return error_result('代码执行失败: 执行已取消', tool_name='execute_code')

            if timeout > 0:
                elapsed = _time.monotonic() - started_at - (timer.paused_duration - paused_at_start)
                if elapsed >= timeout:
                    _terminate_process(process)
                    return error_result(f"代码执行失败: 代码执行超时（超过 {timeout} 秒）", tool_name='execute_code')

            if parent_conn.poll(0.1):
                try:
                    message = parent_conn.recv()
                except EOFError:
                    break

                msg_type = message.get('type')
                if msg_type == 'tool_call':
                    try:
                        content = parent_tool_caller(message.get('tool_name'), message.get('arguments') or {})
                        parent_conn.send({'type': 'tool_result', 'request_id': message.get('request_id'), 'success': True, 'content': _ensure_serializable(content)})
                    except BaseException as e:
                        parent_conn.send({'type': 'tool_result', 'request_id': message.get('request_id'), 'success': False, 'error': str(e), 'content': None})
                elif msg_type == 'approval_request':
                    try:
                        approval_message = ipc_approval_requester(
                            approval_type=message.get('approval_type'),
                            tool_name=message.get('tool_name'),
                            arguments=message.get('arguments') or {},
                            risk_level=message.get('risk_level') or 'high',
                            description=message.get('description') or '',
                        )
                        parent_conn.send({'type': 'approval_result', 'request_id': message.get('request_id'), 'approved': True, 'message': approval_message})
                    except PermissionError as e:
                        parent_conn.send({'type': 'approval_result', 'request_id': message.get('request_id'), 'approved': False, 'message': str(e)})
                elif msg_type == 'done':
                    done_message = message
                    break

            if not process.is_alive() and not parent_conn.poll():
                break

        process.join(timeout=1.0)
        if done_message is None:
            return error_result('代码执行失败: 沙箱进程异常退出', tool_name='execute_code')
        if not done_message.get('success'):
            return error_result(f"代码执行失败: {done_message.get('error')}", tool_name='execute_code')

        result_value = done_message.get('result')
        stdout_text = done_message.get('stdout', '')
        tool_calls_count = done_message.get('tool_calls_count', 0)
        execution_time = _time.time() - start_time

        _publish_execution_event(event_bus, 'end', session_id=session_id, result=result_value, execution_time=execution_time, tool_calls_count=tool_calls_count)
        return success_result(
            content=result_value,
            metadata={'stdout': stdout_text, 'tool_calls_count': tool_calls_count, 'execution_time': execution_time},
            summary=f"代码执行成功，工具调用 {tool_calls_count} 次",
            output_type='json' if not isinstance(result_value, str) else 'text',
            tool_name='execute_code',
        )
    except Exception as e:
        logger.error('代码沙箱异常: %s', e, exc_info=True)
        return error_result(f"代码执行异常: {e}", tool_name='execute_code')
    finally:
        _terminate_process(process)
        parent_conn.close()


def _publish_execution_event(event_bus, phase: str, **kwargs):
    if not event_bus:
        return
    try:
        from agents.events.bus import Event, EventType
        session_id = kwargs.get('session_id')
        if phase == 'start':
            event = Event(type=EventType.CODE_EXECUTION_START, data={'description': kwargs.get('description', ''), 'code_preview': kwargs.get('code_preview', '')}, session_id=session_id)
        else:
            event = Event(type=EventType.CODE_EXECUTION_END, data={'result_preview': str(kwargs.get('result', ''))[:500], 'execution_time': kwargs.get('execution_time', 0), 'tool_calls_count': kwargs.get('tool_calls_count', 0)}, session_id=session_id)
        event_bus.publish(event)
    except Exception as e:
        logger.debug('发布代码执行事件失败: %s', e)
