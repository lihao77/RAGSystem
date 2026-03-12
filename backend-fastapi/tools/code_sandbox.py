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
from pathlib import Path
from typing import Dict, Any, Optional
from contextlib import redirect_stdout
import threading

from tools.response_builder import success_result, error_result
from tools.permissions import check_tool_permission

logger = logging.getLogger(__name__)

# 沙箱根目录（所有文件读写必须在此目录下）
_BACKEND_DIR = Path(__file__).parent.parent
SANDBOX_ROOT = _BACKEND_DIR / "data" / "sandbox"
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
    'statistics': statistics
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
}

# 禁止的模式（静态检查）—— open( 已由 safe_open 替代，不再禁止
FORBIDDEN_PATTERNS = [
    'import os', 'from os',
    'import sys', 'from sys',
    'import subprocess', 'from subprocess',
    'import shutil', 'from shutil',
    'import socket', 'from socket',
    '__import__', 'eval(', 'exec(', 'compile(',
    'file(', 'globals(', 'locals(', 'getattr(', 'setattr(',
    'delattr(', 'vars('
]


def _resolve_sandbox_path(path: str) -> Path:
    """
    将用户传入的路径解析为沙箱内的绝对路径。
    - 相对路径：相对于 SANDBOX_ROOT
    - 绝对路径：必须在 SANDBOX_ROOT 下，否则拒绝
    防止 ../ 路径穿越攻击。
    """
    p = Path(path)
    if not p.is_absolute():
        resolved = (SANDBOX_ROOT / p).resolve()
    else:
        resolved = p.resolve()

    try:
        resolved.relative_to(SANDBOX_ROOT.resolve())
    except ValueError:
        raise PermissionError(
            f"路径 '{path}' 超出沙箱目录 ({SANDBOX_ROOT})，禁止访问"
        )
    return resolved


def _make_safe_open(event_bus, approval_granted: list):
    """
    创建受限的 safe_open 函数注入到沙箱：
    - 读操作（r/rb）：直接允许，路径必须在沙箱内
    - 写操作（w/a/x 等）：需要用户已审批（approval_granted[0] == True）
    """
    def safe_open(path, mode='r', encoding=None, **kwargs):
        resolved = _resolve_sandbox_path(str(path))
        is_write = mode.replace('t', '').replace('b', '').replace('+', '') in ('w', 'a', 'x') \
                   or '+' in mode and 'r' not in mode
        # 更简单可靠的写模式判断
        normalized = mode.replace('t', '')
        is_write = any(c in normalized for c in ('w', 'a', 'x')) or ('+' in normalized)

        if is_write:
            if not approval_granted[0]:
                raise PermissionError(
                    "文件写操作需要用户审批，请在代码中先调用 request_write_approval(path) 获取授权"
                )
            # 自动创建父目录
            resolved.parent.mkdir(parents=True, exist_ok=True)
            logger.info(f"沙箱写文件: {resolved}")

        open_kwargs = {}
        if encoding is not None:
            open_kwargs['encoding'] = encoding
        elif 'b' not in mode:
            open_kwargs['encoding'] = 'utf-8'

        return open(resolved, mode, **{**open_kwargs, **kwargs})

    return safe_open


def _make_request_write_approval(event_bus, approval_granted: list, session_id: str = None):
    """
    创建 request_write_approval 函数，代码调用后发布审批事件并阻塞等待结果（最多60秒）。
    审批通过后设置 approval_granted[0] = True，后续 safe_open 写操作即可放行。
    """
    import threading

    def request_write_approval(path: str, reason: str = ""):
        """
        请求用户审批文件写操作。
        Args:
            path: 要写入的文件路径（相对沙箱目录）
            reason: 写入原因说明
        Returns:
            True 表示已批准
        Raises:
            PermissionError: 用户拒绝或超时
        """
        resolved = _resolve_sandbox_path(str(path))
        approved_event = threading.Event()
        result_holder = [None]

        if event_bus:
            try:
                from agents.events.bus import Event, EventType
                import uuid
                approval_id = str(uuid.uuid4())

                def on_approval(event):
                    data = event.data or {}
                    if data.get('approval_id') == approval_id:
                        result_holder[0] = data.get('approved', False)
                        approved_event.set()

                sub_id = event_bus.subscribe(
                    event_types=[EventType.USER_APPROVAL_GRANTED, EventType.USER_APPROVAL_DENIED],
                    handler=on_approval
                )

                event_bus.publish(Event(
                    type=EventType.USER_APPROVAL_REQUIRED,
                    data={
                        "approval_id": approval_id,
                        "tool_name": "sandbox_file_write",
                        "arguments": {"path": str(resolved), "reason": reason},
                        "risk_level": "high",
                        "description": f"沙箱代码请求写入文件: {resolved.name}"
                            + (f"，原因：{reason}" if reason else ""),
                    },
                    session_id=session_id,
                ))

                approved_event.wait(timeout=60)
                event_bus.unsubscribe(sub_id)
            except Exception as e:
                logger.error(f"发布文件写审批事件失败: {e}")
                raise PermissionError(f"审批请求发送失败: {e}")
        else:
            raise PermissionError("无事件总线，无法发起审批，文件写操作被拒绝")

        if not approved_event.is_set() or not result_holder[0]:
            raise PermissionError(f"用户拒绝或审批超时，文件写操作已取消: {resolved}")

        approval_granted[0] = True
        logger.info(f"文件写操作已获批准: {resolved}")
        return True

    return request_write_approval


