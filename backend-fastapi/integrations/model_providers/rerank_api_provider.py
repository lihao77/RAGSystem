# -*- coding: utf-8 -*-
"""Generic HTTP rerank API Provider."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from model_adapter.base import AIProvider, AIProviderType, EmbeddingResponse, ModelResponse


class RerankAPIProvider(AIProvider):
    """Provider type for dedicated rerank APIs.

    The retrieval pipeline calls the rerank endpoint through
    vector_store.reranker.ModelProviderReranker. This class exists so rerank
    services can be configured, saved, listed, and resolved like other
    Providers without pretending to be chat or embedding services.
    """

    def __init__(
        self,
        api_key: str,
        model: str = "",
        name: str = "RerankAPI",
        api_endpoint: str = "",
        **kwargs: Any,
    ):
        self._post = kwargs.pop("post_func", None)
        super().__init__(
            name=name,
            api_key=api_key,
            api_endpoint=api_endpoint,
            model=model,
            **kwargs,
        )
        if self.model and "rerank" not in self.model_map:
            self.model_map["rerank"] = self.model
        self.model_map.pop("chat", None)
        self.models = self._flatten_models(self.model_map, None)
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def rerank(
        self,
        *,
        query: str,
        documents: List[str],
        model: Optional[str] = None,
        top_n: Optional[int] = None,
        max_tokens_per_doc: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        model_name = model or self.get_model_for_task("rerank")
        payload: Dict[str, Any] = {
            "model": model_name,
            "query": query,
            "documents": documents,
            "top_n": top_n if top_n is not None else len(documents),
        }
        if max_tokens_per_doc is not None:
            payload["max_tokens_per_doc"] = int(max_tokens_per_doc)

        response_data = self._post_json(payload, timeout=timeout)
        return self._normalize_rerank_response(response_data)

    def _post_json(self, payload: Dict[str, Any], *, timeout: Optional[float]) -> Dict[str, Any]:
        post = self._post
        if post is None:
            import requests

            post = requests.post

        response = post(
            self.api_endpoint,
            headers=self.headers,
            json=payload,
            timeout=timeout or self.timeout,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("rerank API 响应不是 JSON 对象")
        return data

    @classmethod
    def _normalize_rerank_response(cls, response_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        raw_results = response_data.get("results") or response_data.get("data") or []
        if not isinstance(raw_results, list):
            raise ValueError("rerank API 响应缺少 results 列表")

        normalized = []
        for raw_item in raw_results:
            if not isinstance(raw_item, dict):
                continue
            index = cls._parse_result_index(raw_item)
            if index is None:
                continue
            normalized.append(
                {
                    "index": index,
                    "score": cls._parse_result_score(raw_item),
                    "raw": raw_item,
                }
            )
        return normalized

    @staticmethod
    def _parse_result_index(raw_item: Dict[str, Any]) -> Optional[int]:
        candidates = [
            raw_item.get("index"),
            raw_item.get("document_index"),
            (raw_item.get("document") or {}).get("index") if isinstance(raw_item.get("document"), dict) else None,
        ]
        for candidate in candidates:
            try:
                if candidate is not None:
                    return int(candidate)
            except (TypeError, ValueError):
                continue
        return None

    @staticmethod
    def _parse_result_score(raw_item: Dict[str, Any]) -> float:
        for key in ("relevance_score", "score", "rerank_score"):
            try:
                value = raw_item.get(key)
                if value is not None:
                    return float(value)
            except (TypeError, ValueError):
                continue
        return 0.0

    def _do_chat_completion(
        self,
        messages: List[Dict[str, Any]],
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Any] = None,
        **kwargs: Any,
    ) -> ModelResponse:
        del messages, temperature, max_tokens, tools, tool_choice, kwargs
        return ModelResponse(
            error="rerank_api Provider 仅支持搜索重排序，不支持 chat_completion",
            model=model or self.get_model_for_task("rerank"),
            provider=self.name,
        )

    def generate_text(
        self,
        prompt: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs: Any,
    ) -> ModelResponse:
        del prompt, temperature, max_tokens, kwargs
        return ModelResponse(
            error="rerank_api Provider 仅支持搜索重排序，不支持 generate_text",
            model=model or self.get_model_for_task("rerank"),
            provider=self.name,
        )

    def embed(
        self,
        texts: List[str],
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        **kwargs: Any,
    ) -> EmbeddingResponse:
        del texts, dimensions, kwargs
        return EmbeddingResponse(
            embeddings=[],
            error="rerank_api Provider 仅支持搜索重排序，不支持 embedding",
            model=model or self.get_model_for_task("rerank"),
            provider=self.name,
        )

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.RERANK_API

    def get_model_list(self) -> List[str]:
        models = self.model_map.get("rerank") or self.models or self.model
        return self._normalize_model_list(models)

    def get_model_for_task(self, task: str) -> Optional[str]:
        if task == "rerank":
            val = self.model_map.get("rerank") or self.model
            if isinstance(val, list):
                models = self._normalize_model_list(val)
                return models[0] if models else self.model
            return str(val).strip() if str(val).strip() else self.model
        return None

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        del input_tokens, output_tokens, model
        return 0.0

    def is_available(self) -> bool:
        return bool(self.api_key and self.api_endpoint)
