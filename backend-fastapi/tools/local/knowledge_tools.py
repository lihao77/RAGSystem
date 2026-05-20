# -*- coding: utf-8 -*-
"""Agent-facing knowledge base tools backed by VectorRetriever."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from agents.config import get_config_manager
from tools.contracts.permissions import RiskLevel
from tools.decorators import tool
from tools.runtime.response_builder import error_result, success_result

logger = logging.getLogger(__name__)


def _resolve_kb_config(agent_name: Optional[str]):
    if not agent_name:
        return None
    agent_config = get_config_manager().get_config(agent_name)
    return getattr(agent_config, 'knowledge_base', None) if agent_config else None


def _ensure_knowledge_enabled(tool_name: str, agent_name: Optional[str]) -> Optional[str]:
    kb_config = _resolve_kb_config(agent_name)
    if kb_config is None or not getattr(kb_config, 'enabled', False):
        return f"当前 Agent 未启用 knowledge_base 能力: {agent_name or 'unknown'}"
    return None


def _format_search_results(results: List[Dict[str, Any]]) -> str:
    """将搜索结果格式化为可读文本。"""
    if not results:
        return "未找到相关结果。"
    lines = []
    for i, item in enumerate(results, 1):
        text = item.get('text') or item.get('content') or ''
        metadata = item.get('metadata') or {}
        source = metadata.get('source_file') or metadata.get('source') or ''
        score = item.get('similarity') or item.get('hybrid_score') or item.get('rerank_score') or 0
        header = f"[{i}]"
        if source:
            header += f" {source}"
        if score:
            header += f" (score: {score:.4f})"
        lines.append(header)
        lines.append(text.strip())
        lines.append("")
    return "\n".join(lines)


@tool(
    name="search_knowledge_base",
    description="在知识库中搜索与查询相关的文档分块。支持语义搜索和混合搜索（向量+关键词+RRF融合），可选重排序。",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "搜索查询文本"},
            "collection": {"type": "string", "description": "集合名称，不传则使用 Agent 默认集合"},
            "top_k": {"type": "integer", "description": "返回结果数量，不传则使用默认值"},
            "search_mode": {"type": "string", "enum": ["vector", "hybrid"], "description": "搜索模式，不传则使用默认值"},
            "rerank": {"type": "boolean", "description": "是否启用重排序，不传则使用默认值"},
            "filters": {"type": "object", "description": "元数据过滤条件"},
        },
        "required": ["query"],
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "返回搜索结果列表",
        "shape": {
            "content": "string",
            "metadata": {
                "count": "integer",
                "collection": "string",
                "search_mode": "string",
            },
        },
    },
    usage_contract=[
        "query 是必填参数，其他参数不传时使用 Agent 配置中的默认值",
        "返回的内容为格式化文本，包含文档分块、来源和相关度分数",
    ],
    source="decorator",
)
def search_knowledge_base(
    query: str,
    collection: Optional[str] = None,
    top_k: Optional[int] = None,
    search_mode: Optional[str] = None,
    rerank: Optional[bool] = None,
    filters: Optional[Dict[str, Any]] = None,
    current_agent_name: Optional[str] = None,
) -> Any:
    try:
        error = _ensure_knowledge_enabled('search_knowledge_base', current_agent_name)
        if error:
            return error_result(error, tool_name='search_knowledge_base')

        kb_config = _resolve_kb_config(current_agent_name)
        resolved_collection = collection or getattr(kb_config, 'default_collection', 'documents')
        resolved_top_k = top_k or getattr(kb_config, 'default_top_k', 5)
        resolved_mode = (search_mode or getattr(kb_config, 'default_search_mode', 'hybrid')).strip().lower()
        resolved_rerank = rerank if rerank is not None else getattr(kb_config, 'default_rerank', False)
        reranker_key = getattr(kb_config, 'default_reranker_key', None)

        from vector_store.retriever import VectorRetriever
        retriever = VectorRetriever(collection_name=resolved_collection)

        if resolved_mode == 'vector':
            results = retriever.search(
                query=query,
                top_k=resolved_top_k,
                filters=filters,
                include_distances=True,
            )
        else:
            results = retriever.hybrid_search(
                query=query,
                top_k=resolved_top_k,
                filters=filters,
                rerank=resolved_rerank,
                reranker_key=reranker_key if resolved_rerank else None,
            )

        formatted = _format_search_results(results)
        return success_result(
            content=formatted,
            summary=f"在 {resolved_collection} 中搜索到 {len(results)} 条结果",
            output_type="text",
            metadata={
                "count": len(results),
                "collection": resolved_collection,
                "search_mode": resolved_mode,
            },
            tool_name="search_knowledge_base",
        )
    except Exception as e:
        return error_result(f"知识库搜索失败: {e}", tool_name="search_knowledge_base")


@tool(
    name="list_knowledge_collections",
    description="列出可用的知识库集合及其基本信息，帮助了解系统中有哪些集合可供搜索。",
    parameters={
        "type": "object",
        "properties": {},
    },
    risk_level=RiskLevel.LOW,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "返回集合列表",
        "shape": {
            "content": "string",
            "metadata": {"count": "integer"},
        },
    },
    usage_contract=[
        "用于了解系统中有哪些知识库集合可供搜索",
    ],
    source="decorator",
)
def list_knowledge_collections(
    current_agent_name: Optional[str] = None,
) -> Any:
    try:
        error = _ensure_knowledge_enabled('list_knowledge_collections', current_agent_name)
        if error:
            return error_result(error, tool_name='list_knowledge_collections')

        from services.vector_management_service import VectorManagementService
        service = VectorManagementService()
        collections = service.list_collections()

        if not collections:
            return success_result(
                content="当前没有可用的知识库集合。",
                summary="无可用集合",
                output_type="text",
                metadata={"count": 0},
                tool_name="list_knowledge_collections",
            )

        lines = []
        for col in collections:
            name = col.get('name', '')
            doc_count = col.get('document_count', col.get('metadata', {}).get('document_count', 0))
            chunk_count = col.get('chunk_count', col.get('total_chunks', 0))
            lines.append(f"- {name}: {doc_count} 文档, {chunk_count} 分块")

        return success_result(
            content="\n".join(lines),
            summary=f"共 {len(collections)} 个集合",
            output_type="text",
            metadata={"count": len(collections)},
            tool_name="list_knowledge_collections",
        )
    except Exception as e:
        return error_result(f"列出集合失败: {e}", tool_name="list_knowledge_collections")
