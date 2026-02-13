# -*- coding: utf-8 -*-
"""
向量存储相关异常定义
"""


class EmbeddingBatchError(Exception):
    """
    Embedding 批次调用失败异常

    当某批文本向量化失败时抛出，包含批次定位信息便于排查。
    """

    def __init__(
        self,
        message: str,
        batch_index: int,
        chunk_indices: list,
        total_chunks: int,
        batch_size: int,
        error_detail: str = None,
        batch_preview: str = None
    ):
        """
        Args:
            message: 主错误信息
            batch_index: 失败批次索引（从 0 开始）
            chunk_indices: 该批次对应的全局分块索引列表
            total_chunks: 总分块数
            batch_size: 批次大小
            error_detail: API 返回的详细错误（如 400 响应体）
            batch_preview: 该批次文本预览（用于排查特殊字符）
        """
        self.batch_index = batch_index
        self.chunk_indices = chunk_indices
        self.total_chunks = total_chunks
        self.batch_size = batch_size
        self.error_detail = error_detail
        self.batch_preview = batch_preview

        # 构建友好描述
        desc_parts = [
            f"第 {batch_index + 1} 批（共 {(total_chunks + batch_size - 1) // batch_size} 批）",
            f"分块索引: {chunk_indices[0]}~{chunk_indices[-1]}（共 {len(chunk_indices)} 个）",
        ]
        if error_detail:
            desc_parts.append(f"API 错误: {error_detail}")
        full_msg = f"{message}\n" + " | ".join(desc_parts)
        super().__init__(full_msg)

    def to_dict(self) -> dict:
        """转为字典，便于 API 返回"""
        indices_range = ""
        if self.chunk_indices:
            indices_range = f"{self.chunk_indices[0]}~{self.chunk_indices[-1]}"
        preview = self.batch_preview
        if preview and len(preview) > 500:
            preview = preview[:500] + "..."
        return {
            "batch_index": self.batch_index,
            "chunk_indices": self.chunk_indices,
            "chunk_indices_range": indices_range,
            "total_chunks": self.total_chunks,
            "batch_size": self.batch_size,
            "batch_count": len(self.chunk_indices),
            "error_detail": self.error_detail,
            "batch_preview": preview,
        }
