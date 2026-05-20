# -*- coding: utf-8 -*-

from __future__ import annotations

import yaml

from vector_store.reranker_config import RerankerConfigStore


def test_add_model_reranker_persists_api_key(tmp_path):
    config_path = tmp_path / "rerankers.yaml"
    store = RerankerConfigStore(config_path)

    key = store.add_reranker(
        mode="model",
        provider_key="jina",
        provider_type="rerank_api",
        model_name="jina-reranker-v2-base-multilingual",
        api_endpoint="https://api.jina.ai/v1/rerank",
        api_key="${JINA_API_KEY}",
    )

    assert key == "jina_jina-reranker-v2-base-multilingual"
    cfg = store.get_reranker(key)
    assert cfg["api_key"] == "${JINA_API_KEY}"

    persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert persisted["rerankers"][key]["api_key"] == "${JINA_API_KEY}"
