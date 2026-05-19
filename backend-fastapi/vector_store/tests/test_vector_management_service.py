# -*- coding: utf-8 -*-

from __future__ import annotations

import pytest

from services.vector_management_service import VectorManagementService, VectorManagementServiceError


class FakeRetriever:
    instances = []

    def __init__(self, collection_name="documents"):
        self.collection_name = collection_name
        self.calls = []
        FakeRetriever.instances.append(self)

    def search(self, **kwargs):
        self.calls.append(("search", kwargs))
        return [{"id": "vector", "text": "vector result", "metadata": {}, "similarity": 0.9}]

    def hybrid_search(self, **kwargs):
        self.calls.append(("hybrid_search", kwargs))
        return [{"id": "hybrid", "text": "hybrid result", "metadata": {}, "hybrid_score": 0.1}]


def setup_function():
    FakeRetriever.instances = []


def test_search_vectors_defaults_to_hybrid_and_accepts_collection_alias():
    service = VectorManagementService(retriever_factory=FakeRetriever)

    result = service.search_vectors({"query": "三级响应", "collection": "emergency_plans", "top_k": 3})

    retriever = FakeRetriever.instances[-1]
    assert retriever.collection_name == "emergency_plans"
    assert retriever.calls == [
        (
            "hybrid_search",
            {
                "query": "三级响应",
                "keyword": None,
                "top_k": 3,
                "filters": None,
                "vector_top_k": None,
                "keyword_top_k": None,
                "keyword_candidate_limit": 2000,
                "rrf_k": 60,
            },
        )
    ]
    assert result["search_mode"] == "hybrid"
    assert result["results"][0]["id"] == "hybrid"


def test_search_vectors_can_use_vector_mode():
    service = VectorManagementService(retriever_factory=FakeRetriever)

    result = service.search_vectors({
        "query": "三级响应",
        "collection_name": "documents",
        "search_mode": "vector",
        "filters": {"document_type": "manual"},
    })

    retriever = FakeRetriever.instances[-1]
    assert retriever.calls == [
        (
            "search",
            {
                "query": "三级响应",
                "top_k": 5,
                "filters": {"document_type": "manual"},
                "include_distances": True,
            },
        )
    ]
    assert result["search_mode"] == "vector"
    assert result["results"][0]["id"] == "vector"


def test_search_vectors_rejects_unknown_mode():
    service = VectorManagementService(retriever_factory=FakeRetriever)

    with pytest.raises(VectorManagementServiceError) as error:
        service.search_vectors({"query": "三级响应", "search_mode": "rerank"})

    assert error.value.status_code == 400
    assert "search_mode" in error.value.message
