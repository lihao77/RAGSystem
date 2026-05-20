# -*- coding: utf-8 -*-

from __future__ import annotations

from types import MethodType, SimpleNamespace

import pytest

from vector_store.indexer import DocumentIndexer
from vector_store.reranker import ModelProviderReranker, NoopReranker, get_reranker
from vector_store.retriever import VectorRetriever


def test_chunk_document_preserves_markdown_section_metadata():
    text = (
        "# 防汛预案\n"
        "总则内容。\n"
        "## 响应条件\n"
        "三级响应在持续强降雨并达到阈值时启动。\n"
        "## 处置流程\n"
        "通知责任人并完成巡查。\n"
    )

    chunks = DocumentIndexer.chunk_document(text, chunk_size=80, overlap=10, use_jieba=False)

    assert chunks
    response_chunk = next(item for item in chunks if "三级响应" in item["text"])
    metadata = response_chunk["metadata"]
    assert metadata["chunking_strategy"] == "markdown_sections"
    assert metadata["section_title"] == "响应条件"
    assert metadata["section_path"] == "防汛预案 > 响应条件"
    assert metadata["section_path_list"] == ["防汛预案", "响应条件"]
    assert metadata["section_level"] == 2
    assert metadata["start_char"] < metadata["end_char"]
    assert text[metadata["start_char"]:metadata["end_char"]] == response_chunk["text"]


def test_chunk_document_plain_text_fallback_has_offsets():
    text = "  abcdefabcdef  "

    chunks = DocumentIndexer.chunk_document(text, chunk_size=4, overlap=2, use_jieba=False)

    assert [item["text"] for item in chunks] == ["abcd", "cdef", "efab", "abcd", "cdef", "ef"]
    assert all(item["metadata"]["chunking_strategy"] == "plain_text" for item in chunks)
    assert all(item["metadata"]["section_path"] == "" for item in chunks)
    for item in chunks:
        metadata = item["metadata"]
        assert text[metadata["start_char"]:metadata["end_char"]] == item["text"]


def test_chunk_text_with_repeated_overlap_keeps_real_offsets():
    text = "abc abc abc"

    chunks = DocumentIndexer.chunk_document(text, chunk_size=7, overlap=3, use_jieba=False)

    assert [item["text"] for item in chunks] == ["abc abc", "abc abc", "abc"]
    assert [item["metadata"]["start_char"] for item in chunks] == [0, 4, 8]
    for item in chunks:
        metadata = item["metadata"]
        assert text[metadata["start_char"]:metadata["end_char"]] == item["text"]


def test_hybrid_search_can_include_keyword_only_candidate():
    retriever = VectorRetriever.__new__(VectorRetriever)

    vector_results = [
        {
            "id": "semantic-only",
            "text": "这里描述一般防汛流程。",
            "metadata": {},
            "similarity": 0.95,
            "distance": 0.1,
        }
    ]
    keyword_candidates = [
        *vector_results,
        {
            "id": "keyword-hit",
            "text": "三级响应 启动条件 为持续强降雨达到预警阈值。",
            "metadata": {"section_path": "防汛预案 > 响应条件"},
        },
    ]

    def fake_search(self, query, top_k=5, filters=None, include_distances=True):
        return vector_results

    def fake_load_keyword_candidates(self, filters=None, limit=2000):
        return keyword_candidates

    retriever.search = MethodType(fake_search, retriever)
    retriever._load_keyword_candidates = MethodType(fake_load_keyword_candidates, retriever)

    results = retriever.hybrid_search("三级响应启动条件", top_k=2)

    ids = [item["id"] for item in results]
    assert "semantic-only" in ids
    assert "keyword-hit" in ids
    keyword_hit = next(item for item in results if item["id"] == "keyword-hit")
    assert keyword_hit["retrieval_sources"] == ["keyword"]
    assert keyword_hit["keyword_score"] > 0
    assert keyword_hit["hybrid_score"] > 0


