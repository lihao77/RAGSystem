# -*- coding: utf-8 -*-
"""
搜索路由 - 实体和状态搜索 API 接口（重构版）。

当前版本使用服务层架构，路由负责参数解析与统一响应格式。
"""

from flask import Blueprint, request
import logging

from services.search_service import get_search_service
from utils.response_helpers import error_response, success_response

logger = logging.getLogger(__name__)

search_bp = Blueprint('search', __name__)


@search_bp.route('/entities', methods=['POST'])
def search_entities():
    """搜索实体和状态节点。"""
    try:
        payload = request.get_json(silent=True) or {}
        entities = get_search_service().search_entities(payload)
        return success_response(data=entities, message='搜索成功')
    except Exception as error:
        logger.error('搜索实体失败: %s', error, exc_info=True)
        return error_response(message=f'搜索实体失败: {error}', status_code=500)


@search_bp.route('/relations/<entity_id>', methods=['GET'])
def search_relations(entity_id):
    """搜索实体的关系。"""
    try:
        relations = get_search_service().search_relations(entity_id)
        return success_response(data=relations, message='搜索关系成功')
    except Exception as error:
        logger.error('搜索关系失败: %s', error, exc_info=True)
        return error_response(message=f'搜索关系失败: {error}', status_code=500)


@search_bp.route('/export', methods=['POST'])
def export_search_results():
    """导出搜索结果。"""
    try:
        payload = request.get_json(silent=True) or {}
        entity_ids = payload.get('entityIds')
        if entity_ids is None:
            entity_ids = [item.get('id') for item in payload.get('results', []) if item.get('id')]

        export_format = payload.get('format', 'json')
        filepath = get_search_service().export_search_results(entity_ids or [], export_format)
        result = {'filepath': filepath}
        return success_response(data=result, filepath=filepath, message='导出成功')
    except Exception as error:
        logger.error('导出失败: %s', error, exc_info=True)
        return error_response(message=f'导出失败: {error}', status_code=500)


@search_bp.route('/location-options', methods=['GET'])
def get_location_options():
    """获取地理位置选项（级联）。"""
    try:
        options = get_search_service().get_location_options()
        return success_response(data=options, message='获取位置选项成功')
    except Exception as error:
        logger.error('获取位置选项失败: %s', error, exc_info=True)
        return error_response(message=f'获取位置选项失败: {error}', status_code=500)


@search_bp.route('/document-sources', methods=['GET'])
def get_document_sources():
    """获取文档来源列表。"""
    try:
        sources = get_search_service().get_document_sources()
        return success_response(data=sources, message='获取文档来源成功')
    except Exception as error:
        logger.error('获取文档来源失败: %s', error, exc_info=True)
        return error_response(message=f'获取文档来源失败: {error}', status_code=500)


@search_bp.route('/debug/node-stats', methods=['GET'])
def get_node_stats():
    """获取节点统计信息（调试用）。"""
    try:
        stats = get_search_service().get_node_stats()
        return success_response(data=stats, message='获取节点统计成功')
    except Exception as error:
        logger.error('获取节点统计失败: %s', error, exc_info=True)
        return error_response(message=f'获取节点统计失败: {error}', status_code=500)
