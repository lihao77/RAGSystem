# -*- coding: utf-8 -*-
"""
搜索路由 - 实体和状态搜索API接口（重构版）

原始版本已完成清理，当前仅保留重构版
此版本使用服务层架构，路由只负责请求响应转发
注意：保持所有返回格式与原版完全一致
"""

from flask import Blueprint, request, jsonify
import logging
from services.search_service import get_search_service

logger = logging.getLogger(__name__)

# 创建蓝图
search_bp = Blueprint('search', __name__)


@search_bp.route('/entities', methods=['POST'])
def search_entities():
    """搜索实体和状态节点"""
    try:
        data = request.get_json()
        if not data:
            data = {}
        
        service = get_search_service()
        entities = service.search_entities(data)
        
        return jsonify(entities)  # 直接返回数组，保持原格式
        
    except Exception as e:
        logger.error(f'搜索实体失败: {e}')
        return jsonify({'success': False, 'message': f'搜索实体失败: {str(e)}'}), 500


@search_bp.route('/relations/<entity_id>', methods=['GET'])
def search_relations(entity_id):
    """搜索实体的关系"""
    try:
        service = get_search_service()
        relations = service.search_relations(entity_id)
        
        return jsonify(relations)  # 直接返回对象，保持原格式
        
    except Exception as e:
        logger.error(f'搜索关系失败: {e}')
        return jsonify({'success': False, 'message': f'搜索关系失败: {str(e)}'}), 500


@search_bp.route('/export', methods=['POST'])
def export_search_results():
    """导出搜索结果"""
    try:
        data = request.get_json()
        entity_ids = data.get('entityIds', [])
        export_format = data.get('format', 'json')
        
        service = get_search_service()
        filepath = service.export_search_results(entity_ids, export_format)
        
        return jsonify({
            'success': True,
            'message': '导出成功',
            'filepath': filepath
        })
        
    except Exception as e:
        logger.error(f'导出失败: {e}')
        return jsonify({'success': False, 'message': f'导出失败: {str(e)}'}), 500


@search_bp.route('/location-options', methods=['GET'])
def get_location_options():
    """获取地理位置选项（级联）"""
    try:
        service = get_search_service()
        options = service.get_location_options()
        
        return jsonify(options)  # 直接返回数组，保持原格式
        
    except Exception as e:
        logger.error(f'获取位置选项失败: {e}')
        return jsonify({'success': False, 'message': f'获取位置选项失败: {str(e)}'}), 500


@search_bp.route('/document-sources', methods=['GET'])
def get_document_sources():
    """获取文档来源列表"""
    try:
        service = get_search_service()
        sources = service.get_document_sources()
        
        return jsonify(sources)  # 直接返回数组，保持原格式
        
    except Exception as e:
        logger.error(f'获取文档来源失败: {e}')
        return jsonify({'success': False, 'message': f'获取文档来源失败: {str(e)}'}), 500


@search_bp.route('/debug/node-stats', methods=['GET'])
def get_node_stats():
    """获取节点统计信息（调试用）"""
    try:
        service = get_search_service()
        stats = service.get_node_stats()
        
        return jsonify(stats)  # 直接返回对象，保持原格式
        
    except Exception as e:
        logger.error(f'获取节点统计失败: {e}')
        return jsonify({'success': False, 'message': f'获取节点统计失败: {str(e)}'}), 500
