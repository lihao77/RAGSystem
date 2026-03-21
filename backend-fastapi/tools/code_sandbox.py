# -*- coding: utf-8 -*-
"""
代码沙箱执行引擎 - PTC (Programmatic Tool Calling)

提供受限的 Python 代码执行环境，支持：
- 在代码中调用其他工具（call_tool 函数）
- 复杂逻辑编排（循环、条件判断、数据聚合）
- 中间结果隔离（不占用对话上下文）
- 受限文件读写（仅限沙箱目录，写操作需用户审批）
- 安全限制（禁止系统模块、路径穿越、超时保护）
"""

import io
import os
import sys
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
from typing import Dict, Any, Optional
from contextlib import redirect_stdout
import threading

from agents.task_registry import get_task_registry
from tools.response_builder import success_result, error_result
from tools.permissions import check_tool_permission, RiskLevel
from tools.decorators import tool

logger = logging.getLogger(__name__)

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

# 沙箱根目录（无 session 时的默认目录）
SANDBOX_ROOT = get_session_sandbox_root("anonymous")
SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)

# 写操作 mode 集合
_WRITE_MODES = {'w', 'a', 'x', 'wb', 'ab', 'xb', 'w+', 'a+', 'r+', 'w+b', 'a+b', 'r+b'}

# 允许的模块（白名单）
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

# 允许导入的模块名集合（用于安全的 __import__）
ALLOWED_IMPORT_NAMES = set(ALLOWED_MODULES.keys()) | {
    # 子模块和内部依赖
    'collections.abc', 'datetime', 'math', 'json',
    're', 'csv', 'itertools', 'functools', 'statistics',
    '_datetime', '_collections', '_collections_abc',
    '_functools', '_itertools', '_statistics',
    '_json', 'json.decoder', 'json.encoder', 'json.scanner',
    'time', '_strptime',  # datetime 内部依赖
    '_csv',  # csv 内部依赖
    # ast（安全的字面量解析，用于 ast.literal_eval）
    'ast', '_ast',
    # io 内部依赖
    '_io', 'io',
    # decimal 内部依赖
    '_decimal', '_pydecimal', 'numbers',
    # hashlib 内部依赖
    '_hashlib', '_blake2', '_sha256', '_sha512', '_sha1', '_sha3', '_md5',
    # base64 内部依赖
    'binascii',
    # copy 内部依赖
    'copyreg', '_copy',
    # struct 内部依赖
    '_struct',
    # operator 内部依赖
    '_operator',
    # textwrap 内部依赖
    '_textwrap',
    # string 内部依赖
    '_string',
}

# 禁止导入的模块（AST 阶段检查）
_FORBIDDEN_MODULES = {'os', 'sys', 'subprocess', 'shutil', 'socket'}

# 禁止的调用模式（行级正则检查，跳过注释行）
# 使用 \b 词边界避免误杀 ast.literal_eval() 等合法调用
_FORBIDDEN_CALL_PATTERNS = [
    (re.compile(r'__import__'), '__import__'),
    (re.compile(r'(?<![.\w])eval\s*\('), 'eval('),    # 独立 eval(，不匹配 literal_eval( 或 obj.eval(
    (re.compile(r'(?<![.\w])exec\s*\('), 'exec('),    # 独立 exec(，不匹配 obj.exec(
    (re.compile(r'(?<![.\w])globals\s*\('), 'globals('),
    (re.compile(r'(?<![.\w])locals\s*\('), 'locals('),
]

# 禁止的独立函数调用（AST 阶段精确检查，不误杀 re.compile 等属性调用）
_FORBIDDEN_BARE_CALLS = {'compile'}


