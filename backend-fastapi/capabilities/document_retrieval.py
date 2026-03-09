# -*- coding: utf-8 -*-
"""Document/file retrieval capability."""

from __future__ import annotations

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


def get_document_retrieval_capability() -> DocumentRetrievalCapability:
    return get_runtime_dependency(container_getter='get_document_retrieval_capability')
