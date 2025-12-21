# -*- coding: utf-8 -*-
"""
可视化路由 - 图谱可视化API接口（重构版）

原始版本已备份到 visualization.py.backup
此版本使用服务层架构，路由只负责请求响应转发
注意：为保持向后兼容，部分接口直接返回数据，不使用success_response包装
"""

from flask import Blueprint, request, jsonify
import logging
from services.visualization_service import get_visualization_service

logger = logging.getLogger(__name__)

visualization_bp = Blueprint('visualization', __name__)


@visualization_bp.route('/base-entities', methods=['GET'])
def get_base_entities():
    """获取所有基础实体（地点和设施）"""
    try:
        service = get_visualization_service()
        entities = service.get_base_entities()
        return jsonify(entities)  # 直接返回数组，保持原格式
    except Exception as e:
        logger.error(f'获取基础实体失败: {e}')
        return jsonify({'success': False, 'message': '获取基础实体失败'}), 500


@visualization_bp.route('/entity-relationships', methods=['GET'])
def get_entity_relationships():
    """获取地点和设施实体及其关系"""
    try:
        service = get_visualization_service()
        result = service.get_entity_relationships()
        return jsonify(result)  # 直接返回dict，保持原格式
    except Exception as e:
        logger.error(f'获取实体关系失败: {e}')
        return jsonify({'success': False, 'message': '获取实体关系失败'}), 500


@visualization_bp.route('/entity-states/<entity_id>', methods=['GET'])
def get_entity_states(entity_id):
    """获取实体的状态链"""
    try:
        service = get_visualization_service()
        states = service.get_entity_states(entity_id)
        return jsonify(states)  # 直接返回数组，保持原格式
    except Exception as e:
        logger.error(f'获取实体状态失败: {e}')
        return jsonify({'success': False, 'message': '获取实体状态失败'}), 500


@visualization_bp.route('/entity-events/<entity_id>', methods=['GET'])
def get_entity_events(entity_id):
    """获取与实体相关的事件"""
    try:
        service = get_visualization_service()
        events = service.get_entity_events(entity_id)
        return jsonify(events)  # 直接返回数组，保持原格式
    except Exception as e:
        logger.error(f'获取实体事件失败: {e}')
        return jsonify({'success': False, 'message': '获取实体事件失败'}), 500


@visualization_bp.route('/event-locations/<event_id>', methods=['GET'])
def get_event_locations(event_id):
    """获取事件发生的地点"""
    try:
        service = get_visualization_service()
        locations = service.get_event_locations(event_id)
        return jsonify(locations)  # 直接返回数组，保持原格式
    except Exception as e:
        logger.error(f'获取事件地点失败: {e}')
        return jsonify({'success': False, 'message': '获取事件地点失败'}), 500


@visualization_bp.route('/entity-facilities/<entity_id>', methods=['GET'])
def get_entity_facilities(entity_id):
    """获取地点下的设施"""
    try:
        service = get_visualization_service()
        facilities = service.get_entity_facilities(entity_id)
        return jsonify(facilities)  # 直接返回数组，保持原格式
    except Exception as e:
        logger.error(f'获取实体设施失败: {e}')
        return jsonify({'success': False, 'message': '获取实体设施失败'}), 500


@visualization_bp.route('/state-relationships', methods=['GET'])
def get_state_relationships():
    """获取状态节点之间的关系"""
    try:
        service = get_visualization_service()
        result = service.get_state_relationships()
        return jsonify(result)  # 直接返回dict，保持原格式
    except Exception as e:
        logger.error(f'获取状态关系失败: {e}')
        return jsonify({'success': False, 'message': '获取状态关系失败'}), 500


@visualization_bp.route('/knowledge-graph', methods=['GET'])
def get_knowledge_graph():
    """获取完整的知识图谱数据"""
    try:
        # 获取限制参数
        limit = request.args.get('limit', 10000, type=int)
        
        service = get_visualization_service()
        result = service.get_knowledge_graph(limit=limit)
        return jsonify(result)  # 直接返回dict，保持原格式
    except Exception as e:
        logger.error(f'获取知识图谱失败: {e}')
        return jsonify({'success': False, 'message': '获取知识图谱失败'}), 500


@visualization_bp.route('/entities/<entity_id>', methods=['GET'])
def get_entity_details(entity_id):
    """获取实体详细信息"""
    try:
        service = get_visualization_service()
        entity = service.get_entity_details(entity_id)
        
        if not entity:
            return jsonify({'success': False, 'message': '实体不存在'}), 404
        
        return jsonify(entity)  # 直接返回dict，保持原格式
    except Exception as e:
        logger.error(f'获取实体详情失败: {e}')
        return jsonify({'success': False, 'message': '获取实体详情失败'}), 500


@visualization_bp.route('/state-details/<state_id>', methods=['GET'])
def get_state_details(state_id):
    """获取状态详细信息"""
    try:
        service = get_visualization_service()
        details = service.get_state_details(state_id)
        
        # 原版：如果没有结果返回404
        if not details:
            return jsonify({'success': False, 'message': '未找到该状态'}), 404
        
        return jsonify(details)  # 直接返回数组，保持原格式
    except Exception as e:
        logger.error(f'获取状态详情失败: {e}')
        return jsonify({'success': False, 'message': f'获取状态{state_id}详情失败'}), 500


@visualization_bp.route('/location-hierarchy/<location_id>', methods=['GET'])
def get_location_hierarchy(location_id):
    """获取地点的层级结构"""
    try:
        service = get_visualization_service()
        hierarchy = service.get_location_hierarchy(location_id)
        return jsonify(hierarchy)  # 直接返回dict，保持原格式
    except Exception as e:
        logger.error(f'获取地点层级失败: {e}')
        return jsonify({'success': False, 'message': '获取地点层级失败'}), 500
