# -*- coding: utf-8 -*-
"""
GraphRAG 路由 - 基于知识图谱的问答系统（重构版）。
"""

from flask import Blueprint, request
import logging

from services.graphrag_api_service import GraphRAGApiServiceError, get_graphrag_api_service
from utils.response_helpers import success_response, error_response

logger = logging.getLogger(__name__)

graphrag_bp = Blueprint('graphrag', __name__)


@graphrag_bp.route('/schema', methods=['GET'])
def get_schema():
    """获取图谱结构"""
    try:
        schema = get_graphrag_api_service().get_schema()
        return success_response(data=schema, message='获取图谱结构成功')
    except GraphRAGApiServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error(f'获取图谱结构API错误: {error}')
        return error_response(message=str(error), status_code=500)


@graphrag_bp.route('/query', methods=['POST'])
def query():
    """基于 Function Calling 的 GraphRAG 问答。"""
    try:
        result = get_graphrag_api_service().query_with_tools(request.get_json(silent=True) or {})
        return success_response(data=result, message='查询成功')
    except GraphRAGApiServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error(f'GraphRAG查询错误: {error}', exc_info=True)
        return error_response(message=f'查询处理失败: {str(error)}', status_code=500)


@graphrag_bp.route('/execute_cypher', methods=['POST'])
def execute_custom_cypher():
    """执行自定义Cypher查询"""
    try:
        result = get_graphrag_api_service().execute_custom_cypher(request.get_json(silent=True) or {})
        return success_response(data=result, message='查询执行成功')
    except GraphRAGApiServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error(f'执行Cypher失败: {error}')
        return error_response(message=f'查询执行失败: {str(error)}', status_code=500)