class SafePathOps:
    """沙箱内安全路径操作，替代 os.path"""
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
    """将沙箱结果转换为 JSON 可序列化的类型"""
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
    # 尝试 JSON 序列化，失败则 str()
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def _extract_import_code_snippet(code: str, module_name: str, context_lines: int = 2) -> str:
    """
    提取与模块导入相关的代码片段，供前端审批展示。
    """
    lines = code.splitlines()
    if not lines:
        return ""

    module_root = module_name.split('.')[0]
    matched_indexes = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if 'import ' not in stripped:
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
    """
    复用通用审批事件，请求前端确认后继续执行。

    Returns:
        用户审批附言（可能为空字符串）
    """
    if not event_bus:
        raise PermissionError("当前上下文无事件总线，无法发起审批")
    if not session_id:
        raise PermissionError("当前上下文缺少 session_id，无法等待用户审批")

    try:
        import uuid
        from agents.events import Event, EventType

        approval_id = str(uuid.uuid4())
        registry = get_task_registry()
        wait_evt = registry.add_pending_approval(session_id, approval_id)
        if wait_evt is None:
            raise PermissionError("当前上下文无法注册审批请求")

        event_bus.publish(Event(
            type=EventType.USER_APPROVAL_REQUIRED,
            session_id=session_id,
            data={
                "approval_id": approval_id,
                "approval_type": approval_type,
                "tool_name": tool_name,
                "arguments": arguments,
                "risk_level": risk_level,
                "description": description,
            },
        ))

        from utils.timeout_pause import pause_current, resume_current

        pause_current()
        try:
            wait_evt.wait()
        finally:
            resume_current()
        approved, approval_message = registry.get_approval_result(session_id, approval_id)
    except PermissionError:
        raise
    except Exception as e:
        logger.error(f"发起沙箱审批失败: {e}")
        raise PermissionError(f"审批请求发送失败: {e}")

    if not approved:
        deny_reason = approval_message or "用户拒绝执行此操作"
        raise PermissionError(deny_reason)

    return approval_message or ""


def _make_safe_open(
    event_bus,
    approval_granted: list,
    *,
    session_id: str | None = None,
    run_id: str | None = None,
    workspace_root: str | None = None,
):
    """
    创建受限的 safe_open 函数注入到沙箱：
    - 读操作：通过统一 resolver 解析，可读取 sandbox 与当前 session 的受管文件
    - 写操作：通过统一 resolver 解析，但仅允许写入当前 session 的 sandbox，且需要预先审批
    """

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
                raise PermissionError(
                    "文件写操作需要用户审批，请在代码中先调用 request_write_approval(path) 获取授权"
                )
            resolved.parent.mkdir(parents=True, exist_ok=True)
            logger.info(f"沙箱写文件: {resolved}")

        open_kwargs = {}
        if encoding is not None:
            open_kwargs['encoding'] = encoding
        elif 'b' not in mode:
            open_kwargs['encoding'] = 'utf-8'

        return open(resolved, mode, **{**open_kwargs, **kwargs})

    return safe_open


def _make_request_write_approval(
    event_bus,
    approval_granted: list,
    *,
    session_id: str | None = None,
    run_id: str | None = None,
    workspace_root: str | None = None,
):
    """
    创建 request_write_approval 函数，代码调用后发布审批事件并阻塞等待结果。
    审批通过后设置 approval_granted[0] = True，后续 safe_open 写操作即可放行。
    """

    def request_write_approval(path: str, reason: str = ""):
        """
        请求用户审批文件写操作。
        Args:
            path: 要写入的文件路径（相对 sandbox 或受管展示路径）
            reason: 写入原因说明
        Returns:
            True 表示已批准
        Raises:
            PermissionError: 用户拒绝或超时
        """
        resolved = resolve_managed_path(
            str(path),
            session_id=session_id,
            run_id=run_id,
            caller='code_execution',
            operation='write',
            workspace_root=workspace_root,
        )
        try:
            _request_sandbox_approval(
                event_bus,
                session_id,
                approval_type="sandbox_file_write",
                tool_name="sandbox_file_write",
                arguments={"path": str(resolved), "reason": reason},
                risk_level="high",
                description=f"沙箱代码请求写入文件: {resolved.name}"
                + (f"，原因：{reason}" if reason else ""),
            )
        except PermissionError as e:
            raise PermissionError(f"文件写操作已取消: {resolved}，原因: {e}")

        approval_granted[0] = True
        logger.info(f"文件写操作已获批准: {resolved}")
        return True

    return request_write_approval


