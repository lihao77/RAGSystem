# -*- coding: utf-8 -*-
"""
Tool executor 分发入口。
"""

import logging
import inspect
import time
import concurrent.futures

from execution.observability import format_observability_for_log, get_current_execution_observability_fields
from tools.response_builder import error_result, success_result
from tools.result_schema import ToolExecutionResult
from tools.tool_registry import get_tool_registry
from utils.timeout_pause import set_current_timer, get_current_timer, pause_current, resume_current

logger = logging.getLogger(__name__)
_TOOL_REGISTRY = get_tool_registry()


def _obs_suffix() -> str:
    suffix = format_observability_for_log(get_current_execution_observability_fields())
    return f' [{suffix}]' if suffix else ''


def _request_user_approval_if_needed(tool_name, arguments, *, agent_config=None, event_bus=None, user_role=None, caller='direct', session_id=None):
    from tools.permissions import check_tool_permission, get_tool_permission

    allowed, error_msg = check_tool_permission(
        tool_name=tool_name,
        agent_config=agent_config,
        user_role=user_role,
        caller=caller,
    )
    if not allowed:
        logger.warning(f'工具权限检查失败: {error_msg}{_obs_suffix()}')
        return False, error_result(error_msg, tool_name=tool_name), ''

    approval_message = ''
    permission = get_tool_permission(tool_name)
    if not (permission and permission.requires_approval):
        return True, None, approval_message

    logger.info(f'工具 {tool_name} 需要用户审批{_obs_suffix()}')
    if not event_bus:
        logger.warning(f'工具 {tool_name} 需要审批但无事件总线，拒绝执行{_obs_suffix()}')
        return False, error_result(
            f'工具 {tool_name} 需要用户授权，但当前上下文不支持审批',
            tool_name=tool_name,
        ), ''

    try:
        import uuid as _uuid
        from agents.events import Event, EventType
        from agents.task_registry import get_task_registry

        approval_id = str(_uuid.uuid4())
        registry = get_task_registry()
        wait_evt = registry.add_pending_approval(session_id, approval_id) if session_id else None

        event_bus.publish(Event(
            type=EventType.USER_APPROVAL_REQUIRED,
            session_id=session_id,
            data={
                'approval_id': approval_id,
                'tool_name': tool_name,
                'arguments': arguments,
                'risk_level': permission.risk_level.value,
                'description': permission.description,
            }
        ))
        logger.info(f'已发布工具 {tool_name} 的审批请求事件 approval_id={approval_id}{_obs_suffix()}')

        if wait_evt is None:
            logger.warning(f'工具 {tool_name} 需要审批但缺少 session_id，拒绝执行{_obs_suffix()}')
            return False, error_result(
                f'工具 {tool_name} 需要用户授权，但当前上下文无法等待审批',
                tool_name=tool_name,
            ), ''

        pause_current()
        try:
            wait_evt.wait()
        finally:
            resume_current()
        approved, approval_note = registry.get_approval_result(session_id, approval_id)
        if not approved:
            logger.info(f'工具 {tool_name} 审批被拒绝或任务已停止{_obs_suffix()}')
            deny_reason = approval_note if approval_note else '用户拒绝执行此操作'
            return False, error_result(
                f'工具 {tool_name} 执行已被拒绝：{deny_reason}',
                tool_name=tool_name,
            ), ''

        logger.info(f'工具 {tool_name} 审批通过，继续执行{_obs_suffix()}')
        if approval_note:
            approval_message = approval_note
            logger.info(f'用户审批附言: {approval_note}{_obs_suffix()}')
        return True, None, approval_message
    except Exception as error:
        logger.error(f'审批流程异常: {error}{_obs_suffix()}')
        return False, error_result(f'审批流程异常: {error}', tool_name=tool_name), ''


# 需要路径预处理的文档工具（含 file_path 参数的工具）
_PATH_AWARE_DOCUMENT_TOOLS = {
    'read_document', 'read_file', 'edit_file', 'write_file', 'preview_data_structure',
}


