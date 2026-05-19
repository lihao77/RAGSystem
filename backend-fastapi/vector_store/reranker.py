# -*- coding: utf-8 -*-
"""Retrieval rerankers used after vector/BM25 recall fusion."""

from __future__ import annotations

import logging
import math
import os
import re
from abc import ABC, abstractmethod
from collections import Counter
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

try:
    import jieba
except ImportError:  # pragma: no cover - optional dependency fallback
    jieba = None


class RerankerBase(ABC):
    """Base interface for post-recall rerankers."""

    mode = "base"

    @abstractmethod
    def rerank(
        self,
        *,
        query: str,
        documents: List[Dict[str, Any]],
        top_k: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Return documents reordered by relevance."""
        raise NotImplementedError

    @staticmethod
    def _limit(documents: List[Dict[str, Any]], top_k: Optional[int]) -> int:
        if not documents:
            return 0
        if top_k is None:
            return len(documents)
        return max(0, min(len(documents), int(top_k)))

    @staticmethod
    def _document_text(document: Dict[str, Any]) -> str:
        """纯文本拼接，适用于 BM25 分词等本地场景。"""
        metadata = document.get("metadata") or {}
        section_path = metadata.get("section_path") or metadata.get("section_title") or ""
        text = str(document.get("text") or document.get("content") or "")
        return "\n".join(part for part in [text, str(section_path)] if part)

    @staticmethod
    def _document_text_tagged(document: Dict[str, Any]) -> str:
        """带字段前缀的文本，适用于发送给模型 API 的场景。"""
        metadata = document.get("metadata") or {}
        section_path = metadata.get("section_path") or metadata.get("section_title") or ""
        text = str(document.get("text") or document.get("content") or "")
        if not section_path:
            return text
        return f"section_path: {section_path}\ntext: {text}"


class NoopReranker(RerankerBase):
    """Identity reranker used as a safe default."""

    mode = "none"

    def rerank(
        self,
        *,
        query: str,
        documents: List[Dict[str, Any]],
        top_k: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        del query
        limit = self._limit(documents, top_k)
        return [dict(item) for item in documents[:limit]]


class LexicalReranker(RerankerBase):
    """Local BM25-style reranker for environments without a rerank model."""

    mode = "lexical"
    _TOKEN_RE = re.compile(r"[\w]+", re.UNICODE)

    def rerank(
        self,
        *,
        query: str,
        documents: List[Dict[str, Any]],
        top_k: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        limit = self._limit(documents, top_k)
        if limit == 0:
            return []

        query_terms = self._tokenize(query)
        if not query_terms:
            return [dict(item) for item in documents[:limit]]

        doc_texts = [self._document_text(item) for item in documents]
        doc_tokens = [self._tokenize(text) for text in doc_texts]
        lengths = [len(tokens) for tokens in doc_tokens]
        avgdl = sum(lengths) / len(lengths) if lengths else 0.0
        if avgdl <= 0:
            return [dict(item) for item in documents[:limit]]

        document_frequency: Counter[str] = Counter()
        for tokens in doc_tokens:
            document_frequency.update(set(tokens))

        total_docs = len(documents)
        query_counter = Counter(query_terms)
        scored: List[tuple[float, int, Dict[str, Any]]] = []

        for original_index, (document, tokens, doc_len, text) in enumerate(
            zip(documents, doc_tokens, lengths, doc_texts)
        ):
            rerank_score = self._bm25_score(
                query_counter=query_counter,
                document_frequency=document_frequency,
                total_docs=total_docs,
                tokens=tokens,
                doc_len=doc_len,
                avgdl=avgdl,
            )
            rerank_score += self._exact_query_bonus(query, text, len(query_counter))

            item = dict(document)
            item["rerank_score"] = rerank_score
            item["rerank_mode"] = self.mode
            scored.append((rerank_score, original_index, item))

        scored.sort(
            key=lambda row: (
                row[0],
                row[2].get("hybrid_score", 0.0),
                row[2].get("similarity", 0.0),
                row[2].get("keyword_score", 0.0),
                -row[1],
            ),
            reverse=True,
        )

        reranked = [item for _, _, item in scored[:limit]]
        for rank, item in enumerate(reranked, start=1):
            item["rerank_rank"] = rank
        return reranked

    @classmethod
    def _tokenize(cls, text: str) -> List[str]:
        if not text:
            return []

        tokens: List[str] = []
        if jieba is not None:
            try:
                tokens.extend(token.strip().lower() for token in jieba.cut(text) if token.strip())
            except Exception as exc:  # pragma: no cover - defensive fallback
                logger.debug("jieba tokenization failed during rerank: %s", exc)
                tokens = []

        if not tokens:
            tokens.extend(match.group(0).lower() for match in cls._TOKEN_RE.finditer(text))

        if jieba is None:
            tokens.extend(char for char in text.lower() if "\u4e00" <= char <= "\u9fff")

        return tokens

    @staticmethod
    def _bm25_score(
        *,
        query_counter: Counter[str],
        document_frequency: Counter[str],
        total_docs: int,
        tokens: List[str],
        doc_len: int,
        avgdl: float,
        k1: float = 1.5,
        b: float = 0.75,
    ) -> float:
        if not tokens or doc_len <= 0:
            return 0.0

        term_frequency = Counter(tokens)
        score = 0.0
        for term, query_weight in query_counter.items():
            tf = term_frequency.get(term, 0)
            if tf <= 0:
                continue
            df = document_frequency.get(term, 0)
            idf = math.log(1 + (total_docs - df + 0.5) / (df + 0.5))
            denominator = tf + k1 * (1 - b + b * doc_len / avgdl)
            score += query_weight * idf * (tf * (k1 + 1)) / denominator
        return score

    @staticmethod
    def _exact_query_bonus(query: str, text: str, query_term_count: int) -> float:
        normalized_query = re.sub(r"\s+", "", str(query or "").lower())
        normalized_text = re.sub(r"\s+", "", str(text or "").lower())
        if not normalized_query or normalized_query not in normalized_text:
            return 0.0
        return max(1.0, float(query_term_count))


class ModelProviderReranker(RerankerBase):
    """HTTP reranker backed by a configured model provider."""

    mode = "model"
    _RERANK_TASK_KEYS = ("rerank", "reranker", "ranking")
    _DIRECT_PROVIDER_TYPES = {"rerank_api", "jina", "cohere", "http", "provider", "model"}

    def __init__(
        self,
        *,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        provider_type: Optional[str] = None,
        api_endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: Optional[float] = None,
        max_tokens_per_doc: Optional[int] = None,
        config_store: Any = None,
        post_func: Optional[Callable[..., Any]] = None,
    ):
        self.max_tokens_per_doc = max_tokens_per_doc

        resolved = self._resolve_config(
            provider=provider,
            model=model,
            provider_type=provider_type,
            api_endpoint=api_endpoint,
            api_key=api_key,
            timeout=timeout,
            config_store=config_store,
        )
        self.provider_key = resolved["provider_key"]
        self.provider_type = resolved["provider_type"]
        self.model = resolved["model"]
        self.api_key = resolved["api_key"]
        self.api_endpoint = resolved["api_endpoint"]
        self.timeout = resolved["timeout"]
        self.provider = self._create_provider(post_func=post_func)

    def rerank(
        self,
        *,
        query: str,
        documents: List[Dict[str, Any]],
        top_k: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        limit = self._limit(documents, top_k)
        if limit == 0:
            return []

        request_documents = [self._document_text_tagged(item) for item in documents[:limit]]
        provider_results = self.provider.rerank(
            query=query,
            documents=request_documents,
            model=self.model,
            top_n=limit,
            max_tokens_per_doc=self.max_tokens_per_doc,
            timeout=self.timeout,
        )
        return self._merge_response(documents[:limit], provider_results, limit)

    def _create_provider(self, *, post_func: Optional[Callable[..., Any]] = None):
        from integrations.model_providers.factory import create_provider_from_config

        config = {
            "name": self.provider_key,
            "provider_type": self.provider_type or "rerank_api",
            "api_key": self.api_key,
            "api_endpoint": self.api_endpoint,
            "model_map": {"rerank": self.model},
        }
        if post_func is not None:
            config["post_func"] = post_func
        return create_provider_from_config(config)

    def _merge_response(
        self,
        documents: List[Dict[str, Any]],
        provider_results: List[Dict[str, Any]],
        limit: int,
    ) -> List[Dict[str, Any]]:
        reranked: List[Dict[str, Any]] = []
        seen_indexes = set()
        for raw_item in provider_results:
            if not isinstance(raw_item, dict):
                continue
            index = raw_item.get("index")
            if index is None or index < 0 or index >= len(documents) or index in seen_indexes:
                continue

            item = dict(documents[index])
            item["rerank_score"] = float(raw_item.get("score") or 0.0)
            item["rerank_mode"] = self.mode
            item["rerank_provider"] = self.provider_key
            item["rerank_model"] = self.model
            reranked.append(item)
            seen_indexes.add(index)

        for index, document in enumerate(documents):
            if index in seen_indexes:
                continue
            item = dict(document)
            item["rerank_score"] = 0.0
            item["rerank_mode"] = self.mode
            item["rerank_provider"] = self.provider_key
            item["rerank_model"] = self.model
            reranked.append(item)

        for rank, item in enumerate(reranked[:limit], start=1):
            item["rerank_rank"] = rank
        return reranked[:limit]

    @classmethod
    def _resolve_config(
        cls,
        *,
        provider: Optional[str],
        model: Optional[str],
        provider_type: Optional[str],
        api_endpoint: Optional[str],
        api_key: Optional[str],
        timeout: Optional[float],
        config_store: Any,
    ) -> Dict[str, Any]:
        env_provider = os.getenv("RERANK_PROVIDER", "")
        env_provider_type = os.getenv("RERANK_PROVIDER_TYPE", "")
        env_model = os.getenv("RERANK_MODEL", "")
        env_api_key = os.getenv("RERANK_API_KEY", "")
        env_api_endpoint = os.getenv("RERANK_API_ENDPOINT", "")

        provider_key = str(provider or env_provider or "").strip()
        resolved_provider_type = str(provider_type or env_provider_type or "").strip().lower()
        resolved_model = str(model or env_model or "").strip()
        resolved_api_key = str(api_key or env_api_key or "").strip()
        resolved_api_endpoint = str(api_endpoint or env_api_endpoint or "").strip()
        resolved_timeout = float(timeout or os.getenv("RERANK_TIMEOUT") or 30)

        if not (resolved_api_key and resolved_api_endpoint and resolved_model):
            config_key, config = cls._resolve_provider_config(provider_key, config_store)
            if config:
                provider_key = config_key
                resolved_provider_type = resolved_provider_type or str(config.get("provider_type") or "").strip().lower()
                resolved_model = resolved_model or cls._model_from_config(config)
                resolved_api_key = resolved_api_key or cls._resolve_env_value(config.get("api_key"), "api_key")
                resolved_api_endpoint = resolved_api_endpoint or str(config.get("api_endpoint") or "").strip()
                resolved_timeout = float(timeout or config.get("timeout") or resolved_timeout)

        missing = []
        if not resolved_api_key:
            missing.append("api_key")
        if not resolved_api_endpoint:
            missing.append("api_endpoint")
        if not resolved_model:
            missing.append("model")
        if missing:
            raise ValueError(f"rerank 模型配置不完整，缺少: {', '.join(missing)}")

        if not provider_key:
            provider_key = str(provider or env_provider or resolved_provider_type or "model").strip()

        resolved_api_endpoint = cls._resolve_api_endpoint(
            api_endpoint=resolved_api_endpoint,
            provider_type=resolved_provider_type,
            provider_key=provider_key,
        )
        resolved_provider_type = cls._normalize_provider_type(resolved_provider_type)

        return {
            "provider_key": provider_key,
            "provider_type": resolved_provider_type,
            "model": resolved_model,
            "api_key": resolved_api_key,
            "api_endpoint": resolved_api_endpoint,
            "timeout": resolved_timeout,
        }

    @classmethod
    def _resolve_provider_config(cls, provider_key: str, config_store: Any) -> tuple[str, Optional[Dict[str, Any]]]:
        try:
            store = config_store
            if store is None:
                from model_adapter.config_store import ModelAdapterConfigStore

                store = ModelAdapterConfigStore()
            configs = store.load_all()
        except Exception as exc:
            logger.debug("加载 rerank Provider 配置失败: %s", exc)
            configs = {}

        if not configs:
            return provider_key, None

        if provider_key:
            direct = configs.get(provider_key)
            if direct:
                return provider_key, direct

            normalized = provider_key.lower().replace(" ", "_")
            matches = [
                (key, config)
                for key, config in configs.items()
                if key == normalized or key.startswith(f"{normalized}_")
            ]
            if len(matches) == 1:
                return matches[0]

        for key, config in configs.items():
            model_map = config.get("model_map") or {}
            if any(task in model_map for task in cls._RERANK_TASK_KEYS):
                return key, config

        return provider_key, None

    @classmethod
    def _model_from_config(cls, config: Dict[str, Any]) -> str:
        model_map = config.get("model_map") or {}
        for task in cls._RERANK_TASK_KEYS:
            model = cls._first_model(model_map.get(task))
            if model:
                return model
        return cls._first_model(config.get("model")) or cls._first_model(config.get("models")) or ""

    @staticmethod
    def _first_model(value: Any) -> str:
        if isinstance(value, list):
            for item in value:
                model = str(item or "").strip()
                if model:
                    return model
            return ""
        return str(value or "").strip()

    @staticmethod
    def _resolve_env_value(value: Any, field_name: str) -> str:
        from integrations.model_providers.factory import resolve_env_placeholder

        resolved = resolve_env_placeholder(value, field_name=field_name)
        return str(resolved or "").strip()

    @classmethod
    def _normalize_provider_type(cls, provider_type: str) -> str:
        normalized = str(provider_type or "").strip().lower()
        if not normalized or normalized in cls._DIRECT_PROVIDER_TYPES:
            return "rerank_api"
        return normalized

    @staticmethod
    def _resolve_api_endpoint(
        *,
        api_endpoint: str,
        provider_type: str,
        provider_key: str,
    ) -> str:
        base = api_endpoint.rstrip("/")
        if provider_type == "rerank_api":
            return base

        lower_base = base.lower()
        marker = " ".join([provider_type or "", provider_key or "", lower_base])

        if lower_base.endswith("/rerank"):
            return base
        if "cohere" in marker:
            if lower_base.endswith("/v2") or lower_base.endswith("/v1"):
                return f"{base}/rerank"
            return f"{base}/v2/rerank"
        return f"{base}/rerank"


def get_reranker(mode: Optional[str] = "none", **kwargs: Any) -> RerankerBase:
    normalized = str(mode or "none").strip().lower()
    if normalized in {"none", "noop", "identity"}:
        return NoopReranker()
    if normalized in {"lexical", "keyword", "local", "bm25"}:
        return LexicalReranker()
    if normalized in {"model", "remote", "provider", "http", "jina", "cohere"}:
        if normalized in {"jina", "cohere"} and not kwargs.get("provider_type"):
            kwargs["provider_type"] = normalized
        return ModelProviderReranker(**kwargs)
    raise ValueError(f"不支持的 rerank_mode: {mode}")


def available_reranker_modes() -> List[str]:
    return ["none", "lexical", "model"]


__all__ = [
    "RerankerBase",
    "NoopReranker",
    "LexicalReranker",
    "ModelProviderReranker",
    "get_reranker",
    "available_reranker_modes",
]