def test_hybrid_search_can_apply_lexical_reranker_after_fusion():
    retriever = VectorRetriever.__new__(VectorRetriever)

    vector_results = [
        {
            "id": "semantic-high",
            "text": "这里描述一般防汛流程。",
            "metadata": {},
            "similarity": 0.99,
            "distance": 0.1,
        },
        {
            "id": "rerank-hit",
            "text": "三级响应 启动条件 为持续强降雨达到预警阈值。",
            "metadata": {"section_path": "防汛预案 > 响应条件"},
            "similarity": 0.4,
            "distance": 0.8,
        },
    ]

    def fake_search(self, query, top_k=5, filters=None, include_distances=True):
        return vector_results

    def fake_load_keyword_candidates(self, filters=None, limit=2000):
        return vector_results

    def fake_bm25_rank(self, query, documents, top_k):
        return []

    retriever.search = MethodType(fake_search, retriever)
    retriever._load_keyword_candidates = MethodType(fake_load_keyword_candidates, retriever)
    retriever._bm25_rank = MethodType(fake_bm25_rank, retriever)

    results = retriever.hybrid_search(
        "三级响应启动条件",
        top_k=2,
        rerank=True,
        rerank_mode="lexical",
    )

    assert [item["id"] for item in results] == ["rerank-hit", "semantic-high"]
    assert results[0]["rerank_score"] > results[1]["rerank_score"]
    assert results[0]["rerank_rank"] == 1


def test_load_keyword_candidates_uses_vector_client_and_filters_keys():
    retriever = VectorRetriever.__new__(VectorRetriever)
    retriever.collection_name = "plans"
    captured = {}

    class FakeVectorClient:
        def list_documents(self, collection="default", filters=None, limit=1000):
            captured["collection"] = collection
            captured["filters"] = filters
            captured["limit"] = limit
            return [
                SimpleNamespace(id="doc-1", content="三级响应启动条件", metadata={"plan_type": "防汛"}),
            ]

    retriever.vector_client = FakeVectorClient()

    candidates = retriever._load_keyword_candidates(
        filters={"plan_type": "防汛", "bad.key": "ignored"},
        limit=5,
    )

    assert candidates == [
        {"id": "doc-1", "text": "三级响应启动条件", "metadata": {"plan_type": "防汛"}},
    ]
    assert captured == {"collection": "plans", "filters": {"plan_type": "防汛"}, "limit": 5}


def test_bm25_rank_prefers_exact_term_matches():
    documents = [
        {"id": "a", "text": "普通防汛巡查流程", "metadata": {}},
        {"id": "b", "text": "三级响应 启动条件 预警阈值", "metadata": {}},
    ]

    results = VectorRetriever._bm25_rank("三级响应启动条件", documents, top_k=2)

    assert results[0]["id"] == "b"
    assert results[0]["keyword_score"] > 0


def test_bm25_rank_handles_empty_inputs():
    assert VectorRetriever._bm25_rank("", [{"id": "a", "text": "内容", "metadata": {}}], top_k=2) == []
    assert VectorRetriever._bm25_rank("内容", [], top_k=2) == []


def test_rrf_fuse_merges_overlapping_documents():
    results = VectorRetriever._rrf_fuse(
        ranked_sources=[
            ("vector", [{"id": "same", "text": "a", "metadata": {}, "similarity": 0.9}]),
            ("keyword", [{"id": "same", "text": "a", "metadata": {}, "keyword_score": 2.0}]),
        ],
        rrf_k=60,
    )

    assert len(results) == 1
    assert results[0]["retrieval_sources"] == ["vector", "keyword"]
    assert results[0]["vector_rank"] == 1
    assert results[0]["keyword_rank"] == 1
    assert results[0]["hybrid_score"] > 0


def test_noop_reranker_preserves_order_without_scores():
    documents = [
        {"id": "a", "text": "first", "metadata": {}},
        {"id": "b", "text": "second", "metadata": {}},
    ]

    results = NoopReranker().rerank(query="anything", documents=documents, top_k=2)

    assert [item["id"] for item in results] == ["a", "b"]
    assert "rerank_score" not in results[0]


