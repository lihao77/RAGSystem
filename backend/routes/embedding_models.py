# -*- coding: utf-8 -*-
"""
Embedding 模型管理 API
"""

from flask import Blueprint, request, jsonify
from vector_store.client import get_vector_client
from vector_store.model_manager import EmbeddingModelManager
from vector_store.sync_manager import VectorSyncManager
import logging

logger = logging.getLogger(__name__)

embedding_models_bp = Blueprint('embedding_models', __name__)


@embedding_models_bp.route('/models', methods=['GET'])
def list_models():
    """列出所有 embedding 模型"""
    try:
        client = get_vector_client()
        # Ensure model_manager is available (it should be if store is SQLiteVectorStore)
        if not hasattr(client.store, 'model_manager'):
             return jsonify({"success": False, "error": "Vector store does not support model management"}), 400
             
        model_manager = client.store.model_manager

        models = model_manager.list_models()

        # 获取每个模型的统计信息
        models_with_stats = []
        for model in models:
            stats = model_manager.get_model_stats(model.id)
            models_with_stats.append({
                "id": model.id,
                "model_key": model.model_key,
                "provider": model.provider,
                "model_name": model.model_name,
                "vector_dimension": model.vector_dimension,
                "distance_metric": model.distance_metric,
                "is_active": model.is_active,
                "api_endpoint": model.api_endpoint,
                "created_at": model.created_at.isoformat(),
                "last_used_at": model.last_used_at.isoformat(),
                "stats": stats
            })

        return jsonify({
            "success": True,
            "models": models_with_stats
        })

    except Exception as e:
        logger.error(f"获取模型列表失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/<int:model_id>/activate', methods=['POST'])
def activate_model(model_id: int):
    """激活指定模型"""
    try:
        client = get_vector_client()
        if not hasattr(client.store, 'model_manager'):
             return jsonify({"success": False, "error": "Vector store does not support model management"}), 400
             
        model_manager = client.store.model_manager

        model_manager.set_active_model(model_id)

        return jsonify({
            "success": True,
            "message": f"模型 {model_id} 已激活"
        })

    except Exception as e:
        logger.error(f"激活模型失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/<int:model_id>', methods=['DELETE'])
def delete_model(model_id: int):
    """删除指定模型（及其向量数据）"""
    try:
        force = request.args.get('force', 'false').lower() == 'true'

        client = get_vector_client()
        if not hasattr(client.store, 'model_manager'):
             return jsonify({"success": False, "error": "Vector store does not support model management"}), 400
             
        model_manager = client.store.model_manager

        success = model_manager.delete_model(model_id, force=force)

        if success:
            return jsonify({
                "success": True,
                "message": f"模型 {model_id} 已删除"
            })
        else:
            return jsonify({
                "success": False,
                "error": "删除失败，请检查日志"
            }), 400

    except Exception as e:
        logger.error(f"删除模型失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/<int:model_id>/sync', methods=['POST'])
def sync_model(model_id: int):
    """同步文档到指定模型（增量）"""
    try:
        data = request.get_json() or {}
        collection = data.get('collection', 'default')
        batch_size = data.get('batch_size', 50)
        limit = data.get('limit')  # 可选：限制同步数量

        client = get_vector_client()
        if not hasattr(client.store, 'model_manager'):
             return jsonify({"success": False, "error": "Vector store does not support model management"}), 400
             
        model_manager = client.store.model_manager

        sync_manager = VectorSyncManager(
            db_path=str(client.store.db_path),
            model_manager=model_manager
        )

        result = sync_manager.sync_documents_to_model(
            model_id=model_id,
            collection=collection,
            batch_size=batch_size,
            limit=limit
        )

        return jsonify({
            "success": True,
            "result": result
        })

    except Exception as e:
        logger.error(f"同步失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/<int:model_id>/stats', methods=['GET'])
def get_model_stats(model_id: int):
    """获取模型统计信息"""
    try:
        collection = request.args.get('collection')

        client = get_vector_client()
        if not hasattr(client.store, 'model_manager'):
             return jsonify({"success": False, "error": "Vector store does not support model management"}), 400
             
        model_manager = client.store.model_manager

        stats = model_manager.get_model_stats(model_id, collection)

        return jsonify({
            "success": True,
            "stats": stats
        })

    except Exception as e:
        logger.error(f"获取统计信息失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/sync-status', methods=['GET'])
def get_sync_status():
    """获取所有模型的同步状态"""
    try:
        collection = request.args.get('collection', 'default')

        client = get_vector_client()
        if not hasattr(client.store, 'model_manager'):
             return jsonify({"success": False, "error": "Vector store does not support model management"}), 400
             
        model_manager = client.store.model_manager
        sync_manager = VectorSyncManager(
            db_path=str(client.store.db_path),
            model_manager=model_manager
        )

        models = model_manager.list_models()
        sync_status = []

        for model in models:
            unsync_docs = sync_manager.get_unsync_documents(model.id, collection)
            total_docs = client.count_documents(collection)
            synced_docs = total_docs - len(unsync_docs)

            sync_status.append({
                "model_id": model.id,
                "model_key": model.model_key,
                "is_active": model.is_active,
                "total_documents": total_docs,
                "synced_documents": synced_docs,
                "pending_documents": len(unsync_docs),
                "sync_percentage": round(synced_docs / total_docs * 100, 2) if total_docs > 0 else 0
            })

        return jsonify({
            "success": True,
            "collection": collection,
            "sync_status": sync_status
        })

    except Exception as e:
        logger.error(f"获取同步状态失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500
