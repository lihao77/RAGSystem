# -*- coding: utf-8 -*-

import importlib
import os
import shutil
import tempfile
from pathlib import Path

from tools.paths.path_resolution import (
    DATA_ROOT,
    get_effective_workspace_root,
    get_session_cleanup_root,
    get_session_exports_root,
    get_session_root,
    get_session_sandbox_root,
    get_session_transient_root,
    get_session_uploads_root,
    get_session_visualizations_root,
    get_session_workspace_root,
    get_workspace_memory_key,
    get_export_run_root,
    infer_resource_scope,
    resolve_managed_directory,
    resolve_managed_path,
    to_display_path,
)


def _cleanup_path(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)


def test_session_directory_helpers_build_expected_structure():
    session_id = 'session-helper-1'
    run_id = 'run-helper-1'

    assert get_session_root(session_id) == DATA_ROOT / 'sessions' / session_id
    assert get_session_sandbox_root(session_id) == DATA_ROOT / 'sessions' / session_id / 'sandbox'
    assert get_session_workspace_root(session_id) == DATA_ROOT / 'sessions' / session_id / 'workspace'
    assert get_effective_workspace_root(session_id) == get_session_workspace_root(session_id)
    assert get_workspace_memory_key('E:/Python/cc/claude-code-source-code') == 'E-Python-cc-claude-code-source-code'
    assert get_session_transient_root(session_id) == DATA_ROOT / 'sessions' / session_id / 'transient'
    assert get_session_uploads_root(session_id) == DATA_ROOT / 'sessions' / session_id / 'uploads'
    assert get_session_visualizations_root(session_id) == DATA_ROOT / 'sessions' / session_id / 'visualizations'
    assert get_session_exports_root(session_id) == DATA_ROOT / 'sessions' / session_id / 'exports'
    assert get_export_run_root(session_id, run_id) == DATA_ROOT / 'sessions' / session_id / 'exports' / run_id
    assert get_session_cleanup_root(session_id) == DATA_ROOT / 'sessions' / session_id




def test_resolve_managed_directory_defaults_to_effective_workspace_root():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / 'workspace'
    workspace.mkdir(parents=True, exist_ok=True)

    try:
        resolved = resolve_managed_directory(
            None,
            session_id='session-dir-default-workspace',
            workspace_root=workspace,
            default_space='workspace',
        )
        assert resolved == workspace.resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_resolve_managed_directory_relative_workspace_space_uses_effective_workspace():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / 'workspace'
    target = workspace / 'nested'
    target.mkdir(parents=True, exist_ok=True)

    try:
        resolved = resolve_managed_directory(
            'nested',
            session_id='session-dir-explicit-workspace',
            workspace_root=workspace,
            explicit_space='workspace',
        )
        assert resolved == target.resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_resolve_managed_directory_relative_transient_space_uses_transient_root():
    session_id = 'session-dir-explicit-transient'
    session_root = get_session_root(session_id)
    transient_dir = get_session_transient_root(session_id) / 'tmp'
    _cleanup_path(session_root)

    try:
        transient_dir.mkdir(parents=True, exist_ok=True)
        resolved = resolve_managed_directory(
            'tmp',
            session_id=session_id,
            explicit_space='transient',
        )
        assert resolved == transient_dir.resolve()
    finally:
        _cleanup_path(session_root)


def test_resolve_managed_directory_relative_exports_space_uses_export_run_root():
    session_id = 'session-dir-explicit-exports'
    run_id = 'run-dir-explicit-exports'
    session_root = get_session_root(session_id)
    export_dir = get_export_run_root(session_id, run_id) / 'deliverables'
    _cleanup_path(session_root)

    try:
        export_dir.mkdir(parents=True, exist_ok=True)
        resolved = resolve_managed_directory(
            'deliverables',
            session_id=session_id,
            run_id=run_id,
            explicit_space='exports',
        )
        assert resolved == export_dir.resolve()
    finally:
        _cleanup_path(session_root)