def test_model_provider_reranker_calls_configured_http_endpoint():
    captured = {}

    class FakeConfigStore:
        def load_all(self):
            return {
                "jina_rerank_api": {
                    "name": "jina",
                    "provider_type": "rerank_api",
                    "api_key": "test-key",
                    "api_endpoint": "https://api.jina.ai/v1/rerank",
                    "model_map": {"rerank": "jina-reranker-v2-base-multilingual"},
                    "timeout": 7,
                }
            }

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "results": [
                    {"index": 1, "relevance_score": 0.92},
                    {"index": 0, "relevance_score": 0.12},
                ]
            }

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        captured["timeout"] = timeout
        return FakeResponse()

    reranker = ModelProviderReranker(
        provider="jina_rerank_api",
        config_store=FakeConfigStore(),
        post_func=fake_post,
    )

    results = reranker.rerank(
        query="三级响应启动条件",
        documents=[
            {"id": "a", "text": "普通巡查流程", "metadata": {}},
            {"id": "b", "text": "三级响应启动条件", "metadata": {"section_path": "预案 > 响应"}},
        ],
        top_k=2,
    )

    assert captured["url"] == "https://api.jina.ai/v1/rerank"
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["json"]["model"] == "jina-reranker-v2-base-multilingual"
    assert "section_path: 预案 > 响应" in captured["json"]["documents"][1]
    assert captured["timeout"] == 7
    assert [item["id"] for item in results] == ["b", "a"]
    assert results[0]["rerank_mode"] == "model"
    assert results[0]["rerank_provider"] == "jina_rerank_api"
    assert results[0]["rerank_model"] == "jina-reranker-v2-base-multilingual"
    assert results[0]["rerank_rank"] == 1


def test_model_provider_reranker_can_use_explicit_cohere_endpoint():
    reranker = ModelProviderReranker(
        provider="cohere",
        provider_type="cohere",
        model="rerank-v3.5",
        api_endpoint="https://api.cohere.com",
        api_key="test-key",
        post_func=lambda *args, **kwargs: None,
    )

    assert reranker.api_endpoint == "https://api.cohere.com/v2/rerank"


def test_model_provider_reranker_requires_complete_config():
    class EmptyConfigStore:
        def load_all(self):
            return {}

    with pytest.raises(ValueError) as error:
        get_reranker("model", config_store=EmptyConfigStore())

    assert "rerank 模型配置不完整" in str(error.value)


def test_resolve_reranker_rejects_missing_key(monkeypatch):
    class EmptyRerankerStore:
        def get_reranker(self, key):
            return None

        def get_active_reranker_config(self):
            return None

    import vector_store.reranker_config as reranker_config_module

    monkeypatch.setattr(reranker_config_module, "get_reranker_config_store", lambda: EmptyRerankerStore())

    with pytest.raises(ValueError) as error:
        VectorRetriever._resolve_reranker(rerank_mode="active", reranker_key="missing")

    assert "重排序器不存在" in str(error.value)


def test_get_reranker_rejects_unknown_mode():
    with pytest.raises(ValueError):
        get_reranker("remote-model")


def test_tokenize_falls_back_without_jieba(monkeypatch):
    import vector_store.retriever as retriever_module

    monkeypatch.setattr(retriever_module, "jieba", None)

    tokens = VectorRetriever._tokenize("三级响应 abc")

    assert "abc" in tokens
    assert "三" in tokens
    assert "级" in tokens


def test_safe_metadata_key_rejects_unsafe_names():
    assert VectorRetriever._is_safe_metadata_key("plan_type") is True
    assert VectorRetriever._is_safe_metadata_key("_tenant1") is True
    assert VectorRetriever._is_safe_metadata_key("bad.key") is False
    assert VectorRetriever._is_safe_metadata_key("x') OR 1=1 --") is False
