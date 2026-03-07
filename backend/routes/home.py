# -*- coding: utf-8 -*-
"""
首页相关路由。
"""

from flask import Blueprint, jsonify
import logging

from services.home_service import get_home_service

logger = logging.getLogger(__name__)

home_bp = Blueprint('home', __name__)


@home_bp.route('/stats', methods=['GET'])
def get_stats():
    """获取知识图谱统计数据"""
    try:
        response = get_home_service().get_stats()
        logger.info(f'获取知识图谱统计数据成功: {response}')
        return jsonify(response)
    except Exception as error:
        logger.error(f'获取知识图谱统计数据失败: {error}')
        return jsonify({'error': '获取知识图谱统计数据失败', 'details': str(error)}), 500


@home_bp.route('/recent-documents', methods=['GET'])
def get_recent_documents():
    """获取最近处理的文档列表"""
    return jsonify(get_home_service().get_recent_documents())


@home_bp.route('/document/<document_id>', methods=['GET'])
def get_document(document_id):
    """获取文档详情"""
    document = get_home_service().get_document(document_id)
    if document:
        return jsonify(document)
    return jsonify({'success': False, 'message': '文档不存在'}), 404
