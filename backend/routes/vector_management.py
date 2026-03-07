# -*- coding: utf-8 -*-
"""
向量库管理 API。
"""

import logging

from flask import Blueprint, request, jsonify

from services.vector_management_service import VectorManagementServiceError, get_vector_management_service

logger = logging.getLogger(__name__)

vector_management_bp = Blueprint('vector_management', __name__, url_prefix='/api/vector')


@vector_management_bp.route('/collections', methods=['GET'])
def list_collections():
    """列出所有向量集合"""
    try:
        data = get_vector_management_service().list_collections()
        return jsonify({'success': True, 'data': data, 'count': len(data)})
    except VectorManagementServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'列出集合失败: {error}')
        return jsonify({'success': False, 'error': str(error)}), 500


@vector_management_bp.route('/collections/<collection_name>', methods=['DELETE'])
def delete_collection(collection_name):
    """删除向量集合"""
    try:
        data = get_vector_management_service().delete_collection(collection_name)
        return jsonify({'success': True, **data})
    except VectorManagementServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'删除集合失败: {error}')
        return jsonify({'success': False, 'error': str(error)}), 500


@vector_management_bp.route('/search', methods=['POST'])
def search_vectors():
    """向量检索测试接口"""
    try:
        data = get_vector_management_service().search_vectors(request.get_json(silent=True) or {})
        return jsonify({'success': True, 'data': data})
    except VectorManagementServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'向量检索失败: {error}')
        return jsonify({'success': False, 'error': str(error)}), 500


@vector_management_bp.route('/index', methods=['POST'])
def index_document():
    """索引文档（支持直接文本、文件上传、文件ID三种方式）"""
    try:
        uploaded_file = request.files.get('file') if 'file' in request.files else None
        form = request.form.to_dict(flat=True) if uploaded_file is not None else None
        data = get_vector_management_service().index_document(
            payload=request.get_json(silent=True) if uploaded_file is None else None,
            uploaded_file=uploaded_file,
            form=form,
        )
        message = data.pop('message')
        return jsonify({'success': True, 'data': data, 'message': message})
    except VectorManagementServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'索引文档失败: {error}')
        return jsonify({'success': False, 'error': str(error)}), 500


@vector_management_bp.route('/documents/<collection_name>/<document_id>', methods=['DELETE'])
def delete_document(collection_name, document_id):
    """删除文档"""
    try:
        data = get_vector_management_service().delete_document(collection_name, document_id)
        return jsonify({'success': True, **data})
    except VectorManagementServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'删除文档失败: {error}')
        return jsonify({'success': False, 'error': str(error)}), 500


@vector_management_bp.route('/documents/<collection_name>', methods=['GET'])
def list_documents(collection_name):
    """列出集合中的文档"""
    try:
        data = get_vector_management_service().list_documents(collection_name)
        return jsonify({'success': True, 'data': data})
    except VectorManagementServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'列出文档失败: {error}')
        return jsonify({'success': False, 'error': str(error)}), 500


@vector_management_bp.route('/health', methods=['GET'])
def health_check():
    """健康检查"""
    try:
        data = get_vector_management_service().health_check()
        return jsonify({'success': True, 'data': data})
    except VectorManagementServiceError as error:
        return jsonify({'success': False, 'error': error.message, 'data': {'status': 'unhealthy'}}), error.status_code
    except Exception as error:
        logger.error(f'健康检查失败: {error}')
        return jsonify({'success': False, 'error': str(error), 'data': {'status': 'unhealthy'}}), 500
