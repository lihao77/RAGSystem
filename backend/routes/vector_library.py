# -*- coding: utf-8 -*-
"""
向量库管理 API（插件式）。
"""

import logging

from flask import Blueprint, jsonify, request

from capabilities.vector_retrieval import get_vector_retrieval_capability
from services.vector_library_service import VectorLibraryServiceError

logger = logging.getLogger(__name__)

vector_library_bp = Blueprint('vector_library', __name__)


@vector_library_bp.route('/file-status', methods=['GET'])
def file_status():
    try:
        data = get_vector_retrieval_capability().file_status()
        return jsonify({'success': True, 'data': data})
    except VectorLibraryServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.exception('获取文件索引状态失败')
        return jsonify({'success': False, 'message': str(error)}), 500


@vector_library_bp.route('/index-file', methods=['POST'])
def index_file_with_vectorizer():
    try:
        data = get_vector_retrieval_capability().index_file(request.get_json(silent=True) or {})
        return jsonify({'success': True, 'data': data})
    except VectorLibraryServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.exception('按向量化器索引文件失败')
        return jsonify({'success': False, 'message': str(error)}), 500


@vector_library_bp.route('/delete-file', methods=['POST'])
def delete_file():
    try:
        data = get_vector_retrieval_capability().delete_file(request.get_json(silent=True) or {})
        return jsonify({'success': True, 'data': data})
    except VectorLibraryServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.exception('删除文件失败')
        return jsonify({'success': False, 'message': str(error)}), 500


@vector_library_bp.route('/vectorizers', methods=['GET'])
def list_vectorizers():
    try:
        data = get_vector_retrieval_capability().list_vectorizers()
        return jsonify({'success': True, 'data': data})
    except VectorLibraryServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.exception('列表向量化器失败')
        return jsonify({'success': False, 'message': str(error)}), 500


@vector_library_bp.route('/vectorizers', methods=['POST'])
def add_vectorizer():
    try:
        data = get_vector_retrieval_capability().add_vectorizer(request.get_json(silent=True) or {})
        return jsonify({'success': True, 'data': data})
    except VectorLibraryServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.exception('新增向量化器失败')
        return jsonify({'success': False, 'message': str(error)}), 500


@vector_library_bp.route('/vectorizers/<key>/activate', methods=['POST'])
def activate_vectorizer(key: str):
    try:
        data = get_vector_retrieval_capability().activate_vectorizer(key)
        return jsonify({'success': True, 'data': data})
    except VectorLibraryServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.exception('激活向量化器失败')
        return jsonify({'success': False, 'message': str(error)}), 500


@vector_library_bp.route('/vectorizers/<key>/docs', methods=['GET'])
def list_docs_by_vectorizer(key: str):
    try:
        data = get_vector_retrieval_capability().list_docs_by_vectorizer(key, request.args.get('collection'))
        return jsonify({'success': True, 'data': data})
    except VectorLibraryServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.exception('按向量化器查文档失败')
        return jsonify({'success': False, 'message': str(error)}), 500


@vector_library_bp.route('/migrate', methods=['POST'])
def migrate():
    try:
        data = get_vector_retrieval_capability().migrate(request.get_json(silent=True) or {})
        return jsonify({'success': True, 'data': data})
    except VectorLibraryServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.exception('迁移失败')
        return jsonify({'success': False, 'message': str(error)}), 500


@vector_library_bp.route('/vectorizers/<key>', methods=['DELETE'])
def delete_vectorizer(key: str):
    try:
        data = get_vector_retrieval_capability().delete_vectorizer(key)
        return jsonify({'success': True, 'data': data})
    except VectorLibraryServiceError as error:
        return jsonify({'success': False, 'message': error.message}), error.status_code
    except Exception as error:
        logger.exception('删除向量化器失败')
        return jsonify({'success': False, 'message': str(error)}), 500
