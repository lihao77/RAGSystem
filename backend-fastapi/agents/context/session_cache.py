# -*- coding: utf-8 -*-
"""
SessionCache - 跨进程持久化的 pipeline 缓存

策略：per-run read-through / write-through
  - 首次访问 lazy load 单个 session（从 DB 读）
  - 运行时直接读写内存
  - run 结束时 flush 单个 session 回 DB

存储位置：sessions.metadata._pipeline_caches
数据结构：
  { "thread_key": {"fp": "sha256前16位", "t": unix_timestamp} }
每个 session × thread 仅存 fp + t，约 50 字节。
"""

import logging
import threading
from typing import Any, Dict

logger = logging.getLogger(__name__)

# ─── 模块级共享状态 ──────────────────────────────────────────────────────────

_lock = threading.Lock()
# {session_id: {thread_key: {"fp": str, "t": float, ...}}}
_caches: Dict[str, Dict[str, Dict[str, Any]]] = {}
_loaded_sessions: set = set()
_store = None  # ConversationStore 引用


# ─── 公开 API ────────────────────────────────────────────────────────────────

def bind_store(store) -> None:
    """绑定 ConversationStore 实例（启动时调用一次）。"""
    global _store
    _store = store


def get_cache(session_id: str, thread_key: str) -> Dict[str, Any]:
    """获取指定 session+thread 的缓存 dict。

    首次访问 lazy load 该 session 的全部 thread 缓存。
    返回的 dict 可直接读写，修改后需调用 flush_session 落盘。
    """
    with _lock:
        _ensure_session_loaded(session_id)
        session_caches = _caches.setdefault(session_id, {})
        return session_caches.setdefault(thread_key, {})


def flush_session(session_id: str) -> None:
    """将单个 session 的缓存写回 DB（run 结束时调用）。"""
    if _store is None:
        return
    with _lock:
        caches = _caches.get(session_id)
    if not caches:
        return
    # 只持久化 fp + t，不存 prepared_messages 等大对象
    to_save = {}
    for tk, data in caches.items():
        entry = {}
        if 'fp' in data:
            entry['fp'] = data['fp']
        if 't' in data:
            entry['t'] = data['t']
        if entry:
            to_save[tk] = entry
    if not to_save:
        return
    try:
        _store.update_session_metadata(
            session_id,
            {"_pipeline_caches": to_save},
            merge_nested=True,
        )
    except Exception as e:
        logger.warning("SessionCache: flush session %s 失败: %s", session_id, e)


# ─── 内部方法 ────────────────────────────────────────────────────────────────

def _ensure_session_loaded(session_id: str) -> None:
    """Lazy load 单个 session（调用者需持有 _lock）。"""
    if session_id in _loaded_sessions:
        return
    _loaded_sessions.add(session_id)
    if _store is None:
        return
    try:
        session = _store.get_session(session_id)
        if session:
            meta = session.get("metadata", {})
            caches = meta.get("_pipeline_caches")
            if caches and isinstance(caches, dict):
                _caches[session_id] = {k: dict(v) for k, v in caches.items()}
    except Exception:
        pass  # 加载失败不影响运行，缓存为空即可


def reset() -> None:
    """重置所有内存状态（仅用于测试）。"""
    global _store
    with _lock:
        _caches.clear()
        _loaded_sessions.clear()
        _store = None
