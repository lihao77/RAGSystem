# -*- coding: utf-8 -*-
"""
Function Calling API 路由。
"""

from flask import Blueprint, request, jsonify
import logging

from services.function_call_service import FunctionCallServiceError, get_function_call_service

logger = logging.getLogger(__name__)

function_call_bp = Blueprint('function_call', __name__)


@function_call_bp.route('/tools', methods=['GET'])
def get_tools():
    """获取所有可用的工具定义。"""
    try:
        data = get_function_call_service().get_tools()
        return jsonify({'success': True, 'data': data})
    except FunctionCallServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.error(f'获取工具定义失败: {error}')
        return jsonify({'success': False, 'message': str(error)}), 500


@function_call_bp.route('/execute', methods=['POST'])
def execute_tool_call():
    """执行工具调用。"""
    try:
        result = get_function_call_service().execute_tool_call(request.get_json(silent=True) or {})
        return jsonify(result)
    except FunctionCallServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.error(f'执行工具调用失败: {error}')
        return jsonify({'success': False, 'message': str(error)}), 500


@function_call_bp.route('/chat', methods=['POST'])
def chat_with_tools():
    """带工具调用的对话接口。"""
    try:
        data = get_function_call_service().chat_with_tools(request.get_json(silent=True) or {})
        return jsonify({'success': True, 'data': data})
    except FunctionCallServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.error(f'对话处理失败: {error}')
        return jsonify({'success': False, 'message': str(error)}), 500
