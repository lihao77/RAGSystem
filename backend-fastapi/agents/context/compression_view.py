# -*- coding: utf-8 -*-
"""Compression view resolver for persisted conversation history."""

from __future__ import annotations

import json
from typing import Any, Dict, List


def _parse_metadata(message: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize message metadata to a dict."""
    metadata = message.get("metadata") or {}
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata) if metadata else {}
        except Exception:
            metadata = {}
    return metadata


def resolve_compression_view(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Resolve persisted compression messages into the final prompt view.

    If a compression summary exists, only the latest effective summary is kept and
    it replaces all messages before its covered range.
    """
    if not messages:
        return []

    compression_msg = None
    compression_idx = -1
    parsed_metadata = [_parse_metadata(message) for message in messages]

    for idx, (message, metadata) in enumerate(zip(messages, parsed_metadata)):
        if not metadata.get("compression"):
            continue

        if compression_msg is None:
            compression_msg = message
            compression_idx = idx
        elif message.get("seq") is None:
            compression_msg = message
            compression_idx = idx
        elif compression_msg.get("seq") is None and message.get("seq") is not None:
            continue
        elif (
            message.get("seq") is not None
            and compression_msg.get("seq") is not None
            and message["seq"] > compression_msg["seq"]
        ):
            compression_msg = message
            compression_idx = idx

    if compression_msg is None:
        return list(messages)

    summary_seq = compression_msg.get("seq")
    compression_meta = parsed_metadata[compression_idx]
    replaces_up_to_seq = compression_meta.get("replaces_up_to_seq")

    output = [{
        "role": "system",
        "content": compression_msg.get("content", ""),
        "metadata": {"compression": True},
        "seq": summary_seq,
    }]

    if summary_seq is not None:
        cutoff = replaces_up_to_seq if replaces_up_to_seq is not None else summary_seq
        for message, metadata in zip(messages, parsed_metadata):
            if metadata.get("compression"):
                continue
            if message.get("seq") is not None and message["seq"] > cutoff:
                output.append({
                    "role": message.get("role", "user"),
                    "content": message.get("content", ""),
                    "metadata": metadata,
                    "seq": message.get("seq"),
                })
    else:
        for idx in range(compression_idx + 1, len(messages)):
            message = messages[idx]
            metadata = parsed_metadata[idx]
            output.append({
                "role": message.get("role", "user"),
                "content": message.get("content", ""),
                "metadata": metadata,
                "seq": message.get("seq"),
            })

    return output