def _make_call_tool_function(agent_config, event_bus, user_role):
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
            caller="code_execution"  # 传递调用来源
        )

        # 3. 检查成功
        if not result_success(result):
            raise RuntimeError(f"工具 '{tool_name}' 执行失败: {result_error_message(result)}")

        # 4. 返回实际数据（不是完整响应）
        return result_primary_content(result)

    return call_tool


def _static_code_check(code: str) -> tuple[bool, Optional[str]]:
    """
    静态代码检查（检测禁止的模式）

    Args:
        code: 待检查的代码

    Returns:
        (是否通过, 错误消息)
    """
    for pattern in FORBIDDEN_PATTERNS:
        if pattern in code:
            return False, f"禁止使用: {pattern}"

    return True, None


def _execute_with_timeout(code: str, globals_dict: dict, timeout: int, stdout_capture: io.StringIO) -> tuple[bool, Optional[str]]:
    """
    在超时限制下执行代码（Windows 兼容）

    Args:
        code: 待执行的代码
        globals_dict: 全局变量字典
        timeout: 超时时间（秒）
        stdout_capture: 标准输出捕获对象

    Returns:
        (是否成功, 错误消息)
    """
    result = {'success': False, 'error': None}

    def target():
        try:
            with redirect_stdout(stdout_capture):
                exec(code, globals_dict)
            result['success'] = True
        except Exception as e:
            result['error'] = str(e)

    thread = threading.Thread(target=target)
    thread.daemon = True
    thread.start()
    thread.join(timeout)

    if thread.is_alive():
        return False, f"代码执行超时（超过 {timeout} 秒）"

    if not result['success']:
        return False, result['error']

    return True, None


def execute_code_sandbox(
    code: str,
    description: str = "",
    timeout: int = 30,
    agent_config=None,
    event_bus=None,
    user_role=None
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

    # 获取 session_id（用于审批事件关联）
    session_id = None
    if event_bus:
        try:
            session_id = getattr(event_bus, 'session_id', None)
        except Exception:
            pass

    # 发布代码执行开始事件
    _publish_execution_event(event_bus, "start", description=description, code_preview=code[:200])

    # 1. 静态代码检查
    passed, error_msg = _static_code_check(code)
    if not passed:
        logger.warning(f"静态代码检查失败: {error_msg}")
        return error_result(f"代码安全检查失败: {error_msg}", tool_name="execute_code")

    # 2. 准备执行环境
    call_tool_func = _make_call_tool_function(agent_config, event_bus, user_role)

    # 工具调用计数器
    tool_calls_count = [0]  # 使用列表以便在闭包中修改

    def counted_call_tool(tool_name: str, arguments: dict):
        tool_calls_count[0] += 1
        return call_tool_func(tool_name, arguments)

    # 文件写操作审批状态（每次执行独立）
    approval_granted = [False]
    safe_open_func = _make_safe_open(event_bus, approval_granted)
    request_write_approval_func = _make_request_write_approval(event_bus, approval_granted, session_id)

    # 构建安全的 __import__ 函数
    _real_import = __builtins__.__import__ if hasattr(__builtins__, '__import__') else __import__

    def _safe_import(name, *args, **kwargs):
        """安全的 import 函数，只允许导入白名单模块"""
        if name in ALLOWED_IMPORT_NAMES:
            return _real_import(name, *args, **kwargs)
        raise ImportError(f"禁止导入模块: {name}")

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
        'open': safe_open_func,                              # 替代内置 open，限制在沙箱目录内
        'request_write_approval': request_write_approval_func,  # 写操作前请求审批
        'SANDBOX_DIR': str(SANDBOX_ROOT),                    # 沙箱目录路径（供代码参考）
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

        result_value = globals_dict['result']
        stdout_text = stdout_capture.getvalue()

        logger.info(f"代码执行成功，工具调用次数: {tool_calls_count[0]}")

        execution_time = _time.time() - start_time

        # 发布代码执行结束事件
        _publish_execution_event(
            event_bus, "end",
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

        if phase == "start":
            event = Event(
                type=EventType.CODE_EXECUTION_START,
                data={
                    "description": kwargs.get("description", ""),
                    "code_preview": kwargs.get("code_preview", "")
                }
            )
        else:
            event = Event(
                type=EventType.CODE_EXECUTION_END,
                data={
                    "result_preview": str(kwargs.get("result", ""))[:500],
                    "execution_time": kwargs.get("execution_time", 0),
                    "tool_calls_count": kwargs.get("tool_calls_count", 0)
                }
            )

        event_bus.publish(event)
    except Exception as e:
        logger.debug(f"发布代码执行事件失败: {e}")