def _preprocess_document_tool_args(
    tool_name: str,
    arguments: dict,
    *,
    workspace_root: str | None,
    default_output_space: str | None,
    session_id: str | None,
    run_id: str | None,
    caller: str,
) -> dict:
    """
    文档工具参数路径预处理：在进入 tool 前把 file_path 统一转成受管绝对路径。

    - 有 file_path 的工具：解析为绝对路径
    - write_file 未指定 file_path：分配受管输出路径
    """
    if tool_name not in _PATH_AWARE_DOCUMENT_TOOLS:
        return arguments

    from pathlib import Path as _Path
    from tools.path_resolution import (
        resolve_document_input_path,
        assign_document_output_path,
        get_code_execution_session_root,
    )

    args = dict(arguments)
    file_path = args.get('file_path')

    # 计算 sandbox_root（仅 code_execution 调用时）
    sandbox_root = None
    if caller == 'code_execution' and session_id:
        sandbox_root = get_code_execution_session_root(session_id)

    if file_path:
        # 输入路径解析
        resolved = resolve_document_input_path(
            file_path,
            workspace_root=workspace_root,
            sandbox_root=sandbox_root,
        )
        args['file_path'] = str(resolved)
    elif tool_name == 'write_file':
        # write_file 未指定路径 → 分配受管输出路径
        # 注意：mode 默认值需与 document_executor.write_file 的默认值保持一致
        mode = args.get('mode', 'text')
        suffix = '.json' if mode == 'json' else '.txt'
        assigned = assign_document_output_path(
            session_id=session_id,
            run_id=run_id,
            default_output_space=default_output_space,
            suffix=suffix,
        )
        args['file_path'] = str(assigned)

    return args


def _execute_document_tool(tool_name, arguments, *, caller='direct', event_bus=None, session_id=None, agent_config=None):
    # 从 agent_config 提取路径策略参数
    _workspace_root = None
    _default_output_space = None
    if agent_config and hasattr(agent_config, 'custom_params'):
        cp = agent_config.custom_params if isinstance(agent_config.custom_params, dict) else {}
        _workspace_root = cp.get('workspace_root')
        _default_output_space = cp.get('default_output_space')

    # 从可观测上下文获取 run_id
    current_fields = get_current_execution_observability_fields()
    _run_id = current_fields.get('run_id')

    # 统一路径预处理
    arguments = _preprocess_document_tool_args(
        tool_name,
        arguments,
        workspace_root=_workspace_root,
        default_output_space=_default_output_space,
        session_id=session_id,
        run_id=_run_id,
        caller=caller,
    )

    if tool_name == 'read_document':
        from tools.document_executor import read_document
        return read_document(**arguments)
    if tool_name == 'chunk_document':
        from tools.document_executor import chunk_document
        return chunk_document(**arguments)
    if tool_name == 'extract_structured_data':
        from tools.document_executor import extract_structured_data
        return extract_structured_data(**arguments)
    if tool_name == 'merge_extracted_data':
        from tools.document_executor import merge_extracted_data
        return merge_extracted_data(**arguments)
    if tool_name == 'write_file':
        from tools.document_executor import write_file
        return write_file(**arguments)
    if tool_name == 'read_file':
        from tools.document_executor import read_file
        return read_file(**arguments, caller=caller, event_bus=event_bus, session_id=session_id)
    if tool_name == 'preview_data_structure':
        from tools.document_executor import preview_data_structure
        return preview_data_structure(**arguments)
    if tool_name == 'edit_file':
        from tools.document_executor import edit_file
        return edit_file(**arguments)
    return None


def _execute_mcp_tool(tool_name, arguments, *, session_id=None):
    from services.mcp_service import get_mcp_service

    parsed = _TOOL_REGISTRY.parse_mcp_tool_name(tool_name)
    if not parsed:
        return error_result(f'无效的 MCP 工具名: {tool_name}', tool_name=tool_name)
    server_name, original_tool = parsed
    current_fields = get_current_execution_observability_fields()
    logger.info(
        '分发 MCP 工具 tool_name=%s server_name=%s original_tool=%s session_id=%s run_id=%s request_id=%s',
        tool_name,
        server_name,
        original_tool,
        session_id or current_fields.get('session_id'),
        current_fields.get('run_id'),
        current_fields.get('request_id'),
    )
    return get_mcp_service().call_tool(
        server_name,
        original_tool,
        arguments,
        session_id=session_id,
        run_id=current_fields.get('run_id'),
        request_id=current_fields.get('request_id'),
    )


_DEFAULT_TIMEOUT = 60


