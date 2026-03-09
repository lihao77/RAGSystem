# -*- coding: utf-8 -*-
"""
Embedding 模型服务层。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
from typing import Any, Dict, Optional

from vector_store.client import get_vector_client
from vector_store.sync_manager import VectorSyncManager


class EmbeddingModelServiceError(Exception):
    """Embedding 模型业务异常。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class EmbeddingModelService:
    """封装 embedding 模型查询、激活、删除和同步逻辑。"""

    def __init__(self, *, vector_client=None, sync_manager_factory=None):
        self._vector_client = vector_client
        self._sync_manager_factory = sync_manager_factory or VectorSyncManager

    def list_models(self) -> list[Dict[str, Any]]:
        model_manager = self._get_model_manager()
        models = model_manager.list_models()
        models_with_stats = []
        for model in models:
            stats = model_manager.get_model_stats(model.id)
            models_with_stats.append(
                {
                    'id': model.id,
                    'model_key': model.model_key,
                    'provider': model.provider,
                    'model_name': model.model_name,
                    'vector_dimension': model.vector_dimension,
                    'distance_metric': model.distance_metric,
                    'is_active': model.is_active,
                    'api_endpoint': model.api_endpoint,
                    'created_at': self._as_iso(model.created_at),
                    'last_used_at': self._as_iso(model.last_used_at),
                    'stats': stats,
                }
            )
        return models_with_stats

    def activate_model(self, model_id: int) -> Dict[str, Any]:
        model_manager = self._get_model_manager()
        model_manager.set_active_model(model_id)
        return {'message': f'模型 {model_id} 已激活'}

    def delete_model(self, model_id: int, *, force: bool = False) -> Dict[str, Any]:
        model_manager = self._get_model_manager()
        success = model_manager.delete_model(model_id, force=force)
        if not success:
            raise EmbeddingModelServiceError('删除失败，请检查日志', status_code=400)
        return {'message': f'模型 {model_id} 已删除'}

    def sync_model(
        self,
        model_id: int,
        *,
        collection: str = 'default',
        batch_size: int = 50,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        client = self._get_vector_client()
        model_manager = self._get_model_manager()
        sync_manager = self._sync_manager_factory(
            db_path=str(client.store.db_path),
            model_manager=model_manager,
        )
        return sync_manager.sync_documents_to_model(
            model_id=model_id,
            collection=collection,
            batch_size=batch_size,
            limit=limit,
        )

    def get_model_stats(self, model_id: int, *, collection: Optional[str] = None) -> Dict[str, Any]:
        model_manager = self._get_model_manager()
        return model_manager.get_model_stats(model_id, collection)

    def get_sync_status(self, *, collection: str = 'default') -> list[Dict[str, Any]]:
        client = self._get_vector_client()
        model_manager = self._get_model_manager()
        sync_manager = self._sync_manager_factory(
            db_path=str(client.store.db_path),
            model_manager=model_manager,
        )

        sync_status = []
        for model in model_manager.list_models():
            unsync_docs = sync_manager.get_unsync_documents(model.id, collection)
            total_docs = client.count_documents(collection)
            synced_docs = total_docs - len(unsync_docs)
            sync_status.append(
                {
                    'model_id': model.id,
                    'model_key': model.model_key,
                    'is_active': model.is_active,
                    'total_documents': total_docs,
                    'synced_documents': synced_docs,
                    'pending_documents': len(unsync_docs),
                    'sync_percentage': round(synced_docs / total_docs * 100, 2) if total_docs > 0 else 0,
                }
            )
        return sync_status

    def _get_vector_client(self):
        return self._vector_client or get_vector_client()

    def _get_model_manager(self):
        client = self._get_vector_client()
        store = client.store
        if not hasattr(store, 'model_manager'):
            raise EmbeddingModelServiceError('Vector store does not support model management', status_code=400)
        return store.model_manager

    @staticmethod
    def _as_iso(value):
        if value is None:
            return None
        if hasattr(value, 'isoformat'):
            return value.isoformat()
        return str(value)


def get_embedding_model_service() -> EmbeddingModelService:
    return get_runtime_dependency(container_getter='get_embedding_model_service')
