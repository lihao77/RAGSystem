# -*- coding: utf-8 -*-
"""
Embedding 模型管理 API。
"""

import logging

from flask import Blueprint, request, jsonify

from services.embedding_model_service import EmbeddingModelServiceError, get_embedding_model_service

logger = logging.getLogger(__name__)

embedding_models_bp = Blueprint('embedding_models', __name__)


@embedding_models_bp.route('/models', methods=['GET'])
def list_models():
    """列出所有 embedding 模型"""
    try:
        models = get_embedding_model_service().list_models()
        return jsonify({'success': True, 'models': models})
    except EmbeddingModelServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'获取模型列表失败: {error}', exc_info=True)
        return jsonify({'success': False, 'error': str(error)}), 500


@embedding_models_bp.route('/models/<int:model_id>/activate', methods=['POST'])
def activate_model(model_id: int):
    """激活指定模型"""
    try:
        data = get_embedding_model_service().activate_model(model_id)
        return jsonify({'success': True, **data})
    except EmbeddingModelServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'激活模型失败: {error}', exc_info=True)
        return jsonify({'success': False, 'error': str(error)}), 500


@embedding_models_bp.route('/models/<int:model_id>', methods=['DELETE'])
def delete_model(model_id: int):
    """删除指定模型（及其向量数据）"""
    try:
        force = request.args.get('force', 'false').lower() == 'true'
        data = get_embedding_model_service().delete_model(model_id, force=force)
        return jsonify({'success': True, **data})
    except EmbeddingModelServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'删除模型失败: {error}', exc_info=True)
        return jsonify({'success': False, 'error': str(error)}), 500


@embedding_models_bp.route('/models/<int:model_id>/sync', methods=['POST'])
def sync_model(model_id: int):
    """同步文档到指定模型（增量）"""
    try:
        data = request.get_json(silent=True) or {}
        result = get_embedding_model_service().sync_model(
            model_id,
            collection=data.get('collection', 'default'),
            batch_size=data.get('batch_size', 50),
            limit=data.get('limit'),
        )
        return jsonify({'success': True, 'result': result})
    except EmbeddingModelServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'同步失败: {error}', exc_info=True)
        return jsonify({'success': False, 'error': str(error)}), 500


@embedding_models_bp.route('/models/<int:model_id>/stats', methods=['GET'])
def get_model_stats(model_id: int):
    """获取模型统计信息"""
    try:
        stats = get_embedding_model_service().get_model_stats(model_id, collection=request.args.get('collection'))
        return jsonify({'success': True, 'stats': stats})
    except EmbeddingModelServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'获取统计信息失败: {error}', exc_info=True)
        return jsonify({'success': False, 'error': str(error)}), 500


@embedding_models_bp.route('/models/sync-status', methods=['GET'])
def get_sync_status():
    """获取所有模型的同步状态"""
    try:
        collection = request.args.get('collection', 'default')
        sync_status = get_embedding_model_service().get_sync_status(collection=collection)
        return jsonify({'success': True, 'collection': collection, 'sync_status': sync_status})
    except EmbeddingModelServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
    except Exception as error:
        logger.error(f'获取同步状态失败: {error}', exc_info=True)
        return jsonify({'success': False, 'error': str(error)}), 500
