# -*- coding: utf-8 -*-
"""
Tool executor 分发入口。
"""

import logging

from tools.response_builder import error_response

from .data_tools import process_data_file, transform_data
from .graph_analysis import (
    aggregate_statistics,
    analyze_temporal_pattern,
    compare_entities,
    find_causal_chain,
    get_entity_geometry,
    get_spatial_neighbors,
    query_emergency_plan,
)
from .graph_query import (
    execute_cypher_query,
    get_entity_relations,
    get_graph_schema_tool,
    query_knowledge_graph_with_nl,
    search_knowledge_graph,
)
from .skill_tools import activate_skill, execute_skill_script, load_skill_resource
from .visualization_tools import generate_chart, generate_map

logger = logging.getLogger(__name__)


def _request_user_approval_if_needed(tool_name, arguments, *, agent_config=None, event_bus=None, user_role=None, caller='direct', session_id=None):
    from tools.permissions import check_tool_permission, get_tool_permission

    allowed, error_msg = check_tool_permission(
        tool_name=tool_name,
        agent_config=agent_config,
        user_role=user_role,
        caller=caller,
    )
    if not allowed:
        logger.warning(f'工具权限检查失败: {error_msg}')
        return False, error_response(error_msg), ''

    approval_message = ''
    permission = get_tool_permission(tool_name)
    if not (permission and permission.requires_approval):
        return True, None, approval_message

    logger.info(f'工具 {tool_name} 需要用户审批')
    if not event_bus:
        logger.warning(f'工具 {tool_name} 需要审批但无事件总线，拒绝执行')
        return False, error_response(f'工具 {tool_name} 需要用户授权，但当前上下文不支持审批'), ''

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
        logger.info(f'已发布工具 {tool_name} 的审批请求事件 approval_id={approval_id}')

        if wait_evt is None:
            logger.warning(f'工具 {tool_name} 需要审批但缺少 session_id，拒绝执行')
            return False, error_response(f'工具 {tool_name} 需要用户授权，但当前上下文无法等待审批'), ''

        wait_evt.wait()
        approved, approval_note = registry.get_approval_result(session_id, approval_id)
        if not approved:
            logger.info(f'工具 {tool_name} 审批被拒绝或任务已停止')
            deny_reason = approval_note if approval_note else '用户拒绝执行此操作'
            return False, error_response(f'工具 {tool_name} 执行已被拒绝：{deny_reason}'), ''

        logger.info(f'工具 {tool_name} 审批通过，继续执行')
        if approval_note:
            approval_message = approval_note
            logger.info(f'用户审批附言: {approval_note}')
        return True, None, approval_message
    except Exception as error:
        logger.error(f'审批流程异常: {error}')
        return False, error_response(f'审批流程异常: {error}'), ''


def _execute_document_tool(tool_name, arguments):
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
    if tool_name == 'save_json_file':
        from tools.document_executor import write_file
        payload = dict(arguments)
        data = payload.pop('data', payload)
        return write_file(content=data, mode='json', **payload)
    if tool_name == 'write_file':
        from tools.document_executor import write_file
        return write_file(**arguments)
    if tool_name == 'read_file':
        from tools.document_executor import read_file
        return read_file(**arguments)
    return None


def _execute_mcp_tool(tool_name, arguments, *, session_id=None):
    from mcp.converter import parse_mcp_tool_name
    from services.mcp_service import get_mcp_service

    parsed = parse_mcp_tool_name(tool_name)
    if not parsed:
        return error_response(f'无效的 MCP 工具名: {tool_name}')
    server_name, original_tool = parsed
    return get_mcp_service().call_tool(server_name, original_tool, arguments, session_id=session_id)


TOOL_HANDLERS = {
    'search_knowledge_graph': search_knowledge_graph,
    'query_knowledge_graph_with_nl': query_knowledge_graph_with_nl,
    'get_entity_relations': get_entity_relations,
    'execute_cypher_query': execute_cypher_query,
    'get_graph_schema': get_graph_schema_tool,
    'analyze_temporal_pattern': analyze_temporal_pattern,
    'find_causal_chain': find_causal_chain,
    'compare_entities': compare_entities,
    'aggregate_statistics': aggregate_statistics,
    'get_spatial_neighbors': get_spatial_neighbors,
    'query_emergency_plan': query_emergency_plan,
    'generate_chart': generate_chart,
    'generate_map': generate_map,
    'get_entity_geometry': get_entity_geometry,
    'transform_data': transform_data,
    'process_data_file': process_data_file,
    'activate_skill': activate_skill,
    'load_skill_resource': load_skill_resource,
    'execute_skill_script': execute_skill_script,
}


DOCUMENT_TOOL_NAMES = {
    'read_document',
    'chunk_document',
    'extract_structured_data',
    'merge_extracted_data',
    'save_json_file',
    'write_file',
    'read_file',
}


def execute_tool(tool_name, arguments, agent_config=None, event_bus=None, user_role=None, caller='direct', session_id=None):
    """执行指定工具。"""
    try:
        allowed, error_result, approval_message = _request_user_approval_if_needed(
            tool_name,
            arguments,
            agent_config=agent_config,
            event_bus=event_bus,
            user_role=user_role,
            caller=caller,
            session_id=session_id,
        )
        if not allowed:
            return error_result

        if tool_name == 'execute_code':
            from tools.code_sandbox import execute_code_sandbox
            result = execute_code_sandbox(
                code=arguments.get('code'),
                description=arguments.get('description', ''),
                timeout=arguments.get('timeout', 30),
                agent_config=agent_config,
                event_bus=event_bus,
                user_role=user_role,
            )
        elif tool_name in TOOL_HANDLERS:
            result = TOOL_HANDLERS[tool_name](**arguments)
        elif tool_name in DOCUMENT_TOOL_NAMES:
            result = _execute_document_tool(tool_name, arguments)
        elif tool_name.startswith('mcp__'):
            result = _execute_mcp_tool(tool_name, arguments, session_id=session_id)
        else:
            result = error_response(f'未知的工具: {tool_name}')

        if approval_message and isinstance(result, dict) and result.get('success'):
            result['approval_message'] = approval_message
        return result
    except Exception as error:
        logger.error(f'执行工具 {tool_name} 失败: {error}')
        import traceback
        traceback.print_exc()
        return error_response(str(error))


__all__ = ['execute_tool', 'TOOL_HANDLERS']
