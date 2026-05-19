"""
向量检索器 - 提供语义搜索功能
"""

import logging
import math
import re
from collections import Counter
from typing import List, Dict, Optional, Any

from .client import get_vector_client
from .embedder import get_embedder
from .reranker import get_reranker

logger = logging.getLogger(__name__)

try:
    import jieba
except ImportError:  # pragma: no cover - optional dependency fallback
    jieba = None


class VectorRetriever:
    """向量检索器"""

    _TOKEN_RE = re.compile(r"[\w]+", re.UNICODE)

    def __init__(self, collection_name: str = "documents"):
        """
        初始化检索器

        Args:
            collection_name: 集合名称
        """
        self.collection_name = collection_name
        self.vector_client = get_vector_client()
        self.embedder = get_embedder()

        # 确保客户端已初始化
        self.vector_client.ensure_initialized()
        self.embedder.ensure_initialized()

    def search(
        self,
        query: str,
        top_k: int = 5,
        filters: Optional[Dict[str, Any]] = None,
        include_distances: bool = True
    ) -> List[Dict[str, Any]]:
        """
        语义搜索

        Args:
            query: 查询文本
            top_k: 返回结果数量
            filters: 元数据过滤条件 (例如: {"category": "技术", "year": 2024})
            include_distances: 是否包含距离分数

        Returns:
            搜索结果列表，每个结果包含:
            - id: 分块ID
            - text: 分块文本
            - metadata: 元数据
            - distance: 距离值（可选）
            - similarity: 相似度分数 (0-1，越大越相似，可选)
        """
        try:
            # 查询向量化（传入列表以保证返回 list[list[float]]，再取第一个向量）
            query_embedding = self.embedder.embed([query])[0]

            # 执行向量检索
            results = self.vector_client.search(
                query_embedding=query_embedding,
                top_k=top_k,
                collection=self.collection_name,
                filters=filters
            )

            # 格式化结果
            formatted_results = []

            for result in results:
                formatted_result = {
                    'id': result.id,
                    'text': result.content,
                    'metadata': result.metadata
                }

                if include_distances:
                    formatted_result['distance'] = result.distance
                    formatted_result['similarity'] = result.score

                formatted_results.append(formatted_result)

            logger.info(f"检索完成，查询: '{query[:50]}...'，返回 {len(formatted_results)} 条结果")
            return formatted_results

        except Exception as e:
            logger.error(f"向量检索失败: {e}")
            raise

    def search_by_document(
        self,
        document_id: str,
        query: str,
        top_k: int = 5,
        include_distances: bool = True
    ) -> List[Dict[str, Any]]:
        """
        在特定文档内搜索

        Args:
            document_id: 文档ID
            query: 查询文本
            top_k: 返回结果数量
            include_distances: 是否包含距离分数

        Returns:
            搜索结果列表
        """
        return self.search(
            query=query,
            top_k=top_k,
            filters={"document_id": document_id},
            include_distances=include_distances
        )

    def get_similar_chunks(
        self,
        chunk_id: str,
        top_k: int = 5
    ) -> List[Dict[str, Any]]:
        """
        获取与指定分块相似的其他分块

        Args:
            chunk_id: 分块ID
            top_k: 返回结果数量

        Returns:
            相似分块列表
        """
        try:
            # 获取目标分块
            chunk = self.vector_client.get_document(
                doc_id=chunk_id,
                collection=self.collection_name
            )

            if not chunk or chunk.embedding is None:
                logger.warning(f"未找到分块: {chunk_id}")
                return []

            # 使用分块的 embedding 进行搜索
            results = self.vector_client.search(
                query_embedding=chunk.embedding,
                top_k=top_k + 1,  # +1 因为会包含自己
                collection=self.collection_name
            )

            # 格式化结果（排除自己）
            formatted_results = []

            for result in results:
                if result.id == chunk_id:
                    continue  # 跳过自己

                formatted_result = {
                    'id': result.id,
                    'text': result.content,
                    'metadata': result.metadata,
                    'distance': result.distance,
                    'similarity': result.score
                }
                formatted_results.append(formatted_result)

                if len(formatted_results) >= top_k:
                    break

            return formatted_results

        except Exception as e:
            logger.error(f"获取相似分块失败: {e}")
            raise

    def hybrid_search(
        self,
        query: str,
        keyword: Optional[str] = None,
        top_k: int = 5,
        filters: Optional[Dict[str, Any]] = None,
        vector_top_k: Optional[int] = None,
        keyword_top_k: Optional[int] = None,
        keyword_candidate_limit: int = 2000,
        rrf_k: int = 60,
        rerank: bool = False,
        rerank_mode: str = 'none',
        rerank_top_k: Optional[int] = None,
        final_top_k: Optional[int] = None,
        rerank_provider: Optional[str] = None,
        rerank_model: Optional[str] = None,
        rerank_provider_type: Optional[str] = None,
        rerank_api_endpoint: Optional[str] = None,
        rerank_api_key: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        混合搜索（向量搜索 + 本地 BM25 关键词检索 + RRF 融合）

        Args:
            query: 查询文本
            keyword: 关键词（用于关键词检索；不传时使用 query）
            top_k: 返回结果数量
            filters: 元数据过滤条件
            vector_top_k: 向量召回数量，默认 top_k * 5
            keyword_top_k: 关键词召回数量，默认 top_k * 5
            keyword_candidate_limit: 关键词召回最多扫描的分块数
            rrf_k: Reciprocal Rank Fusion 平滑参数
            rerank: 是否对融合后的候选进行重排序
            rerank_mode: 重排序模式，支持 none / lexical
            rerank_top_k: 进入重排序阶段的候选数量，默认 final_top_k * 3
            final_top_k: 最终返回数量，默认 top_k
            rerank_provider: 模型重排序 Provider key
            rerank_model: 模型重排序模型名
            rerank_provider_type: 模型重排序 Provider 类型
            rerank_api_endpoint: 模型重排序 API endpoint
            rerank_api_key: 模型重排序 API key

        Returns:
            搜索结果列表
        """
        if not query or not query.strip():
            return []

        top_k = max(1, int(top_k or 5))
        final_limit = max(1, int(final_top_k or top_k))
        vector_limit = max(final_limit, int(vector_top_k or final_limit * 5))
        keyword_limit = max(final_limit, int(keyword_top_k or final_limit * 5))
        rrf_k = max(1, int(rrf_k or 60))

        # 1. 语义向量召回
        vector_results = self.search(
            query=query,
            top_k=vector_limit,
            filters=filters,
            include_distances=True
        )

        # 2. 从当前 collection 的分块里做 BM25 关键词召回。当前是受限扫描，
        # 后续可由具体 store 实现替换为全文索引。
        keyword_query = keyword or query
        keyword_candidates = self._load_keyword_candidates(
            filters=filters,
            limit=max(keyword_limit, keyword_candidate_limit),
        )
        if not keyword_candidates:
            keyword_candidates = vector_results
        keyword_results = self._bm25_rank(
            query=keyword_query,
            documents=keyword_candidates,
            top_k=keyword_limit,
        )

        # 3. RRF 融合两个排序列表
        fused = self._rrf_fuse(
            ranked_sources=[('vector', vector_results), ('keyword', keyword_results)],
            rrf_k=rrf_k,
        )

        if not rerank:
            return fused[:final_limit]

        rerank_limit = min(
            len(fused),
            max(final_limit, int(rerank_top_k or final_limit * 3)),
        )
        reranker = get_reranker(
            rerank_mode,
            provider=rerank_provider,
            model=rerank_model,
            provider_type=rerank_provider_type,
            api_endpoint=rerank_api_endpoint,
            api_key=rerank_api_key,
        )
        reranked = reranker.rerank(
            query=query,
            documents=fused[:rerank_limit],
            top_k=rerank_limit,
        )
        return (reranked + fused[rerank_limit:])[:final_limit]

    def _load_keyword_candidates(
        self,
        *,
        filters: Optional[Dict[str, Any]] = None,
        limit: int = 2000,
    ) -> List[Dict[str, Any]]:
        """通过 vector client 读取 BM25 候选分块。"""
        try:
            limit = max(1, int(limit or 2000))
            safe_filters = None
            if filters:
                safe_filters = {}
                for key, value in filters.items():
                    if not self._is_safe_metadata_key(key):
                        logger.warning("跳过不安全的元数据过滤键: %s", key)
                        continue
                    safe_filters[key] = value

            documents = self.vector_client.list_documents(
                collection=self.collection_name,
                filters=safe_filters,
                limit=limit,
            )
            candidates = [
                {
                    'id': doc.id,
                    'text': doc.content,
                    'metadata': doc.metadata,
                }
                for doc in documents
            ]
            logger.debug(
                "BM25 候选加载完成: collection=%s count=%s limit=%s",
                self.collection_name,
                len(candidates),
                limit,
            )
            return candidates
        except Exception as exc:
            logger.debug("加载关键词检索候选失败: %s", exc)
            return []

    @staticmethod
    def _is_safe_metadata_key(key: str) -> bool:
        return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", str(key or "")))

    @classmethod
    def _tokenize(cls, text: str) -> List[str]:
        """中英文混合的轻量分词，用于本地 BM25。"""
        if not text:
            return []

        tokens: List[str] = []
        if jieba is not None:
            try:
                tokens.extend(token.strip().lower() for token in jieba.cut(text) if token.strip())
            except Exception:
                tokens = []

        if not tokens:
            tokens.extend(match.group(0).lower() for match in cls._TOKEN_RE.finditer(text))

        # 对连续中文文本，jieba 不可用时补充单字召回，避免完全没有词项。
        if jieba is None:
            tokens.extend(char for char in text.lower() if '\u4e00' <= char <= '\u9fff')

        return tokens

    @classmethod
    def _bm25_rank(
        cls,
        query: str,
        documents: List[Dict[str, Any]],
        top_k: int,
        *,
        k1: float = 1.5,
        b: float = 0.75,
    ) -> List[Dict[str, Any]]:
        query_terms = cls._tokenize(query)
        if not query_terms or not documents:
            return []

        doc_tokens = [cls._tokenize(doc.get('text', '')) for doc in documents]
        lengths = [len(tokens) for tokens in doc_tokens]
        avgdl = sum(lengths) / len(lengths) if lengths else 0.0
        if avgdl <= 0:
            return []

        document_frequency: Counter[str] = Counter()
        for tokens in doc_tokens:
            document_frequency.update(set(tokens))

        total_docs = len(documents)
        query_counter = Counter(query_terms)
        scored: List[tuple[float, Dict[str, Any]]] = []

        for doc, tokens, doc_len in zip(documents, doc_tokens, lengths):
            if not tokens:
                continue
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

            if score > 0:
                item = dict(doc)
                item['keyword_score'] = score
                scored.append((score, item))

        scored.sort(key=lambda item: item[0], reverse=True)
        return [doc for _, doc in scored[:top_k]]

    @staticmethod
    def _rrf_fuse(
        ranked_sources: List[tuple[str, List[Dict[str, Any]]]],
        *,
        rrf_k: int = 60,
    ) -> List[Dict[str, Any]]:
        fused: Dict[str, Dict[str, Any]] = {}

        for source_name, ranked_list in ranked_sources:
            for rank, item in enumerate(ranked_list, start=1):
                doc_id = item.get('id')
                if not doc_id:
                    continue
                entry = fused.setdefault(doc_id, dict(item))
                entry.setdefault('retrieval_sources', [])
                if source_name not in entry['retrieval_sources']:
                    entry['retrieval_sources'].append(source_name)
                entry[f'{source_name}_rank'] = rank
                if source_name == 'keyword' and 'keyword_score' in item:
                    entry['keyword_score'] = item['keyword_score']
                entry['hybrid_score'] = entry.get('hybrid_score', 0.0) + 1.0 / (rrf_k + rank)

        return sorted(
            fused.values(),
            key=lambda item: (
                item.get('hybrid_score', 0.0),
                item.get('similarity', 0.0),
                item.get('keyword_score', 0.0),
            ),
            reverse=True,
        )


    def get_collection_info(self) -> Dict[str, Any]:
        """获取集合信息"""
        try:
            info = self.vector_client.get_collection_info(self.collection_name)

            return {
                "collection_name": self.collection_name,
                "total_chunks": info.get("document_count", 0),
                "vector_dimension": info.get("vector_dimension", 0),
                "distance_metric": info.get("distance_metric", ""),
                "embedding_dimension": self.embedder.embedding_dim
            }
        except Exception as e:
            logger.error(f"获取集合信息失败: {e}")
            return {}