def test_resolve_managed_directory_exports_space_requires_run_id():
    session_id = 'session-dir-missing-run'
    session_root = get_session_root(session_id)
    _cleanup_path(session_root)

    try:
        try:
            resolve_managed_directory(
                '.',
                session_id=session_id,
                explicit_space='exports',
            )
            assert False, 'expected ValueError'
        except ValueError as exc:
            assert 'run_id' in str(exc)
    finally:
        _cleanup_path(session_root)


def test_resolve_managed_directory_default_workspace_requires_workspace_context():
    try:
        resolve_managed_directory(
            None,
            default_space='workspace',
        )
        assert False, 'expected ValueError'
    except ValueError as exc:
        assert 'workspace' in str(exc)


def test_resolve_managed_directory_absolute_path_still_checks_managed_boundary():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / 'workspace'
    workspace.mkdir(parents=True, exist_ok=True)
    outside_dir = root / 'outside'
    outside_dir.mkdir(parents=True, exist_ok=True)

    try:
        try:
            resolve_managed_directory(
                str(outside_dir),
                session_id='session-dir-absolute-boundary',
                workspace_root=workspace,
            )
            assert False, 'expected PermissionError'
        except PermissionError:
            pass
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_resolve_managed_path_direct_read_prefers_workspace_root_when_file_exists():
    temp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = temp_root / 'workspace'
    workspace.mkdir(parents=True, exist_ok=True)
    target = workspace / 'demo.txt'
    target.write_text('workspace-data', encoding='utf-8')

    try:
        resolved = resolve_managed_path(
            'demo.txt',
            caller='direct',
            operation='read',
            workspace_root=workspace,
        )
        assert resolved == target.resolve()
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)



def test_resolve_managed_path_direct_write_assigns_transient_by_default():
    session_id = 'session-direct-write'
    session_root = get_session_root(session_id)
    _cleanup_path(session_root)

    try:
        resolved = resolve_managed_path(
            None,
            session_id=session_id,
            caller='direct',
            operation='write',
            suffix='.txt',
        )
        assert resolved.parent == get_session_transient_root(session_id)
        assert resolved.name.startswith('output_')
        assert resolved.suffix == '.txt'
    finally:
        _cleanup_path(session_root)


def test_resolve_managed_path_direct_write_assigns_workspace_and_exports():
    session_id = 'session-direct-output'
    run_id = 'run-direct-output'
    session_root = get_session_root(session_id)
    external_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent)) / 'external-workspace'
    _cleanup_path(session_root)

    try:
        workspace_path = resolve_managed_path(
            None,
            session_id=session_id,
            caller='direct',
            operation='write',
            default_output_space='workspace',
            suffix='.json',
        )
        external_workspace_path = resolve_managed_path(
            None,
            session_id=session_id,
            caller='direct',
            operation='write',
            default_output_space='workspace',
            workspace_root=external_root,
            suffix='.json',
        )
        export_path = resolve_managed_path(
            None,
            session_id=session_id,
            run_id=run_id,
            caller='direct',
            operation='write',
            default_output_space='exports',
            suffix='.txt',
        )
        assert workspace_path.parent == get_session_workspace_root(session_id)
        assert workspace_path.suffix == '.json'
        assert external_workspace_path.parent == external_root.resolve()
        assert external_workspace_path.suffix == '.json'
        assert export_path.parent == get_export_run_root(session_id, run_id)
        assert export_path.suffix == '.txt'
    finally:
        _cleanup_path(session_root)
        shutil.rmtree(external_root.parent, ignore_errors=True)


