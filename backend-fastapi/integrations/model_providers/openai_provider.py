"""OpenAI Provider 兼容导出层。"""

from .openai_chat_completions_provider import OpenAIChatCompletionsProvider

OpenAIProvider = OpenAIChatCompletionsProvider

__all__ = ['OpenAIProvider', 'OpenAIChatCompletionsProvider']
