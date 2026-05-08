# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path

import pytest

from agents.artifacts import ArtifactStore
from agents.context.compression_view import resolve_compression_view
from services.conversation_store import ConversationStore


def _make_temp_dir() -> str:
    return tempfile.mkdtemp(dir=Path(__file__).resolve().parent)


@pytest.mark.parametrize(
    ("messages", "expected_contents", "expected_seqs"),
    [
        (
            [
                {"seq": 1, "role": "user", "content": "u1", "metadata": {}},
                {"seq": 2, "role": "assistant", "content": "a1", "metadata": {}},
                {
                    "seq": 3,
                    "role": "system",
                    "content": "[历史摘要]\nv1",
                    "metadata": {"compression": True, "replaces_up_to_seq": 2},
                },
                {"seq": 4, "role": "user", "content": "mid-u", "metadata": {}},
                {"seq": 5, "role": "assistant", "content": "mid-a", "metadata": {}},
                {
                    "seq": 6,
                    "role": "system",
                    "content": "[历史摘要]\nv2",
                    "metadata": {"compression": True, "replaces_up_to_seq": 4},
                },
                {"seq": 7, "role": "user", "content": "tail", "metadata": {}},
            ],
            ["[历史摘要]\nv2", "mid-a", "tail"],
            [6, 5, 7],
        ),
        (
            [
                {
                    "seq": 10,
                    "role": "system",
                    "content": "[历史摘要]\npersisted",
                    "metadata": {"compression": True, "replaces_up_to_seq": 8},
                },
                {"seq": 11, "role": "user", "content": "kept", "metadata": {}},
                {
                    "seq": None,
                    "role": "system",
                    "content": "[历史摘要]\nin-memory-v1",
                    "metadata": {"compression": True},
                },
                {"seq": 12, "role": "assistant", "content": "between", "metadata": {}},
                {
                    "seq": None,
                    "role": "system",
                    "content": "[历史摘要]\nin-memory-v2",
                    "metadata": {"compression": True},
                },
                {"seq": 13, "role": "user", "content": "after", "metadata": {}},
            ],
            ["[历史摘要]\nin-memory-v2", "after"],
            [None, 13],
        ),
        (
            [
                {"seq": 1, "role": "user", "content": "u1", "metadata": {}},
                {"seq": 2, "role": "assistant", "content": "a1", "metadata": {}},
                {
                    "seq": 3,
                    "role": "system",
                    "content": "[历史摘要]\njson-metadata",
                    "metadata": "{\"compression\": true, \"replaces_up_to_seq\": 2}",
                },
                {"seq": 4, "role": "user", "content": "tail", "metadata": {}},
            ],
            ["[历史摘要]\njson-metadata", "tail"],
            [3, 4],
        ),
    ],
)
def test_resolve_compression_view_regressions(messages, expected_contents, expected_seqs):
    resolved = resolve_compression_view(messages)

    assert [item["content"] for item in resolved] == expected_contents
    assert [item["seq"] for item in resolved] == expected_seqs
    assert resolved[0]["metadata"] == {"compression": True}


def test_resolve_compression_view_ignores_invalid_metadata_json():
    messages = [
        {"seq": 1, "role": "user", "content": "hello", "metadata": "{\"compression\": true"},
    ]

    resolved = resolve_compression_view(messages)

    assert resolved == messages


def test_conversation_store_compression_message_round_trip_uses_replaces_up_to_seq():
    temp_dir = _make_temp_dir()
    try:
        store = ConversationStore(
            db_path=str(Path(temp_dir) / "conversation.db"),
            start_cleanup_thread=False,
            artifact_store=ArtifactStore(base_dir=str(Path(temp_dir) / "artifacts")),
        )
        session_id = "compression-round-trip"

        store.add_message(session_id, "user", "u1")
        store.add_message(session_id, "assistant", "a1")
        store.add_message(session_id, "user", "tail-before-summary")
        summary = store.insert_compression_message(
            session_id=session_id,
            summary_content="[历史摘要]\nsummary",
            replaces_up_to_seq=2,
        )
        store.add_message(session_id, "assistant", "tail-after-summary")

        messages = store.get_recent_messages(session_id, limit=20)
        resolved = resolve_compression_view(messages)

        assert summary["seq"] == 4
        assert [item["content"] for item in resolved] == [
            "[历史摘要]\nsummary",
            "tail-before-summary",
            "tail-after-summary",
        ]
        assert [item["seq"] for item in resolved] == [4, 3, 5]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_conversation_store_compression_message_uses_thread_key():
    temp_dir = _make_temp_dir()
    try:
        store = ConversationStore(
            db_path=str(Path(temp_dir) / "conversation.db"),
            start_cleanup_thread=False,
            artifact_store=ArtifactStore(base_dir=str(Path(temp_dir) / "artifacts")),
        )
        session_id = "compression-thread-key"

        summary = store.insert_compression_message(
            session_id=session_id,
            summary_content="[历史摘要]\nchild",
            replaces_up_to_seq=2,
            thread_key="child:child-1",
            child_agent_id="child-1",
            metadata={
                "conversation_scope": "child",
                "visible_to_user": False,
            },
        )

        root_messages = store.get_recent_messages(session_id, limit=20, thread_key="root")
        child_messages = store.get_recent_messages(session_id, limit=20, thread_key="child:child-1")

        assert summary["thread_key"] == "child:child-1"
        assert summary["child_agent_id"] == "child-1"
        assert summary["metadata"]["compression"] is True
        assert summary["metadata"]["thread_key"] == "child:child-1"
        assert summary["metadata"]["child_agent_id"] == "child-1"
        assert summary["metadata"]["conversation_scope"] == "child"
        assert summary["metadata"]["visible_to_user"] is False
        assert root_messages == []
        assert [item["content"] for item in child_messages] == ["[历史摘要]\nchild"]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
