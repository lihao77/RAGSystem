"""
文档索引构建器 - 负责文档分块和向量化索引
"""

import logging
import hashlib
import re
from typing import List, Dict, Optional, Any
from datetime import datetime

from .client import get_vector_client
from .embedder import get_embedder
from .base import Document

logger = logging.getLogger(__name__)

try:
    import jieba
except ImportError:  # pragma: no cover - optional dependency fallback
    jieba = None


class DocumentIndexer:
    """文档索引构建器"""

    _MARKDOWN_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")

    def __init__(self, collection_name: str = "documents"):
        """
        初始化索引器

        Args:
            collection_name: 集合名称
        """
        self.collection_name = collection_name
        self.vector_client = get_vector_client()
        self.embedder = get_embedder()

        # 确保客户端已初始化
        self.vector_client.ensure_initialized()
        self.embedder.ensure_initialized()

    @staticmethod
    def chunk_text(
        text: str,
        chunk_size: int = 500,
        overlap: int = 50,
        use_jieba: bool = True
    ) -> List[str]:
        """
        文本分块

        Args:
            text: 原始文本
            chunk_size: 分块大小（字符数）
            overlap: 重叠大小（字符数）
            use_jieba: 是否使用jieba优化分块边界

        Returns:
            分块文本列表
        """
        return [
            chunk['text']
            for chunk in DocumentIndexer._chunk_text_with_offsets(
                text,
                chunk_size=chunk_size,
                overlap=overlap,
                use_jieba=use_jieba,
            )
        ]

    @staticmethod
    def _normalize_chunk_params(chunk_size: int = 500, overlap: int = 50) -> tuple[int, int]:
        chunk_size = max(1, int(chunk_size or 500))
        overlap = max(0, min(int(overlap or 0), chunk_size - 1))
        return chunk_size, overlap

    @staticmethod
    def _tail_token_spans(parts: List[tuple[str, int, int]], overlap: int) -> List[tuple[str, int, int]]:
        if overlap <= 0:
            return []

        remaining = overlap
        tail: List[tuple[str, int, int]] = []
        for token, start, end in reversed(parts):
            if remaining <= 0:
                break
            token_len = end - start
            if token_len <= remaining:
                tail.append((token, start, end))
                remaining -= token_len
            else:
                tail_start = end - remaining
                tail.append((token[-remaining:], tail_start, end))
                remaining = 0

        tail.reverse()
        return tail

    @staticmethod
    def _chunk_text_with_offsets(
        text: str,
        chunk_size: int = 500,
        overlap: int = 50,
        use_jieba: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        文本分块并返回每个分块在原始 text 中的相对字符区间。

        返回区间为半开区间 [start, end)，且 text[start:end] 等于 chunk 文本。
        """
        if not text or not text.strip():
            return []

        chunk_size, overlap = DocumentIndexer._normalize_chunk_params(chunk_size, overlap)
        leading_trim = len(text) - len(text.lstrip())
        working_text = text.strip()
        chunks: List[Dict[str, Any]] = []

        if use_jieba and jieba is not None:
            # 使用jieba分句，避免在词中间切分
            sentences = list(jieba.cut(working_text, cut_all=False))

            current_chunk: List[tuple[str, int, int]] = []
            current_length = 0
            search_start = 0

            for sentence in sentences:
                sentence_start = working_text.find(sentence, search_start)
                if sentence_start < 0:
                    sentence_start = search_start
                sentence_end = sentence_start + len(sentence)
                search_start = sentence_end
                sentence_length = len(sentence)

                if current_length + sentence_length > chunk_size and current_chunk:
                    # 达到分块大小，保存当前分块
                    chunk_text = ''.join(part[0] for part in current_chunk)
                    chunks.append({
                        'text': chunk_text,
                        'start': leading_trim + current_chunk[0][1],
                        'end': leading_trim + current_chunk[-1][2],
                    })

                    # 保留重叠部分
                    current_chunk = DocumentIndexer._tail_token_spans(current_chunk, overlap)
                    current_chunk.append((sentence, sentence_start, sentence_end))
                    current_length = sum(end - start for _, start, end in current_chunk)
                else:
                    current_chunk.append((sentence, sentence_start, sentence_end))
                    current_length += sentence_length

            # 添加最后一个分块
            if current_chunk:
                chunk_text = ''.join(part[0] for part in current_chunk)
                chunks.append({
                    'text': chunk_text,
                    'start': leading_trim + current_chunk[0][1],
                    'end': leading_trim + current_chunk[-1][2],
                })
        else:
            # 简单按字符数切分
            start = 0
            while start < len(working_text):
                end = start + chunk_size
                chunks.append({
                    'text': working_text[start:end],
                    'start': leading_trim + start,
                    'end': leading_trim + min(end, len(working_text)),
                })
                start += chunk_size - overlap

        return chunks

    @classmethod
    def chunk_document(
        cls,
        text: str,
        chunk_size: int = 500,
        overlap: int = 50,
        use_jieba: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        将文档切成带结构化元数据的分块。

        当前优先识别 Markdown 标题层级；没有标题时退化为普通文本切块。
        返回项格式:
        {
            "text": "...",
            "metadata": {
                "section_title": "...",
                "section_path": "...",
                "start_char": 0,
                "end_char": 123,
                ...
            }
        }
        """
        if not text or not text.strip():
            return []

        segments = cls._split_structured_segments(text)
        has_sections = any(segment.get('section_path_list') for segment in segments)
        strategy = 'markdown_sections' if has_sections else 'plain_text'

        chunks: List[Dict[str, Any]] = []
        for section_index, segment in enumerate(segments):
            segment_text = segment['text']
            segment_chunks = cls._chunk_text_with_offsets(
                segment_text,
                chunk_size=chunk_size,
                overlap=overlap,
                use_jieba=use_jieba,
            )

            for section_chunk_index, chunk in enumerate(segment_chunks):
                section_path_list = list(segment.get('section_path_list') or [])
                section_path = ' > '.join(section_path_list)
                chunks.append({
                    'text': chunk['text'],
                    'metadata': {
                        'chunking_strategy': strategy,
                        'section_index': section_index,
                        'section_chunk_index': section_chunk_index,
                        'section_title': segment.get('section_title') or '',
                        'section_path': section_path,
                        'section_path_list': section_path_list,
                        'section_level': segment.get('section_level') or 0,
                        'start_char': segment['start_char'] + chunk['start'],
                        'end_char': segment['start_char'] + chunk['end'],
                    },
                })

        return chunks

    @classmethod
    def _split_structured_segments(cls, text: str) -> List[Dict[str, Any]]:
        """按 Markdown 标题拆分文档；没有标题时返回整个文本段。"""
        lines = text.splitlines(keepends=True)
        heading_stack: List[str] = []
        current_lines: List[str] = []
        current_start = 0
        current_meta: Dict[str, Any] = {
            'section_title': '',
            'section_path_list': [],
            'section_level': 0,
        }
        offset = 0
        segments: List[Dict[str, Any]] = []
        saw_heading = False

        def flush(end_offset: int) -> None:
            nonlocal current_lines
            content = ''.join(current_lines).strip()
            if not content:
                current_lines = []
                return
            segments.append({
                'text': ''.join(current_lines),
                'start_char': current_start,
                'end_char': end_offset,
                **current_meta,
            })
            current_lines = []

        for line in lines:
            stripped = line.strip()
            match = cls._MARKDOWN_HEADING_RE.match(stripped)
            if match:
                flush(offset)
                saw_heading = True
                level = len(match.group(1))
                title = match.group(2).strip().strip('#').strip()
                heading_stack = heading_stack[:level - 1]
                heading_stack.append(title)
                current_meta = {
                    'section_title': title,
                    'section_path_list': list(heading_stack),
                    'section_level': level,
                }
                current_start = offset
                current_lines = [line]
            else:
                if not current_lines:
                    current_start = offset
                current_lines.append(line)
            offset += len(line)

        flush(offset)

        if not saw_heading:
            return [{
                'text': text,
                'start_char': 0,
                'end_char': len(text),
                'section_title': '',
                'section_path_list': [],
                'section_level': 0,
            }]

        return segments

    @staticmethod
    def _generate_chunk_id(document_id: str, index: int) -> str:
        """生成分块唯一ID"""
        hash_obj = hashlib.md5(document_id.encode('utf-8'))
        return f"{hash_obj.hexdigest()}_{index}"

    def index_document(
        self,
        document_id: str,
        text: str,
        metadata: Optional[Dict[str, Any]] = None,
        chunk_size: int = 500,
        overlap: int = 50
    ) -> int:
        """
        索引单个文档

        Args:
            document_id: 文档唯一标识
            text: 文档文本
            metadata: 文档元数据
            chunk_size: 分块大小
            overlap: 重叠大小

        Returns:
            索引的分块数量
        """
        try:
            # 文本分块
            chunk_entries = self.chunk_document(text, chunk_size, overlap)
            chunks = [entry['text'] for entry in chunk_entries]
            if not chunks:
                logger.warning(f"文档 {document_id} 分块为空")
                return 0

            logger.info(f"文档 {document_id} 分为 {len(chunks)} 个分块")

            # 生成向量
            embeddings = self.embedder.embed(chunks)

            # 准备元数据
            base_metadata = dict(metadata or {})
            base_metadata['document_id'] = document_id
            base_metadata['indexed_at'] = datetime.now().isoformat()
            base_metadata['content_hash'] = hashlib.sha256(text.encode('utf-8')).hexdigest()

            # 构建 Document 对象
            documents = []
            for i, chunk in enumerate(chunks):
                chunk_metadata = base_metadata.copy()
                chunk_metadata.update(chunk_entries[i].get('metadata') or {})
                chunk_metadata.update({
                    'chunk_index': i,
                    'chunk_total': len(chunks),
                    'chunk_text_length': len(chunk),
                    'chunk_hash': hashlib.sha256(chunk.encode('utf-8')).hexdigest(),
                })

                doc = Document(
                    id=self._generate_chunk_id(document_id, i),
                    content=chunk,
                    metadata=chunk_metadata,
                    embedding=embeddings[i]
                )
                documents.append(doc)

            # 插入向量数据库
            self.vector_client.add_documents(
                documents=documents,
                collection=self.collection_name
            )

            logger.info(f"文档 {document_id} 索引完成，共 {len(chunks)} 个分块")
            return len(chunks)

        except Exception as e:
            logger.error(f"文档索引失败: {e}")
            raise

    def index_documents(
        self,
        documents: List[Dict[str, Any]],
        chunk_size: int = 500,
        overlap: int = 50
    ) -> Dict[str, int]:
        """
        批量索引文档

        Args:
            documents: 文档列表，每个文档包含 'id', 'text', 'metadata'
            chunk_size: 分块大小
            overlap: 重叠大小

        Returns:
            文档ID到分块数的映射
        """
        results = {}

        for doc in documents:
            doc_id = doc.get('id')
            text = doc.get('text')
            metadata = doc.get('metadata', {})

            if not doc_id or not text:
                logger.warning(f"跳过无效文档: {doc}")
                continue

            try:
                chunk_count = self.index_document(
                    document_id=doc_id,
                    text=text,
                    metadata=metadata,
                    chunk_size=chunk_size,
                    overlap=overlap
                )
                results[doc_id] = chunk_count

            except Exception as e:
                logger.error(f"文档 {doc_id} 索引失败: {e}")
                results[doc_id] = 0

        total_chunks = sum(results.values())
        logger.info(f"批量索引完成，总分块数: {total_chunks}")

        return results

    def delete_document(self, document_id: str):
        """删除文档的所有分块"""
        try:
            # 生成所有可能的分块 ID（假设最多 1000 个分块）
            # 注意：这是一个简化实现，实际可能需要先查询后删除
            chunk_ids = [self._generate_chunk_id(document_id, i) for i in range(1000)]

            # 删除文档
            deleted_count = self.vector_client.delete_documents(
                doc_ids=chunk_ids,
                collection=self.collection_name
            )

            logger.info(f"删除文档 {document_id}，共 {deleted_count} 个分块")

        except Exception as e:
            logger.error(f"删除文档失败: {e}")
            raise

    def get_collection_stats(self) -> Dict[str, Any]:
        """获取集合统计信息"""
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
            logger.error(f"获取统计信息失败: {e}")
            return {}