def _make_call_tool_function(agent_config, event_bus, user_role, session_id: Optional[str] = None):
    """
    创建 call_tool 函数供代码调用

    Args:
        agent_config: 智能体配置
        event_bus: 事件总线
        user_role: 用户角色

    Returns:
        call_tool 函数
    """
    def call_tool(tool_name: str, arguments: dict) -> Any:
        """
        在代码中调用工具

        Args:
            tool_name: 工具名称
            arguments: 工具参数

        Returns:
            工具执行结果的主内容（ToolExecutionResult.content）

        Raises:
            PermissionError: 工具不允许从代码调用
            RuntimeError: 工具执行失败
        """
        from tools.result_references import (
            result_error_message,
            result_primary_content,
            result_success,
        )

        # 1. 检查 allowed_callers
        allowed, error_msg = check_tool_permission(
            tool_name=tool_name,
            agent_config=agent_config,
            user_role=user_role,
            caller="code_execution"  # 标识调用来源
        )

        if not allowed:
            raise PermissionError(f"工具 '{tool_name}' 不允许从代码调用: {error_msg}")

        # 2. 执行工具
        from tools.tool_executor import execute_tool

        result = execute_tool(
            tool_name=tool_name,
            arguments=arguments,
            agent_config=agent_config,
            event_bus=event_bus,
            user_role=user_role,
            caller="code_execution",  # 传递调用来源
            session_id=session_id,
        )

        # 3. 检查成功
        if not result_success(result):
            raise RuntimeError(f"工具 '{tool_name}' 执行失败: {result_error_message(result)}")

        # 4. 返回实际数据（不是完整响应）
        return result_primary_content(result)

    return call_tool


def _static_code_check(code: str) -> tuple[bool, Optional[str]]:
    """
    静态代码检查（两阶段）

    阶段1：AST 解析，精确检查 import/from...import 中的禁止模块
    阶段2：逐行检查危险调用模式（跳过注释行）

    Args:
        code: 待检查的代码

    Returns:
        (是否通过, 错误消息)
    """
    import ast

    # 阶段1：AST 检查禁止的 import + 禁止的独立函数调用
    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = alias.name.split('.')[0]
                    if root in _FORBIDDEN_MODULES:
                        return False, f"禁止导入模块: {alias.name}"
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    root = node.module.split('.')[0]
                    if root in _FORBIDDEN_MODULES:
                        return False, f"禁止导入模块: {node.module}"
            elif isinstance(node, ast.Call):
                # 拦截独立的 compile() 调用，但放行 re.compile() 等属性调用
                func = node.func
                if isinstance(func, ast.Name) and func.id in _FORBIDDEN_BARE_CALLS:
                    return False, f"禁止使用: {func.id}()"
    except SyntaxError:
        # AST 解析失败时回退到行级检查 import
        for line in code.splitlines():
            stripped = line.strip()
            if stripped.startswith('#'):
                continue
            for mod in _FORBIDDEN_MODULES:
                if f'import {mod}' in stripped or f'from {mod}' in stripped:
                    return False, f"禁止导入模块: {mod}"

    # 阶段2：逐行检查危险调用模式（跳过注释行）
    for line in code.splitlines():
        stripped = line.strip()
        if stripped.startswith('#'):
            continue
        for regex, label in _FORBIDDEN_CALL_PATTERNS:
            if regex.search(stripped):
                return False, f"禁止使用: {label}"

    return True, None