def test_resolve_managed_path_direct_read_uses_external_workspace_before_session_workspace():
    session_id = 'session-external-read'
    session_root = get_session_root(session_id)
    external_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent)) / 'external-workspace'
    _cleanup_path(session_root)
    _cleanup_path(external_root.parent)

    try:
        session_workspace = get_session_workspace_root(session_id)
        session_workspace.mkdir(parents=True, exist_ok=True)
        external_root.mkdir(parents=True, exist_ok=True)
        (session_workspace / 'demo.txt').write_text('session-workspace', encoding='utf-8')
        (external_root / 'demo.txt').write_text('external-workspace', encoding='utf-8')

        resolved = resolve_managed_path(
            'demo.txt',
            session_id=session_id,
            caller='direct',
            operation='read',
            workspace_root=external_root,
        )

        assert resolved == (external_root / 'demo.txt').resolve()
    finally:
        _cleanup_path(session_root)
        shutil.rmtree(external_root.parent, ignore_errors=True)


def test_resolve_managed_path_direct_relative_write_honors_explicit_transient_space():
    session_id = 'session-explicit-transient-write'
    session_root = get_session_root(session_id)
    _cleanup_path(session_root)

    try:
        resolved = resolve_managed_path(
            'note.txt',
            session_id=session_id,
            caller='direct',
            operation='write',
            explicit_space='transient',
        )
        assert resolved == (get_session_transient_root(session_id) / 'note.txt').resolve()
    finally:
        _cleanup_path(session_root)


def test_resolve_managed_path_direct_relative_write_honors_explicit_workspace_space():
    session_id = 'session-explicit-workspace-write'
    session_root = get_session_root(session_id)
    external_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent)) / 'external-workspace'
    _cleanup_path(session_root)

    try:
        external_root.mkdir(parents=True, exist_ok=True)
        resolved = resolve_managed_path(
            'draft.txt',
            session_id=session_id,
            caller='direct',
            operation='write',
            workspace_root=external_root,
            explicit_space='workspace',
        )
        assert resolved == (external_root / 'draft.txt').resolve()
    finally:
        _cleanup_path(session_root)
        shutil.rmtree(external_root.parent, ignore_errors=True)


def test_resolve_managed_path_direct_relative_write_honors_explicit_exports_space():
    session_id = 'session-explicit-exports-write'
    run_id = 'run-explicit-exports-write'
    session_root = get_session_root(session_id)
    _cleanup_path(session_root)

    try:
        resolved = resolve_managed_path(
            'report.md',
            session_id=session_id,
            run_id=run_id,
            caller='direct',
            operation='write',
            explicit_space='exports',
        )
        assert resolved == (get_export_run_root(session_id, run_id) / 'report.md').resolve()
    finally:
        _cleanup_path(session_root)


def test_resolve_managed_path_direct_read_honors_explicit_transient_space_before_workspace():
    session_id = 'session-explicit-transient-read'
    session_root = get_session_root(session_id)
    _cleanup_path(session_root)

    try:
        workspace_root = get_session_workspace_root(session_id)
        transient_root = get_session_transient_root(session_id)
        workspace_root.mkdir(parents=True, exist_ok=True)
        transient_root.mkdir(parents=True, exist_ok=True)
        (workspace_root / 'demo.txt').write_text('workspace-version', encoding='utf-8')
        (transient_root / 'demo.txt').write_text('transient-version', encoding='utf-8')

        resolved = resolve_managed_path(
            'demo.txt',
            session_id=session_id,
            caller='direct',
            operation='read',
            explicit_space='transient',
        )
        assert resolved == (transient_root / 'demo.txt').resolve()
    finally:
        _cleanup_path(session_root)


def test_resolve_managed_path_explicit_exports_space_requires_run_id():
    session_id = 'session-explicit-exports-missing-run'
    session_root = get_session_root(session_id)
    _cleanup_path(session_root)

    try:
        try:
            resolve_managed_path(
                'report.md',
                session_id=session_id,
                caller='direct',
                operation='write',
                explicit_space='exports',
            )
            assert False, 'expected ValueError'
        except ValueError as exc:
            assert 'run_id' in str(exc)
    finally:
        _cleanup_path(session_root)


