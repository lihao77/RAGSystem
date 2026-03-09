# -*- coding: utf-8 -*-
"""Vector retrieval capability facade."""

from __future__ import annotations

from typing import Optional

from runtime.dependencies import get_runtime_dependency
from services.vector_library_service import VectorLibraryService, get_vector_library_service

from .base import BaseCapability, CapabilityDescriptor


class VectorRetrievalCapability(BaseCapability):
    descriptor = CapabilityDescriptor(
        name='vector_retrieval',
        category='vector',
        description='Expose vector indexing and retrieval management to agents and ops routes.',
    )

    def __init__(self, *, service: Optional[VectorLibraryService] = None):
        self._service = service or get_vector_library_service()

    def file_status(self):
        return self._service.file_status()

    def index_file(self, payload):
        return self._service.index_file(payload)

    def delete_file(self, payload):
        return self._service.delete_file(payload)

    def list_vectorizers(self):
        return self._service.list_vectorizers()

    def add_vectorizer(self, payload):
        return self._service.add_vectorizer(payload)

    def activate_vectorizer(self, key: str):
        return self._service.activate_vectorizer(key)

    def list_docs_by_vectorizer(self, key: str, collection: Optional[str] = None):
        return self._service.list_docs_by_vectorizer(key, collection)

    def migrate(self, payload):
        return self._service.migrate(payload)

    def delete_vectorizer(self, key: str):
        return self._service.delete_vectorizer(key)


def get_vector_retrieval_capability() -> VectorRetrievalCapability:
    return get_runtime_dependency(container_getter='get_vector_retrieval_capability')
