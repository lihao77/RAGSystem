# -*- coding: utf-8 -*-

from __future__ import annotations

from types import MethodType, SimpleNamespace

from vector_store.indexer import DocumentIndexer
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