def _run_with_timeout(fn, timeout: int, tool_name: str) -> ToolExecutionResult:
    """在线程池中执行工具函数，超时返回 error_result。用户等待期间不计入超时。"""
    if timeout <= 0:
        return fn()

    parent_timer = get_current_timer()

    def _wrapped():
        # 将 timer 传递给工具执行子线程，使 pause_current/resume_current 生效
        if parent_timer is not None:
            set_current_timer(parent_timer)
        return fn()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(_wrapped)

        if parent_timer is None:
            # 不在 InProcessExecutionRunner 管理下，无需暂停感知，直接等待
            try:
                return future.result(timeout=timeout)
            except concurrent.futures.TimeoutError:
                logger.error(f"工具 {tool_name} 执行超时 ({timeout}s){_obs_suffix()}")
                return error_result(
                    f"工具 {tool_name} 执行超时（{timeout}秒）",
                    tool_name=tool_name,
                )

        # 有 timer：轮询检查，扣除用户等待时长
        start = time.monotonic()
        paused_at_start = parent_timer.paused_duration
        while True:
            try:
                return future.result(timeout=0.5)
            except concurrent.futures.TimeoutError:
                pass
            elapsed = time.monotonic() - start - (parent_timer.paused_duration - paused_at_start)
            if elapsed >= timeout:
                logger.error(f"工具 {tool_name} 执行超时 ({timeout}s){_obs_suffix()}")
                return error_result(
                    f"工具 {tool_name} 执行超时（{timeout}秒）",
                    tool_name=tool_name,
                )


def _normalize_tool_result(result, tool_name: str) -> ToolExecutionResult:
    """将工具返回值统一规范化为 ToolExecutionResult。"""
    if isinstance(result, ToolExecutionResult):
        return result
    if result is None:
        return error_result("工具返回了空结果", tool_name=tool_name)
    if isinstance(result, dict):
        return success_result(content=result, tool_name=tool_name)
    return success_result(content=str(result), tool_name=tool_name)


TOOL_HANDLERS = {
    # 所有工具已迁移到 @tool() 装饰器，启动时通过 _merge_decorated_handlers() 注入。
}


def _merge_decorated_handlers() -> None:
    """将装饰器注册的工具合并到 TOOL_HANDLERS（不覆盖已有手动注册）。"""
    from tools.decorators import get_decorated_tools
    decorated = get_decorated_tools()
    for tool_name, tool_info in decorated.items():
        if tool_name not in TOOL_HANDLERS:
            TOOL_HANDLERS[tool_name] = tool_info["handler"]
            logger.info("合并装饰器工具 handler: %s", tool_name)


DOCUMENT_TOOL_NAMES = {
    'read_document',
    'chunk_document',
    'extract_structured_data',
    'merge_extracted_data',
    'write_file',
    'read_file',
    'preview_data_structure',
    'edit_file',
}


def execute_tool(tool_name, arguments, agent_config=None, event_bus=None, user_role=None, caller='direct', session_id=None):
    """执行指定工具。"""
    try:
        allowed, approval_error_result, approval_message = _request_user_approval_if_needed(
            tool_name,
            arguments,
            agent_config=agent_config,
            event_bus=event_bus,
            user_role=user_role,
            caller=caller,
            session_id=session_id,
        )
        if not allowed:
            return approval_error_result

        from tools.permissions import get_tool_permission
        permission = get_tool_permission(tool_name)
        timeout = permission.timeout_seconds if permission else _DEFAULT_TIMEOUT

        if tool_name in TOOL_HANDLERS:
            handler = TOOL_HANDLERS[tool_name]
            call_arguments = dict(arguments)
            sig_params = inspect.signature(handler).parameters
            # 自动注入 dispatcher 级上下文参数
            _context = {
                'session_id': session_id,
                'agent_config': agent_config,
                'event_bus': event_bus,
                'user_role': user_role,
                'caller': caller,
            }
            for key, value in _context.items():
                if key in sig_params:
                    call_arguments.setdefault(key, value)
            result = _run_with_timeout(lambda: handler(**call_arguments), timeout, tool_name)
        elif tool_name in DOCUMENT_TOOL_NAMES:
            result = _run_with_timeout(
                lambda: _execute_document_tool(tool_name, arguments, caller=caller, event_bus=event_bus, session_id=session_id, agent_config=agent_config),
                timeout, tool_name,
            )
        elif _TOOL_REGISTRY.is_mcp_tool(tool_name):
            result = _execute_mcp_tool(tool_name, arguments, session_id=session_id)
        else:
            result = error_result(f'未知的工具: {tool_name}', tool_name=tool_name)

        result = _normalize_tool_result(result, tool_name)

        if approval_message and result.success:
            result.metadata.setdefault('approval_message', approval_message)
        return result
    except Exception as error:
        logger.error(f'执行工具 {tool_name} 失败: {error}{_obs_suffix()}')
        import traceback
        traceback.print_exc()
        return error_result(str(error), tool_name=tool_name)


__all__ = ['execute_tool', 'TOOL_HANDLERS']
