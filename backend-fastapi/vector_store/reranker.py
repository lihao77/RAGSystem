# -*- coding: utf-8 -*-
"""Retrieval rerankers used after vector/BM25 recall fusion."""

from __future__ import annotations

import logging
import math
import re
from abc import ABC, abstractmethod
from collections import Counter
from typing import Any, Dict, List, Optional

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
    def _document_text(document: Dict[str, Any]) -> str:
        metadata = document.get("metadata") or {}
        section_path = metadata.get("section_path") or metadata.get("section_title") or ""
        return "\n".join(
            part
            for part in [
                str(document.get("text") or document.get("content") or ""),
                str(section_path),
            ]
            if part
        )

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


def get_reranker(mode: Optional[str] = "none") -> RerankerBase:
    normalized = str(mode or "none").strip().lower()
    if normalized in {"none", "noop", "identity"}:
        return NoopReranker()
    if normalized in {"lexical", "keyword", "local", "bm25"}:
        return LexicalReranker()
    raise ValueError(f"不支持的 rerank_mode: {mode}")


def available_reranker_modes() -> List[str]:
    return ["none", "lexical"]


__all__ = [
    "RerankerBase",
    "NoopReranker",
    "LexicalReranker",
    "get_reranker",
    "available_reranker_modes",
]
