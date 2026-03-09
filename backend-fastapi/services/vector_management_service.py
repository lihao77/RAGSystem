# -*- coding: utf-8 -*-
"""
向量管理服务层。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
import os
from typing import Any, Dict, Optional

from vector_store import DocumentIndexer, VectorRetriever, get_vector_client


class VectorManagementServiceError(Exception):
    """向量管理业务异常。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class VectorManagementService:
    """封装集合管理、检索、索引、健康检查逻辑。"""

    def __init__(
        self,
        *,
        vector_client=None,
        indexer_factory=None,
        retriever_factory=None,
        file_index_factory=None,
        path_exists=None,
        file_reader=None,
    ):
        self._vector_client = vector_client
        self._indexer_factory = indexer_factory or DocumentIndexer
        self._retriever_factory = retriever_factory or VectorRetriever
        self._file_index_factory = file_index_factory
        self._path_exists = path_exists or os.path.exists
        self._file_reader = file_reader or self._read_text_file

    def list_collections(self) -> list[Dict[str, Any]]:
        client = self._get_vector_client()
        collections = client.list_collections()
        stats = []
        for collection_name in collections:
            try:
                info = client.get_collection_info(collection_name)
                stats.append(
                    {
                        'name': info.get('name', collection_name),
                        'total_chunks': info.get('document_count', 0),
                        'embedding_dimension': info.get('vector_dimension', 0),
                        'model_name': '',
                        'metadata': info.get('metadata', {}),
                    }
                )
            except Exception as error:
                stats.append(
                    {
                        'name': collection_name,
                        'total_chunks': 0,
                        'embedding_dimension': 0,
                        'model_name': '',
                        'metadata': {},
                        'error': str(error),
                    }
                )
        return stats

    def delete_collection(self, collection_name: str) -> Dict[str, Any]:
        client = self._get_vector_client()
        client.delete_collection(collection_name)
        return {'message': f'集合 {collection_name} 已删除'}

    def search_vectors(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        data = payload or {}
        collection_name = data.get('collection_name', 'documents')
        query = data.get('query', '')
        top_k = data.get('top_k', 5)
        if not query:
            raise VectorManagementServiceError('查询内容不能为空', status_code=400)

        retriever = self._retriever_factory(collection_name=collection_name)
        results = retriever.search(query=query, top_k=top_k, include_distances=True)
        return {
            'results': results,
            'count': len(results),
            'collection_name': collection_name,
            'query': query,
        }

    def index_document(
        self,
        *,
        payload: Optional[Dict[str, Any]] = None,
        uploaded_file=None,
        form: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if uploaded_file is not None:
            collection_name, document_id, metadata, chunk_size, overlap, text = self._load_uploaded_file(uploaded_file, form or {})
        else:
            collection_name, document_id, metadata, chunk_size, overlap, text = self._load_payload(payload or {})

        if not document_id or not text:
            raise VectorManagementServiceError('document_id和文本内容不能为空', status_code=400)

        indexer = self._indexer_factory(collection_name=collection_name)
        chunk_count = indexer.index_document(
            document_id=document_id,
            text=text,
            metadata=metadata,
            chunk_size=chunk_size,
            overlap=overlap,
        )
        stats = indexer.get_collection_stats()
        return {
            'document_id': document_id,
            'chunk_count': chunk_count,
            'collection_name': collection_name,
            'stats': stats,
            'message': f'成功索引文档，生成 {chunk_count} 个分块',
        }

    def delete_document(self, collection_name: str, document_id: str) -> Dict[str, Any]:
        indexer = self._indexer_factory(collection_name=collection_name)
        indexer.delete_document(document_id)
        return {'message': f'文档 {document_id} 已从集合 {collection_name} 中删除'}

    def list_documents(self, collection_name: str) -> Dict[str, Any]:
        retriever = self._retriever_factory(collection_name=collection_name)
        info = retriever.get_collection_info()
        return {
            'collection_name': collection_name,
            'total_chunks': info.get('total_chunks', 0),
            'sample_ids': info.get('sample_ids', []),
            'info': info,
        }

    def health_check(self) -> Dict[str, Any]:
        client = self._get_vector_client()
        collections = client.list_collections()
        return {'status': 'healthy', 'collections_count': len(collections)}

    def _load_uploaded_file(self, uploaded_file, form: Dict[str, Any]):
        if uploaded_file.filename == '':
            raise VectorManagementServiceError('未选择文件', status_code=400)

        try:
            text = uploaded_file.read().decode('utf-8')
        except UnicodeDecodeError as error:
            raise VectorManagementServiceError('文件编码错误，请确保文件为UTF-8编码', status_code=400) from error

        collection_name = form.get('collection_name', 'documents')
        document_id = form.get('document_id', uploaded_file.filename)
        metadata = {
            'source': form.get('source', uploaded_file.filename),
            'document_type': form.get('document_type', 'general'),
            'original_filename': uploaded_file.filename,
        }
        chunk_size = int(form.get('chunk_size', 500))
        overlap = int(form.get('overlap', 50))
        return collection_name, document_id, metadata, chunk_size, overlap, text

    def _load_payload(self, data: Dict[str, Any]):
        collection_name = data.get('collection_name', 'documents')
        document_id = data.get('document_id', '')
        metadata = dict(data.get('metadata', {}))
        chunk_size = data.get('chunk_size', 500)
        overlap = data.get('overlap', 50)

        file_id = data.get('file_id')
        if file_id:
            file_index = self._get_file_index()
            file_record = file_index.get(file_id)
            if not file_record:
                raise VectorManagementServiceError(f'文件不存在: {file_id}', status_code=404)

            file_path = file_record.get('stored_path')
            if not file_path or not self._path_exists(file_path):
                raise VectorManagementServiceError(f'文件路径无效: {file_path}', status_code=404)

            try:
                text = self._file_reader(file_path)
            except Exception as error:
                raise VectorManagementServiceError(f'读取文件失败: {error}', status_code=500) from error

            original_name = file_record.get('original_name', file_id)
            if not document_id:
                document_id = original_name
            metadata['source'] = metadata.get('source', original_name)
            metadata['file_id'] = file_id
            metadata['original_filename'] = original_name
            return collection_name, document_id, metadata, chunk_size, overlap, text

        text = data.get('text', '')
        if not text:
            raise VectorManagementServiceError('必须提供 text、file_id 或上传文件', status_code=400)
        return collection_name, document_id, metadata, chunk_size, overlap, text

    def _get_file_index(self):
        if self._file_index_factory is not None:
            return self._file_index_factory()
        from file_index import FileIndex
        return FileIndex()

    def _get_vector_client(self):
        return self._vector_client or get_vector_client()

    @staticmethod
    def _read_text_file(path: str) -> str:
        with open(path, 'r', encoding='utf-8') as file:
            return file.read()


def get_vector_management_service() -> VectorManagementService:
    return get_runtime_dependency(container_getter='get_vector_management_service')
