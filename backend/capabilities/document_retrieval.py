# -*- coding: utf-8 -*-
"""Document/file retrieval capability."""

from __future__ import annotations

from typing import Optional

from runtime.dependencies import get_runtime_dependency
from tools.document_tools import DOCUMENT_TOOLS

from .base import BaseCapability, CapabilityDescriptor


class DocumentRetrievalCapability(BaseCapability):
    descriptor = CapabilityDescriptor(
        name='document_retrieval',
        category='document',
        description='Expose document and file IO tools to agents.',
    )

    def list_tool_definitions(self) -> list[dict]:
        return list(DOCUMENT_TOOLS)


_document_retrieval_capability: Optional[DocumentRetrievalCapability] = None


def get_document_retrieval_capability() -> DocumentRetrievalCapability:
    global _document_retrieval_capability
    return get_runtime_dependency(
        container_getter='get_document_retrieval_capability',
        fallback_name='document_retrieval_capability',
        fallback_factory=DocumentRetrievalCapability,
        require_container=True,
        legacy_getter=lambda: _document_retrieval_capability,
        legacy_setter=lambda instance: globals().__setitem__('_document_retrieval_capability', instance),
    )