def _execute_with_timeout(code: str, globals_dict: dict, timeout: int, stdout_capture: io.StringIO) -> tuple[bool, Optional[str]]:
    """
    在超时限制下执行代码（Windows 兼容，感知审批暂停）

    优先复用外层 dispatcher 传入的 PausableTimer，使沙箱内 call_tool 触发审批时
    pause_current/resume_current 能同时暂停外层超时计时，避免审批等待被算入超时。

    Args:
        code: 待执行的代码
        globals_dict: 全局变量字典
        timeout: 超时时间（秒）
        stdout_capture: 标准输出捕获对象

    Returns:
        (是否成功, 错误消息)
    """
    from utils.timeout_pause import PausableTimer, set_current_timer, get_current_timer

    result = {'success': False, 'error': None}
    # 优先复用外层 dispatcher 的 timer，使审批暂停能传播到外层超时
    timer = get_current_timer() or PausableTimer()

    def target():
        # 绑定 timer 到执行线程，使审批流程中的 pause_current/resume_current 生效
        set_current_timer(timer)
        try:
            with redirect_stdout(stdout_capture):
                exec(code, globals_dict)
            result['success'] = True
        except Exception as e:
            result['error'] = str(e)

    thread = threading.Thread(target=target)
    thread.daemon = True
    start = _time.monotonic()
    paused_at_start = timer.paused_duration
    thread.start()

    # 轮询等待，扣除暂停时长后判断是否超时
    while thread.is_alive():
        thread.join(timeout=1.0)
        if not thread.is_alive():
            break
        elapsed = _time.monotonic() - start - (timer.paused_duration - paused_at_start)
        if elapsed >= timeout:
            return False, f"代码执行超时（超过 {timeout} 秒）"

    if not result['success']:
        return False, result['error']

    return True, None


