#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
_cache.py - 基于文件的请求缓存，跨进程复用。

缓存文件存放在 skill 目录下的 .cache/ 中，按请求参数哈希命名。
默认 TTL 5 分钟，水情实时数据更新频率约 1 小时，5 分钟足够避免
同一轮对话中的重复请求。
"""

import hashlib
import json
import os
import time
from pathlib import Path

_CACHE_DIR = Path(__file__).resolve().parents[1] / ".cache"
DEFAULT_TTL = 300  # 5 分钟


def _ensure_cache_dir():
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _cache_key(namespace: str, params: dict) -> str:
    raw = json.dumps(params, sort_keys=True, ensure_ascii=False)
    h = hashlib.md5(raw.encode("utf-8")).hexdigest()[:12]
    return f"{namespace}_{h}"


def get(namespace: str, params: dict, ttl: int = DEFAULT_TTL):
    """读取缓存，命中返回 dict，未命中或过期返回 None。"""
    _ensure_cache_dir()
    key = _cache_key(namespace, params)
    path = _CACHE_DIR / f"{key}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - data.get("_ts", 0) > ttl:
            path.unlink(missing_ok=True)
            return None
        return data.get("payload")
    except (json.JSONDecodeError, OSError):
        path.unlink(missing_ok=True)
        return None


def put(namespace: str, params: dict, payload):
    """写入缓存。"""
    _ensure_cache_dir()
    key = _cache_key(namespace, params)
    path = _CACHE_DIR / f"{key}.json"
    data = {"_ts": time.time(), "params": params, "payload": payload}
    try:
        path.write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass


def cleanup(max_age: int = 3600):
    """清理超过 max_age 秒的缓存文件。"""
    _ensure_cache_dir()
    now = time.time()
    for f in _CACHE_DIR.glob("*.json"):
        try:
            if now - f.stat().st_mtime > max_age:
                f.unlink(missing_ok=True)
        except OSError:
            pass
