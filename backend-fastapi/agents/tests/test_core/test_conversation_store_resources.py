# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path

from services.conversation_store import ConversationStore
from tools.path_resolution import (
    EXPORTS_ROOT,
    TRANSIENT_ROOT,
    VISUALIZATION_ROOT,
    get_export_run_root,
    get_session_sandbox_root,
    get_session_visualizations_root,
)


def _make_temp_dir() -> Path:
    return Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))


def test_conversation_store_persists_runs_resources_and_step_links():
    temp_dir = tempfile.mkdtemp()
    try:
        db_path = str(Path(temp_dir) / "conversation.db")
        store = ConversationStore(db_path=db_path, start_cleanup_thread=False)

        store.create_session("session-1", user_id="user-1")
        run = store.create_run(
            run_id="run-1",
            session_id="session-1",
            entrypoint="execute",
            status="running",
            task_summary="demo task",
            user_id="user-1",
            agent_name="orchestrator_agent",
        )
        assert run["run_id"] == "run-1"

        message = store.add_message(
            session_id="session-1",
            role="assistant",
            content="done",
            metadata={"run_id": "run-1", "msg_type": "assistant_final"},
        )
        step = store.add_run_step(
            session_id="session-1",
            run_id="run-1",
            step_type="call.tool.end",
            payload={"call_id": "call-1", "tool_name": "write_file", "data": {"result_preview": "ok"}},
            message_id=message["id"],
        )
        resource = store.register_resource(
            session_id="session-1",
            run_id="run-1",
            step_id=step["id"],
            message_id=message["id"],
            resource_type="data",
            sub_type="text",
            title="output",
            path=str(Path(temp_dir) / "output.txt"),
            source_tool="write_file",
        )

        store.attach_resource_to_step(
            session_id="session-1",
            run_id="run-1",
            step_id=step["id"],
            resource_id=resource["resource_id"],
        )
        store.update_run_status(
            "run-1",
            session_id="session-1",
            status="completed",
            final_message_id=message["id"],
        )

        runs = store.list_runs(session_id="session-1")
        assert runs["items"][0]["status"] == "completed"
        assert runs["items"][0]["final_message_id"] == message["id"]

        resources = store.list_resources(session_id="session-1", run_id="run-1")
        assert len(resources["items"]) == 1
        assert resources["items"][0]["resource_id"] == resource["resource_id"]

        steps = store.list_run_steps(run_id="run-1", session_id="session-1")
        assert steps[0]["payload"]["resource_refs"][0]["resource_id"] == resource["resource_id"]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_conversation_store_infers_new_resource_scopes():
    root = _make_temp_dir()
    try:
        db_path = root / "conversation.db"
        store = ConversationStore(db_path=str(db_path), start_cleanup_thread=False)
        store.create_session("session-scope")

        transient_path = TRANSIENT_ROOT / "artifacts" / "data_1.json"
        transient_path.parent.mkdir(parents=True, exist_ok=True)
        transient_path.write_text("{}", encoding="utf-8")

        export_path = EXPORTS_ROOT / "session-scope" / "run-1" / "out.txt"
        export_path.parent.mkdir(parents=True, exist_ok=True)
        export_path.write_text("ok", encoding="utf-8")

        viz_path = VISUALIZATION_ROOT / "session-scope" / "viz.json"
        viz_path.parent.mkdir(parents=True, exist_ok=True)
        viz_path.write_text("{}", encoding="utf-8")

        transient = store.register_resource(
            session_id="session-scope",
            path=str(transient_path),
            resource_type="data",
            source_tool="demo",
        )
        export = store.register_resource(
            session_id="session-scope",
            path=str(export_path),
            resource_type="data",
            source_tool="demo",
        )
        session = store.register_resource(
            session_id="session-scope",
            path=str(viz_path),
            resource_type="artifact",
            source_tool="demo",
        )

        assert transient["scope"] == "transient"
        assert export["scope"] == "export"
        assert session["scope"] == "session"
    finally:
        shutil.rmtree(root, ignore_errors=True)




def test_conversation_store_infers_external_workspace_scope_from_session_metadata():
    root = _make_temp_dir()
    try:
        db_path = root / 'conversation.db'
        store = ConversationStore(db_path=str(db_path), start_cleanup_thread=False)
        store.create_session('session-external-scope', metadata={'workspace_root': str(root / 'workspace')})

        external_workspace_file = root / 'workspace' / 'demo.txt'
        external_workspace_file.parent.mkdir(parents=True, exist_ok=True)
        external_workspace_file.write_text('demo', encoding='utf-8')

        resource = store.register_resource(
            session_id='session-external-scope',
            path=str(external_workspace_file),
            resource_type='data',
            source_tool='write_file',
        )

        assert resource['scope'] == 'workspace'
    finally:
        shutil.rmtree(root, ignore_errors=True)



def test_conversation_store_infers_new_session_directory_scopes():
    session_id = 'session-scope-managed'
    run_id = 'run-scope-managed'
    root = _make_temp_dir()
    store = ConversationStore(db_path=str(root / 'conversation.db'), start_cleanup_thread=False)

    sandbox_path = get_session_sandbox_root(session_id) / 'temp.txt'
    sandbox_path.parent.mkdir(parents=True, exist_ok=True)
    sandbox_path.write_text('temp', encoding='utf-8')

    viz_path = get_session_visualizations_root(session_id) / 'viz.json'
    viz_path.parent.mkdir(parents=True, exist_ok=True)
    viz_path.write_text('{}', encoding='utf-8')

    export_path = get_export_run_root(session_id, run_id) / 'export.txt'
    export_path.parent.mkdir(parents=True, exist_ok=True)
    export_path.write_text('ok', encoding='utf-8')

    try:
        assert store._infer_scope(str(sandbox_path)) == 'transient'
        assert store._infer_scope(str(viz_path)) == 'session'
        assert store._infer_scope(str(export_path)) == 'export'
    finally:
        store.close()
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(get_session_sandbox_root(session_id).parent, ignore_errors=True)