def test_resolve_managed_directory_accepts_approved_external_absolute_directory():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / 'workspace'
    outside = root / 'outside'
    workspace.mkdir(parents=True, exist_ok=True)
    outside.mkdir(parents=True, exist_ok=True)

    try:
        resolved = resolve_managed_directory(
            str(outside),
            session_id='session-dir-approved-external',
            workspace_root=workspace,
            approved_external_paths=[str(outside)],
        )
        assert resolved == outside.resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


    temp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    external_file = temp_root / 'external.txt'

    try:
        resolved = resolve_managed_path(
            str(external_file),
            session_id='session-approved-external-write',
            caller='direct',
            operation='write',
            approved_external_paths=[str(external_file)],
        )
        assert resolved == external_file.resolve()
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


def test_resolve_managed_path_direct_write_rejects_unapproved_external_absolute_path():
    temp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    external_file = temp_root / 'external.txt'

    try:
        try:
            resolve_managed_path(
                str(external_file),
                session_id='session-unapproved-external-write',
                caller='direct',
                operation='write',
            )
            assert False, 'expected PermissionError'
        except PermissionError as exc:
            assert '超出允许的受管目录范围' in str(exc)
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


    temp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = temp_root / 'workspace'
    workspace.mkdir(parents=True, exist_ok=True)
    target = workspace / 'sample.json'
    target.write_text('{"ok": true}', encoding='utf-8')

    try:
        resolved = resolve_managed_path(
            str(target),
            session_id='session-code-workspace',
            caller='code_execution',
            operation='read',
            workspace_root=workspace,
        )
        assert resolved == target.resolve()
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


def test_resolve_managed_path_code_execution_write_is_restricted_to_sandbox():
    temp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    outside_file = temp_root / 'outside.txt'
    try:
        try:
            resolve_managed_path(
                str(outside_file),
                session_id='session-code-write',
                caller='code_execution',
                operation='write',
            )
            assert False, 'expected PermissionError'
        except PermissionError:
            pass
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


def test_resolve_managed_path_accepts_display_path_roundtrip():
    session_id = 'session-display-1'
    session_root = get_session_root(session_id)
    transient_root = get_session_transient_root(session_id)
    _cleanup_path(session_root)
    transient_root.mkdir(parents=True, exist_ok=True)
    target = transient_root / 'roundtrip.txt'
    target.write_text('hello', encoding='utf-8')

    try:
        display = to_display_path(target)
        resolved = resolve_managed_path(
            display,
            session_id=session_id,
            caller='direct',
            operation='read',
        )
        assert display == f'./data/sessions/{session_id}/transient/roundtrip.txt'
        assert resolved == target.resolve()
    finally:
        _cleanup_path(session_root)


def test_to_display_path_formats_session_paths_under_data_root():
    path = get_session_visualizations_root('session-display-2') / 'viz.json'
    assert to_display_path(path) == './data/sessions/session-display-2/visualizations/viz.json'


def test_infer_resource_scope_detects_session_buckets():
    session_id = 'session-scope-1'
    run_id = 'run-scope-1'
    external_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent)) / 'workspace'

    assert infer_resource_scope(get_session_sandbox_root(session_id) / 'a.txt') == 'transient'
    assert infer_resource_scope(get_session_transient_root(session_id) / 'b.json') == 'transient'
    assert infer_resource_scope(get_session_workspace_root(session_id) / 'c.txt') == 'workspace'
    assert infer_resource_scope(get_session_uploads_root(session_id) / 'd.csv') == 'upload'
    assert infer_resource_scope(get_session_visualizations_root(session_id) / 'e.json') == 'session'
    assert infer_resource_scope(get_export_run_root(session_id, run_id) / 'f.txt') == 'export'
    try:
        external_root.mkdir(parents=True, exist_ok=True)
        assert infer_resource_scope(external_root / 'g.txt', workspace_root=external_root) == 'workspace'
    finally:
        shutil.rmtree(external_root.parent, ignore_errors=True)
