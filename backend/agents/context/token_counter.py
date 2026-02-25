# -*- coding: utf-8 -*-
"""
TokenCounter - 基于 tiktoken 的精确 token 计数器

优先使用 tiktoken 精确计数，失败时自动降级到启发式估算。
"""

import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

# 模型名前缀 → encoding 映射（主流模型均映射到 cl100k_base）
_MODEL_ENCODING_MAP = {
    "gpt-4": "cl100k_base",
    "gpt-3.5": "cl100k_base",
    "deepseek": "cl100k_base",
    "claude": "cl100k_base",
    "qwen": "cl100k_base",
    "glm": "cl100k_base",
    "mistral": "cl100k_base",
    "llama": "cl100k_base",
}
_DEFAULT_ENCODING = "cl100k_base"


class TokenCounter:
    """
    Token 计数器

    优先使用 tiktoken 精确计数，tiktoken 不可用时自动降级到启发式估算。
    """

    def __init__(self, model_name: Optional[str] = None):
        self._model_name = model_name
        self._encoding = None       # 懒加载
        self._use_tiktoken = True   # 失败后置 False，不再重试

    def _get_encoding(self):
        """懒加载 tiktoken encoding，失败时标记不再重试"""
        if not self._use_tiktoken:
            return None
        if self._encoding is not None:
            return self._encoding

        try:
            import tiktoken

            encoding_name = _DEFAULT_ENCODING
            if self._model_name:
                model_lower = self._model_name.lower()
                for prefix, enc in _MODEL_ENCODING_MAP.items():
                    if model_lower.startswith(prefix):
                        encoding_name = enc
                        break

            self._encoding = tiktoken.get_encoding(encoding_name)
            logger.info(f"TokenCounter: 使用 tiktoken encoding={encoding_name} (model={self._model_name or 'default'})")
            return self._encoding

        except Exception as e:
            logger.warning(f"TokenCounter: tiktoken 不可用，降级到启发式估算: {e}")
            self._use_tiktoken = False
            return None

    def count_messages(self, messages: List[Dict[str, Any]]) -> int:
        """
        计算消息列表的 token 数。

        与 OpenAI cookbook 计算方式一致：
        - 每条消息 +4 overhead（role + 格式符）
        - 最后 +2 reply priming
        """
        enc = self._get_encoding()

        if enc is not None:
            try:
                total = 2  # reply priming
                for msg in messages:
                    total += 4  # per-message overhead
                    content = msg.get('content', '')
                    if content:
                        total += len(enc.encode(str(content)))
                    role = msg.get('role', '')
                    if role:
                        total += len(enc.encode(role))
                return total
            except Exception as e:
                logger.warning(f"TokenCounter: tiktoken 计数失败，降级: {e}")
                self._use_tiktoken = False

        # 降级：启发式估算
        return sum(self._heuristic(msg.get('content', '')) for msg in messages)

    def count_text(self, text: str) -> int:
        """计算单段文本的 token 数，优先 tiktoken，失败降级"""
        enc = self._get_encoding()

        if enc is not None:
            try:
                return len(enc.encode(text))
            except Exception as e:
                logger.warning(f"TokenCounter: tiktoken 计数失败，降级: {e}")
                self._use_tiktoken = False

        return self._heuristic(text)

    @staticmethod
    def _heuristic(text: str) -> int:
        """
        启发式 token 估算（保留原有逻辑）：
        - JSON 内容：字符数 / 3
        - 普通文本：字符数 × 1.2
        """
        if not text:
            return 0
        stripped = text.strip()
        if stripped.startswith('{') or stripped.startswith('['):
            return len(text) // 3
        return int(len(text) * 1.2)
