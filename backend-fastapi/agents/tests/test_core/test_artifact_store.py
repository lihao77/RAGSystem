# -*- coding: utf-8 -*-

import os
import shutil
import tempfile
import time
from pathlib import Path

from agents.artifacts import ArtifactStore
from tools.paths.path_resolution import get_session_transient_root, get_session_visualizations_root


def _make_temp_dir() -> str:
    return tempfile.mkdtemp(dir=Path(__file__).resolve().parent)


def test_artifact_store_default_base_dir_points_to_anonymous_session_transient_root():
    store = ArtifactStore()
    assert Path(store.base_dir) == get_session_transient_root("anonymous")


def test_artifact_store_save_json_uses_data_file_pattern():
    temp_dir = _make_temp_dir()
    try:
        store = ArtifactStore(base_dir=temp_dir)

        artifact = store.save_json(session_id="s1", tool_name="demo", data={"x": 1})

        assert os.path.exists(artifact.path)
        assert os.path.basename(artifact.path).startswith("data_")
        assert artifact.path.endswith(".json")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_artifact_store_save_text_uses_data_file_pattern():
    temp_dir = _make_temp_dir()
    try:
        store = ArtifactStore(base_dir=temp_dir)

        artifact = store.save_text(session_id="s1", tool_name="demo", content="hello")

        assert os.path.exists(artifact.path)
        assert os.path.basename(artifact.path).startswith("data_")
        assert artifact.path.endswith(".json")
        with open(artifact.path, "r", encoding="utf-8") as file_obj:
            assert file_obj.read() == "hello"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_artifact_store_records_session_metadata():
    temp_dir = _make_temp_dir()
    try:
        store = ArtifactStore(base_dir=temp_dir)

        artifact = store.save_json(
            session_id="s-meta",
            tool_name="demo",
            data={"x": 1},
            metadata={"source": "test"},
        )
        records = store.list_records(session_id="s-meta")

        assert artifact.metadata["session_id"] == "s-meta"
        assert artifact.metadata["tool_name"] == "demo"
        assert artifact.metadata["source"] == "test"
        assert len(records) == 1
        assert records[0].session_id == "s-meta"
        assert records[0].tool_name == "demo"
        assert records[0].metadata == {"source": "test"}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_artifact_store_cleanup_removes_stale_files():
    temp_dir = _make_temp_dir()
    try:
        store = ArtifactStore(base_dir=temp_dir)

        stale = store.save_json(session_id="s1", tool_name="demo", data={"old": True})
        fresh = store.save_json(session_id="s1", tool_name="demo", data={"new": True})

        old_time = time.time() - 3600
        os.utime(stale.path, (old_time, old_time))

        deleted_count = store.cleanup(max_age_seconds=300)

        assert deleted_count == 1
        assert os.path.exists(fresh.path)
        assert not os.path.exists(stale.path)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_artifact_store_cleanup_removes_expired_indexed_files_by_ttl():
    temp_dir = _make_temp_dir()
    try:
        store = ArtifactStore(base_dir=temp_dir)

        expired = store.save_json(
            session_id="s1",
            tool_name="demo",
            data={"old": True},
            ttl_seconds=0,
        )
        fresh = store.save_json(
            session_id="s1",
            tool_name="demo",
            data={"new": True},
            ttl_seconds=3600,
        )

        time.sleep(0.01)
        deleted_count = store.cleanup(max_age_seconds=24 * 60 * 60)

        assert deleted_count == 1
        assert not os.path.exists(expired.path)
        assert os.path.exists(fresh.path)
        assert [record.path for record in store.list_records()] == [fresh.path]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)




def test_artifact_store_default_session_storage_uses_session_transient_root():
    session_id = 'artifact-session-root'
    artifact = ArtifactStore().save_json(session_id=session_id, tool_name='demo', data={'x': 1})
    try:
        assert Path(artifact.path).parent == get_session_transient_root(session_id)
    finally:
        Path(artifact.path).unlink(missing_ok=True)
        index_file = get_session_transient_root(session_id) / 'artifact_index.jsonl'
        index_file.unlink(missing_ok=True)
        shutil.rmtree(get_session_transient_root(session_id).parent, ignore_errors=True)


def test_artifact_store_cleanup_preserves_visualizations_scope_files():
    temp_dir = _make_temp_dir()
    try:
        store = ArtifactStore(base_dir=temp_dir)

        artifact = store.save_json(
            session_id="s1",
            tool_name="create_chart",
            data={"viz": True},
            metadata={"storage_scope": "visualizations"},
            ttl_seconds=0,
        )

        time.sleep(0.01)
        deleted_count = store.cleanup(max_age_seconds=1)

        assert deleted_count == 0
        assert os.path.exists(artifact.path)
        assert [record.path for record in store.list_records()] == [artifact.path]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_artifact_store_visualization_scope_uses_session_visualizations_root():
    session_id = 'artifact-viz-root'
    artifact = ArtifactStore().save_json(
        session_id=session_id,
        tool_name='create_chart',
        data={'viz': True},
        metadata={'storage_scope': 'visualizations'},
    )
    try:
        assert Path(artifact.path).parent == get_session_visualizations_root(session_id)
    finally:
        Path(artifact.path).unlink(missing_ok=True)
        index_file = get_session_visualizations_root(session_id) / 'artifact_index.jsonl'
        index_file.unlink(missing_ok=True)
        shutil.rmtree(get_session_visualizations_root(session_id).parent, ignore_errors=True)


