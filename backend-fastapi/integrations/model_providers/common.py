"""
AI Provider 具体实现

实现了 OpenAI、DeepSeek、OpenRouter 等主流 AI 服务。
"""

import json
import logging
import time
import threading
from typing import Any, Dict, Generator, List, Optional, Union
import requests
from integrations.errors import RequestCancelledError
from model_adapter.base import AIProvider, ModelResponse, EmbeddingResponse, AIProviderType

logger = logging.getLogger(__name__)


def _preview_model_content(content: Any, limit: int = 200) -> str:
    text = '' if content is None else str(content)
    text = text.replace('\n', '\\n')
    if len(text) <= limit:
        return text
    return text[:limit] + '...<truncated>'


class InterruptedError(RequestCancelledError):
    """请求被用户中断"""
    pass


class CancellableRequest:
    """可取消的 HTTP 请求工具类"""

    @staticmethod
    def post(url, cancel_event=None, **kwargs):
        """
        发送可取消的 POST 请求

        Args:
            url: 请求 URL
            cancel_event: threading.Event，用于取消请求
            **kwargs: 传递给 requests.post 的参数

        Returns:
            requests.Response

        Raises:
            InterruptedError: 请求被取消
        """
        if cancel_event is None:
            return requests.post(url, **kwargs)

        if cancel_event.is_set():
            raise InterruptedError("请求已取消")

        session = requests.Session()
        result = [None]
        error = [None]
        done = threading.Event()

        def do_request():
            try:
                result[0] = session.post(url, **kwargs)
            except Exception as e:
                error[0] = e
            finally:
                done.set()

        t = threading.Thread(target=do_request, daemon=True)
        t.start()

        while not done.is_set():
            if cancel_event.is_set():
                session.close()
                raise InterruptedError("请求被用户取消")
            done.wait(timeout=0.5)

        if error[0]:
            raise error[0]
        return result[0]


def _decode_response_text(response: requests.Response) -> str:
    """按 UTF-8 优先解码响应体，避免上游错误声明 charset 时出现乱码。"""
    raw = response.content or b""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        logger.warning(
            "响应体不是有效 UTF-8，回退到 requests 默认解码: content-type=%s, encoding=%s",
            response.headers.get("content-type"),
            response.encoding,
        )
        return response.text


def _load_json_response(response: requests.Response) -> Dict[str, Any]:
    """使用 UTF-8 优先策略解析 JSON，避免代理站错误声明编码。"""
    return json.loads(_decode_response_text(response))


def _openai_compatible_stream(
    url: str,
    headers: Dict[str, str],
    payload: Dict[str, Any],
    timeout: int,
    cancel_event: Optional[threading.Event] = None,
) -> Generator[Dict[str, Any], None, None]:
    """
    OpenAI 兼容 API 的流式请求公共实现。

    所有兼容 OpenAI 格式的 Provider（OpenAI、DeepSeek、OpenRouter）共用此函数。

    Yields:
        {"content": str, "finish_reason": str|None}
    """
    try:
        response = requests.post(
            url,
            headers=headers,
            json=payload,
            timeout=timeout,
            stream=True,
        )
        response.raise_for_status()

        stream_has_content = False
        stream_chunk_count = 0
        stream_finish_reason = None

        for line in response.iter_lines(decode_unicode=False):
            # 检查取消信号
            if cancel_event and cancel_event.is_set():
                response.close()
                yield {"content": "", "finish_reason": "interrupted"}
                return

            if not line:
                continue

            try:
                line_text = line.decode("utf-8-sig")
            except UnicodeDecodeError:
                logger.debug("流式输出遇到非 UTF-8 行，已跳过: %r", line[:100])
                continue

            if not line_text.startswith("data: "):
                continue

            data_str = line_text[6:]
            if data_str.strip() == "[DONE]":
                return

            try:
                chunk = json.loads(data_str)
            except json.JSONDecodeError:
                logger.debug(f"流式输出跳过无效 JSON: {data_str[:100]}")
                continue

            choices = chunk.get("choices", [])
            if not choices:
                continue

            delta = choices[0].get("delta", {})
            finish_reason = choices[0].get("finish_reason")
            if finish_reason:
                stream_finish_reason = finish_reason

            content = delta.get("content", "")
            if content:
                stream_has_content = True
                stream_chunk_count += 1
                logger.debug(
                    "OpenAI-compatible stream content chunk: finish_reason=%s has_xml=%s preview=%r",
                    finish_reason,
                    ('<final_answer>' in content) or ('<tools>' in content) or ('<intent>' in content),
                    _preview_model_content(content),
                )
            elif finish_reason:
                logger.debug(
                    "OpenAI-compatible stream finish chunk without content: finish_reason=%s chunks=%s",
                    finish_reason,
                    stream_chunk_count,
                )
            if content or finish_reason:
                yield {
                    "content": content or "",
                    "finish_reason": finish_reason,
                }

        if not stream_has_content:
            logger.warning(
                "OpenAI-compatible stream completed without content: finish_reason=%s model=%s max_tokens=%s stop=%s",
                stream_finish_reason,
                payload.get('model'),
                payload.get('max_completion_tokens', payload.get('max_tokens')),
                payload.get('stop'),
            )

    except InterruptedError:
        yield {"content": "", "finish_reason": "interrupted"}
    except Exception as e:
        logger.error(f"流式请求失败: {e}")
        yield {"content": "", "error": str(e), "finish_reason": "error"}
