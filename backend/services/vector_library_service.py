# -*- coding: utf-8 -*-
"""
向量库服务层。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
import json
import sqlite3
import struct
from pathlib import Path
from typing import Any, Dict, Optional

from config import get_config
from vector_store.embedder import get_embedder_for_vectorizer, reset_embedder
from vector_store.model_manager import EmbeddingModelManager
from vector_store.vectorizer_config import get_vectorizer_config_store
from vector_store.client import get_vector_client, reset_vector_client
from init_vector_store import reset_vector_store_initialized


class VectorLibraryServiceError(Exception):
    """向量库业务异常。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class VectorLibraryService:
    """封装向量化器管理、文件索引和迁移逻辑。"""

    def __init__(
        self,
        *,
        config_getter=None,
        vectorizer_store=None,
        model_manager=None,
        vector_client=None,
        embedder_factory=None,
        reset_embedder_hook=None,
        reset_vector_client_hook=None,
        reset_vector_store_initialized_hook=None,
        document_class=None,
    ):
        self._config_getter = config_getter or get_config
        self._vectorizer_store = vectorizer_store
        self._model_manager = model_manager
        self._vector_client = vector_client
        self._embedder_factory = embedder_factory or get_embedder_for_vectorizer
        self._reset_embedder_hook = reset_embedder_hook or reset_embedder
        self._reset_vector_client_hook = reset_vector_client_hook or reset_vector_client
        self._reset_vector_store_initialized_hook = (
            reset_vector_store_initialized_hook or reset_vector_store_initialized
        )
        self._document_class = document_class

    def file_status(self) -> Dict[str, Any]:
        model_manager = self._get_model_manager()
        store = self._get_vectorizer_store()
        vectorizer_list = store.list_vectorizers()

        model_by_key = {}
        for row in vectorizer_list:
            key = row['vectorizer_key']
            model = model_manager.get_model_by_vectorizer_key(key) if key else None
            if model:
                model_by_key[key] = {
                    'vectorizer_key': key,
                    'model_name': row.get('model_name', ''),
                    'provider_key': row.get('provider_key', ''),
                    'dimension': model.vector_dimension,
                    'model_id': model.id,
                }

        conn = model_manager.conn
        cursor = conn.execute(
            """
            SELECT
                collection,
                json_extract(metadata, '$.document_id') AS file_id,
                MAX(COALESCE(
                    NULLIF(TRIM(REPLACE(json_extract(metadata, '$.original_filename'), '"', '')), ''),
                    NULLIF(TRIM(REPLACE(json_extract(metadata, '$.source'), '"', '')), ''),
                    json_extract(metadata, '$.document_id')
                )) AS file_name,
                COUNT(*) AS chunk_count
            FROM documents
            WHERE json_extract(metadata, '$.document_id') IS NOT NULL AND json_extract(metadata, '$.document_id') != ''
            GROUP BY collection, file_id
            ORDER BY collection, file_name
            """
        )
        rows = cursor.fetchall()

        file_list = []
        for row in rows:
            collection = row[0]
            file_id = (row[1] or '').strip().strip('"')
            raw_name = row[2]
            if isinstance(raw_name, str):
                file_name = raw_name.strip().strip('"')
            else:
                file_name = (raw_name or file_id or '').strip().strip('"') if raw_name else (file_id or '')
            chunk_count = row[3]

            cursor2 = conn.execute(
                "SELECT id FROM documents WHERE collection = ? AND json_extract(metadata, '$.document_id') = ?",
                (collection, file_id),
            )
            chunk_ids = [item[0] for item in cursor2.fetchall()]
            vectorizer_status = {}
            for key, info in model_by_key.items():
                model_id = info['model_id']
                if not chunk_ids:
                    vectorizer_status[key] = '未索引'
                    continue

                placeholders = ','.join('?' * len(chunk_ids))
                cursor3 = conn.execute(
                    'SELECT COUNT(*) FROM document_vectors WHERE model_id = ? AND collection = ? AND doc_id IN (' + placeholders + ')',
                    [model_id, collection] + chunk_ids,
                )
                count = cursor3.fetchone()[0]
                vectorizer_status[key] = '已索引' if count == chunk_count else '未索引'

            file_list.append(
                {
                    'file_name': file_name,
                    'file_id': file_id,
                    'collection': collection,
                    'chunk_count': chunk_count,
                    'vectorizer_status': vectorizer_status,
                }
            )

        return {
            'files': file_list,
            'vectorizers': list(model_by_key.values()),
        }

    def index_file(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        body = payload or {}
        collection = (body.get('collection') or '').strip()
        file_id = (body.get('file_id') or '').strip()
        vectorizer_key = (body.get('vectorizer_key') or '').strip()
        if not collection or not file_id or not vectorizer_key:
            raise VectorLibraryServiceError('缺少 collection、file_id 或 vectorizer_key', status_code=400)

        store = self._get_vectorizer_store()
        if store.get_vectorizer(vectorizer_key) is None:
            raise VectorLibraryServiceError(f'向量化器不存在: {vectorizer_key}', status_code=404)

        embedder = self._embedder_factory(vectorizer_key)
        if not embedder:
            raise VectorLibraryServiceError('无法创建该向量化器的 Embedder', status_code=400)

        model_manager = self._get_model_manager()
        model = model_manager.get_model_by_vectorizer_key(vectorizer_key)
        if not model:
            raise VectorLibraryServiceError('该向量化器未在 DB 注册', status_code=400)

        conn = model_manager.conn
        cursor = conn.execute(
            "SELECT id, content FROM documents WHERE collection = ? AND TRIM(REPLACE(COALESCE(json_extract(metadata, '$.document_id'), ''), '\"', '')) = ? ORDER BY id",
            (collection, file_id.strip().strip('"')),
        )
        rows = cursor.fetchall()
        if not rows:
            raise VectorLibraryServiceError('未找到该文件对应的分块', status_code=404)

        texts = [row[1] for row in rows]
        doc_ids = [row[0] for row in rows]
        embeddings = embedder.embed(texts)
        if embeddings and isinstance(embeddings[0], float):
            embeddings = [embeddings]

        for index, doc_id in enumerate(doc_ids):
            if index >= len(embeddings):
                break
            vector = embeddings[index]
            blob = struct.pack(f'{len(vector)}f', *vector)
            conn.execute(
                'DELETE FROM document_vectors WHERE doc_id = ? AND collection = ? AND model_id = ?',
                (doc_id, collection, model.id),
            )
            conn.execute(
                'INSERT INTO document_vectors (doc_id, collection, model_id, embedding) VALUES (?, ?, ?, ?)',
                (doc_id, collection, model.id, blob),
            )
        conn.commit()

        return {
            'indexed_count': len(doc_ids),
            'vectorizer_key': vectorizer_key,
        }

    def delete_file(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        body = payload or {}
        collection = (body.get('collection') or '').strip()
        file_id = (body.get('file_id') or '').strip().strip('"')
        if not collection or not file_id:
            raise VectorLibraryServiceError('缺少 collection 或 file_id', status_code=400)

        model_manager = self._get_model_manager()
        conn = model_manager.conn
        cursor = conn.execute(
            "SELECT id FROM documents WHERE collection = ? AND TRIM(REPLACE(COALESCE(json_extract(metadata, '$.document_id'), ''), '\"', '')) = ?",
            (collection, file_id),
        )
        chunk_ids = [row[0] for row in cursor.fetchall()]
        if not chunk_ids:
            raise VectorLibraryServiceError('未找到该文件对应的分块', status_code=404)

        placeholders = ','.join('?' * len(chunk_ids))
        conn.execute(
            f'DELETE FROM document_vectors WHERE doc_id IN ({placeholders}) AND collection = ?',
            (*chunk_ids, collection),
        )
        conn.execute(
            f'DELETE FROM documents WHERE id IN ({placeholders}) AND collection = ?',
            (*chunk_ids, collection),
        )
        conn.commit()

        return {
            'deleted_chunks': len(chunk_ids),
            'collection': collection,
            'file_id': file_id,
        }

    def list_vectorizers(self) -> list[Dict[str, Any]]:
        store = self._get_vectorizer_store()
        rows = store.list_vectorizers()
        model_manager = self._get_model_manager()
        result = []
        for row in rows:
            key = row['vectorizer_key']
            model = model_manager.get_model_by_vectorizer_key(key) if key else None
            stats = model_manager.get_model_stats(model.id) if model else {}
            result.append(
                {
                    'vectorizer_key': key,
                    'provider_key': row.get('provider_key', ''),
                    'model_name': row.get('model_name', ''),
                    'distance_metric': row.get('distance_metric', 'cosine'),
                    'created_at': row.get('created_at'),
                    'is_active': row.get('is_active', False),
                    'vector_dimension': model.vector_dimension if model else None,
                    'vector_count': stats.get('vector_count', 0),
                    'model_id': model.id if model else None,
                }
            )
        return result

    def add_vectorizer(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        body = payload or {}
        provider_key = (body.get('provider_key') or '').strip()
        model_name = (body.get('model_name') or '').strip()
        distance_metric = body.get('distance_metric') or 'cosine'
        provider_type = body.get('provider_type')

        if not provider_key or not model_name:
            raise VectorLibraryServiceError('缺少 provider_key 或 model_name', status_code=400)

        store = self._get_vectorizer_store()
        try:
            key = store.add_vectorizer(
                provider_key=provider_key,
                model_name=model_name,
                distance_metric=distance_metric,
                provider_type=provider_type,
            )
        except ValueError as error:
            raise VectorLibraryServiceError(str(error), status_code=400) from error

        embedder = self._embedder_factory(key)
        if not embedder:
            raise VectorLibraryServiceError('无法创建该向量化器的 Embedder（请检查 Model Adapter 配置）', status_code=400)
        dimension = embedder.embedding_dim

        model_manager = self._get_model_manager()
        model_id = model_manager.register_model(
            provider=provider_key,
            model_name=model_name,
            vector_dimension=dimension,
            distance_metric=distance_metric,
            vectorizer_key=key,
            set_active=False,
        )

        return {
            'vectorizer_key': key,
            'model_id': model_id,
            'vector_dimension': dimension,
        }

    def activate_vectorizer(self, key: str) -> Dict[str, Any]:
        store = self._get_vectorizer_store()
        if store.get_vectorizer(key) is None:
            raise VectorLibraryServiceError(f'向量化器不存在: {key}', status_code=404)
        store.set_active_key(key)

        model_manager = self._get_model_manager()
        model = model_manager.get_model_by_vectorizer_key(key)
        if model:
            model_manager.set_active_model(model.id)

        self._reset_runtime_state()
        return {'active_vectorizer_key': key}

    def list_docs_by_vectorizer(self, key: str, collection: Optional[str] = None) -> list[Dict[str, Any]]:
        model_manager = self._get_model_manager()
        model = model_manager.get_model_by_vectorizer_key(key)
        if not model:
            raise VectorLibraryServiceError(f'向量化器不存在或未在 DB 注册: {key}', status_code=404)

        conn = sqlite3.connect(self._get_db_path())
        conn.row_factory = sqlite3.Row
        try:
            if collection:
                cursor = conn.execute(
                    'SELECT doc_id, collection, created_at FROM document_vectors WHERE model_id = ? AND collection = ? ORDER BY created_at DESC LIMIT 500',
                    (model.id, collection),
                )
            else:
                cursor = conn.execute(
                    'SELECT doc_id, collection, created_at FROM document_vectors WHERE model_id = ? ORDER BY created_at DESC LIMIT 500',
                    (model.id,),
                )
            rows = cursor.fetchall()
            return [
                {'doc_id': row['doc_id'], 'collection': row['collection'], 'created_at': row['created_at']}
                for row in rows
            ]
        finally:
            conn.close()

    def migrate(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        body = payload or {}
        source_collection = (body.get('source_collection') or 'default').strip()
        target_vectorizer_key = (body.get('target_vectorizer_key') or '').strip()
        if not target_vectorizer_key:
            raise VectorLibraryServiceError('缺少 target_vectorizer_key', status_code=400)

        store = self._get_vectorizer_store()
        if store.get_vectorizer(target_vectorizer_key) is None:
            raise VectorLibraryServiceError(f'目标向量化器不存在: {target_vectorizer_key}', status_code=404)

        client = self._get_vector_client()
        client.ensure_initialized()
        target_embedder = self._embedder_factory(target_vectorizer_key)
        if not target_embedder:
            raise VectorLibraryServiceError('无法创建目标向量化器 Embedder', status_code=400)

        model_manager = self._get_model_manager()
        target_model = model_manager.get_model_by_vectorizer_key(target_vectorizer_key)
        if not target_model:
            raise VectorLibraryServiceError('目标向量化器未在 DB 注册', status_code=400)

        store_obj = client.store
        conn = store_obj.conn
        cursor = conn.execute(
            'SELECT id, content, metadata FROM documents WHERE collection = ?',
            (source_collection,),
        )
        documents = cursor.fetchall()
        if not documents:
            return {'migrated_count': 0, 'message': '集合无文档'}

        document_class = self._get_document_class()
        docs = [
            document_class(id=row['id'], content=row['content'], metadata=json.loads(row['metadata'] or '{}'))
            for row in documents
        ]
        texts = [doc.content for doc in docs]
        embeddings = target_embedder.embed(texts)
        if embeddings and isinstance(embeddings[0], float):
            embeddings = [embeddings]

        migrated = 0
        for index, doc in enumerate(docs):
            if index >= len(embeddings):
                break
            vector = embeddings[index]
            try:
                conn.execute(
                    """INSERT OR REPLACE INTO document_vectors (doc_id, collection, model_id, embedding, created_at)
                       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                    (doc.id, source_collection, target_model.id, store_obj._serialize_vector(vector)),
                )
                migrated += 1
            except Exception:
                continue
        conn.commit()
        return {'migrated_count': migrated, 'total': len(docs)}

    def delete_vectorizer(self, key: str) -> Dict[str, Any]:
        store = self._get_vectorizer_store()
        if store.get_vectorizer(key) is None:
            raise VectorLibraryServiceError(f'向量化器不存在: {key}', status_code=404)

        model_manager = self._get_model_manager()
        model = model_manager.get_model_by_vectorizer_key(key)
        if model:
            model_manager.delete_model(model.id, force=True)

        try:
            store.delete_vectorizer(key)
        except ValueError as error:
            raise VectorLibraryServiceError(str(error), status_code=400) from error

        self._reset_runtime_state()
        return {'deleted_vectorizer_key': key}

    def _get_db_path(self) -> str:
        config = self._config_getter()
        path = Path(config.vector_store.sqlite_vec.database_path)
        if not path.is_absolute():
            path = Path(__file__).resolve().parent.parent / path
        return str(path)

    def _get_vectorizer_store(self):
        return self._vectorizer_store or get_vectorizer_config_store()

    def _get_model_manager(self):
        if self._model_manager is not None:
            return self._model_manager

        try:
            client = self._get_vector_client()
            if getattr(client, '_store', None) is not None and hasattr(client._store, 'model_manager'):
                return client._store.model_manager
        except Exception:
            pass

        return EmbeddingModelManager(self._get_db_path())

    def _get_vector_client(self):
        return self._vector_client or get_vector_client()

    def _reset_runtime_state(self) -> None:
        try:
            self._reset_embedder_hook()
            self._reset_vector_client_hook()
            self._reset_vector_store_initialized_hook()
        except Exception:
            pass

    def _get_document_class(self):
        if self._document_class is not None:
            return self._document_class
        from vector_store.base import Document
        return Document


_vector_library_service: Optional[VectorLibraryService] = None



def get_vector_library_service() -> VectorLibraryService:
    global _vector_library_service
    return get_runtime_dependency(
        container_getter='get_vector_library_service',
        fallback_name='vector_library_service',
        fallback_factory=VectorLibraryService,
        require_container=True,
        legacy_getter=lambda: _vector_library_service,
        legacy_setter=lambda instance: globals().__setitem__('_vector_library_service', instance),
    )