@tool(
    name="execute_code",
    description="在受限沙箱中执行 Python 代码进行复杂工具编排与数据处理。支持通过 call_tool 调用允许的其他工具，必须设置 result 变量作为输出。",
    parameters={
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "Python 代码。必须设置 result 变量作为最终输出。"
            },
            "description": {
                "type": "string",
                "description": "代码用途说明（可选）"
            }
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
            "metadata": {
                "stdout": "string",
                "tool_calls_count": "number",
                "execution_time": "number",
            },
        },
    },
    usage_contract=[
        "代码必须设置 result 变量作为最终输出",
        "需要调用工具时使用 call_tool(tool_name, arguments)，返回值是工具主内容（不是完整响应壳）",
        "不要对 call_tool(...) 再取 ['content']；read_file 返回的是文件内容字符串，直接使用即可",
        "如果返回内容是标准 JSON 字符串（双引号），用 json.loads() 解析",
        "如果文件内容是 Python 字面量格式（单引号），用 ast.literal_eval() 解析（需先 import ast）",
        "禁止导入 os/sys/subprocess/shutil/socket，路径操作使用内置的 path_ops（如 path_ops.join, path_ops.basename）",
        "读取数据文件时使用 DATA_DIR 变量拼接路径（如 open(f'{DATA_DIR}/xxx.json')），写入文件使用 SANDBOX_DIR",
        "可用模块：math, json, re, csv, datetime, collections, itertools, functools, statistics, time, io, string, decimal, copy, textwrap, hashlib, base64",
        "复杂数据转换优先在 execute_code 内完成，再交给其他工具",
    ],
    examples=[
        {
            "input": {
                "code": "rows = call_tool('read_file', {'file_path': './data/sample.json'})\nresult = rows",
                "description": "读取文件并返回内容",
            }
        }
    ],
)
def execute_code_sandbox(
    code: str,
    description: str = "",
    timeout: int = 30,
    agent_config=None,
    event_bus=None,
    user_role=None,
    session_id: Optional[str] = None,
):
    """
    在受限沙箱中执行 Python 代码

    Args:
        code: Python 代码（必须设置 result 变量作为输出）
        description: 代码功能描述（可选）
        timeout: 超时时间（秒，默认 30）
        agent_config: 智能体配置
        event_bus: 事件总线
        user_role: 用户角色

    Returns:
        标准化响应：
        {
            "success": bool,
            "data": {
                "results": Any,  # result 变量的值
                "stdout": str,   # 标准输出
                "tool_calls_count": int  # 工具调用次数
            },
            "error": str  # 失败时的错误消息
        }
    """
    logger.info(f"执行代码沙箱: {description or '无描述'}")

    start_time = _time.time()

    # 发布代码执行开始事件
    _publish_execution_event(
        event_bus,
        "start",
        session_id=session_id,
        description=description,
        code_preview=code[:200],
    )

    # 1. 静态代码检查
    passed, error_msg = _static_code_check(code)
    if not passed:
        logger.warning(f"静态代码检查失败: {error_msg}")
        return error_result(f"代码安全检查失败: {error_msg}", tool_name="execute_code")

    # 1.5 计算 session 级沙箱目录
    _sandbox_root = get_code_execution_session_root(session_id) if session_id else SANDBOX_ROOT
    _sandbox_root.mkdir(parents=True, exist_ok=True)

    _sandbox_root.mkdir(parents=True, exist_ok=True)

    # 2. 准备执行环境
    call_tool_func = _make_call_tool_function(
        agent_config,
        event_bus,
        user_role,
        session_id=session_id,
    )

    # 工具调用计数器
    tool_calls_count = [0]  # 使用列表以便在闭包中修改

    def counted_call_tool(tool_name: str, arguments: dict):
        tool_calls_count[0] += 1
        return call_tool_func(tool_name, arguments)

    # 文件写操作审批状态（每次执行独立）
    approval_granted = [False]
    approved_imports = set(ALLOWED_IMPORT_NAMES)

    if agent_config and hasattr(agent_config, 'custom_params'):
        cp = agent_config.custom_params if isinstance(agent_config.custom_params, dict) else {}
        _workspace_root = cp.get('workspace_root')
    else:
        _workspace_root = None

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

    safe_open_func = _make_safe_open(
        event_bus,
        approval_granted,
        session_id=session_id,
        run_id=current_run_id,
        workspace_root=_workspace_root,
    )
    request_write_approval_func = _make_request_write_approval(
        event_bus,
        approval_granted,
        session_id=session_id,
        run_id=current_run_id,
        workspace_root=_workspace_root,
    )

    _real_import = __builtins__.__import__ if hasattr(__builtins__, '__import__') else __import__

    def _safe_import(name, *args, **kwargs):
        """安全的 import 函数，只允许导入白名单模块"""
        module_root = name.split('.')[0]
        if (
            name in ALLOWED_IMPORT_NAMES
            or name in approved_imports
            or module_root in approved_imports
        ):
            return _real_import(name, *args, **kwargs)

        snippet = _extract_import_code_snippet(code, name)
        try:
            approval_message = _request_sandbox_approval(
                event_bus,
                session_id,
                approval_type="sandbox_module_import",
                tool_name="sandbox_module_import",
                arguments={
                    "module_name": name,
                    "module_root": module_root,
                    "code_snippet": snippet,
                },
                risk_level="high",
                description=f"沙箱代码请求导入受限模块: {name}",
            )
            approved_imports.add(name)
            approved_imports.add(module_root)
            logger.info(
                "沙箱模块导入已获批准: %s%s",
                name,
                f"；用户附言: {approval_message}" if approval_message else "",
            )
            return _real_import(name, *args, **kwargs)
        except PermissionError as e:
            raise ImportError(f"禁止导入模块: {name}（{e}）")

    # 构建全局变量字典
    globals_dict = {
        '__builtins__': {
            # import 支持（受限）
            '__import__': _safe_import,
            # 基本函数
            'print': print,
            'len': len,
            'range': range,
            'enumerate': enumerate,
            'zip': zip,
            'map': map,
            'filter': filter,
            'sum': sum,
            'min': min,
            'max': max,
            'abs': abs,
            'round': round,
            'sorted': sorted,
            'reversed': reversed,
            'any': any,
            'all': all,
            'isinstance': isinstance,
            'issubclass': issubclass,
            'hasattr': hasattr,
            'callable': callable,
            'ascii': ascii,
            'getattr': getattr,
            'setattr': setattr,
            'delattr': delattr,
            'id': id,
            'hash': hash,
            'repr': repr,
            'format': format,
            'iter': iter,
            'next': next,
            'chr': chr,
            'ord': ord,
            'hex': hex,
            'oct': oct,
            'bin': bin,
            'pow': pow,
            'divmod': divmod,
            'slice': slice,
            # 类型
            'int': int,
            'float': float,
            'str': str,
            'bool': bool,
            'list': list,
            'dict': dict,
            'set': set,
            'tuple': tuple,
            'frozenset': frozenset,
            'bytes': bytes,
            'bytearray': bytearray,
            'complex': complex,
            'type': type,
            'object': object,
            'property': property,
            'staticmethod': staticmethod,
            'classmethod': classmethod,
            'super': super,
            # 异常
            'Exception': Exception,
            'BaseException': BaseException,
            'ValueError': ValueError,
            'TypeError': TypeError,
            'KeyError': KeyError,
            'IndexError': IndexError,
            'AttributeError': AttributeError,
            'RuntimeError': RuntimeError,
            'StopIteration': StopIteration,
            'ZeroDivisionError': ZeroDivisionError,
            'OverflowError': OverflowError,
            'PermissionError': PermissionError,
            'NotImplementedError': NotImplementedError,
            'FileNotFoundError': FileNotFoundError,
            'IOError': IOError,
            'ArithmeticError': ArithmeticError,
            'LookupError': LookupError,
            # 常量
            'True': True,
            'False': False,
            'None': None,
        },
        # 允许的模块
        **ALLOWED_MODULES,
        # 工具调用函数
        'call_tool': counted_call_tool,
        # 受限文件操作
        'open': safe_open_func,                              # 替代内置 open，复用统一受管路径规则
        'request_write_approval': request_write_approval_func,  # 写操作前请求审批
        'SANDBOX_DIR': str(_sandbox_root),                   # 当前 session 的 sandbox 目录
        'DATA_DIR': str(current_workspace_root or current_visualizations_root or _sandbox_root),
        'SESSION_TRANSIENT_DIR': str(current_transient_root or _sandbox_root),
        'SESSION_UPLOADS_DIR': str(current_uploads_root or _sandbox_root),
        'SESSION_VISUALIZATIONS_DIR': str(current_visualizations_root or _sandbox_root),
        'SESSION_EXPORTS_DIR': str(current_exports_root or _sandbox_root),
        'SESSION_WORKSPACE_DIR': str(current_workspace_root or _sandbox_root),
        'path_ops': _safe_path_ops,                            # 安全路径操作（替代 os.path）
    }

    # 3. 捕获标准输出
    stdout_capture = io.StringIO()

    try:
        # 4. 执行代码（带超时，stdout 在线程内捕获）
        success, error_msg = _execute_with_timeout(code, globals_dict, timeout, stdout_capture)

        if not success:
            logger.error(f"代码执行失败: {error_msg}")
            return error_result(f"代码执行失败: {error_msg}", tool_name="execute_code")

        # 5. 获取结果
        if 'result' not in globals_dict:
            return error_result("代码必须设置 result 变量作为输出", tool_name="execute_code")

        result_value = _ensure_serializable(globals_dict['result'])
        stdout_text = stdout_capture.getvalue()

        logger.info(f"代码执行成功，工具调用次数: {tool_calls_count[0]}")

        execution_time = _time.time() - start_time

        # 发布代码执行结束事件
        _publish_execution_event(
            event_bus, "end",
            session_id=session_id,
            result=result_value,
            execution_time=execution_time,
            tool_calls_count=tool_calls_count[0]
        )

        return success_result(
            content=result_value,
            metadata={
                "stdout": stdout_text,
                "tool_calls_count": tool_calls_count[0],
                "execution_time": execution_time
            },
            summary=f"代码执行成功，工具调用 {tool_calls_count[0]} 次",
            output_type="json" if not isinstance(result_value, str) else "text",
            tool_name="execute_code",
        )

    except Exception as e:
        logger.error(f"代码沙箱异常: {str(e)}", exc_info=True)
        return error_result(f"代码执行异常: {str(e)}", tool_name="execute_code")


def _publish_execution_event(event_bus, phase: str, **kwargs):
    """
    发布代码执行事件（内部辅助函数）

    Args:
        event_bus: 事件总线
        phase: "start" 或 "end"
        **kwargs: 事件数据
    """
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
                    "code_preview": kwargs.get("code_preview", "")
                },
                session_id=session_id,
            )
        else:
            event = Event(
                type=EventType.CODE_EXECUTION_END,
                data={
                    "result_preview": str(kwargs.get("result", ""))[:500],
                    "execution_time": kwargs.get("execution_time", 0),
                    "tool_calls_count": kwargs.get("tool_calls_count", 0)
                },
                session_id=session_id,
            )

        event_bus.publish(event)
    except Exception as e:
        logger.debug(f"发布代码执行事件失败: {e}")
