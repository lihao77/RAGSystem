# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.v1.files import router as files_router
from api.v1.session_files import router as session_files_router
import api.v1.files as files_api
import api.v1.session_files as session_files_api


class _FakeFileIndex:
    def __init__(self):
        self._records = {}
        self._seq = 0

    def list(self, *, scope_type=None, scope_id=None, **kwargs):
        items = list(self._records.values())
        if scope_type:
            items = [item for item in items if item.get('scope_type', 'global') == scope_type and item.get('scope_id') == scope_id]
        return items

    def get(self, file_id, *, scope_type=None, scope_id=None):
        rec = self._records.get(file_id)
        if not rec:
            return None
        if scope_type and (rec.get('scope_type', 'global') != scope_type or rec.get('scope_id') != scope_id):
            return None
        return rec

    def add(self, **kwargs):
        self._seq += 1
        record = {'id': f'file-{self._seq}', **kwargs}
        self._records[record['id']] = record
        return record

    def delete(self, file_id):
        return self._records.pop(file_id, None) is not None


def _make_client(tmp_root: Path):
    app = FastAPI()
    app.include_router(files_router, prefix='/files')
    app.include_router(session_files_router, prefix='/agent/sessions/{session_id}/files')

    index = _FakeFileIndex()
    global_upload_root = tmp_root / 'uploads'

    files_api._get_index = lambda: index
    files_api.get_uploads_root = lambda: global_upload_root
    session_files_api._get_index = lambda: index
    session_files_api.get_session_uploads_root = lambda session_id: tmp_root / 'sessions' / session_id / 'uploads'
    return TestClient(app), index, global_upload_root


def test_global_and_session_file_routes_are_isolated():
    tmp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    try:
        client, index, global_root = _make_client(tmp_root)

        global_file = client.post('/files/upload', files=[('files', ('g.txt', b'global', 'text/plain'))]).json()['files'][0]
        session_file = client.post('/agent/sessions/s1/files/upload', files=[('files', ('s.txt', b'session', 'text/plain'))]).json()['files'][0]

        assert Path(global_file['stored_path']).parent == global_root
        assert Path(session_file['stored_path']).parent.name == 'uploads'
        assert session_file['scope_type'] == 'session'
        assert session_file['scope_id'] == 's1'

        global_list = client.get('/files')
        assert [item['id'] for item in global_list.json()['files']] == [global_file['id']]

        session_list = client.get('/agent/sessions/s1/files')
        assert [item['id'] for item in session_list.json()['files']] == [session_file['id']]

        cross_global = client.get(f"/files/{session_file['id']}")
        assert cross_global.status_code == 404

        cross_session = client.get(f"/agent/sessions/s1/files/{global_file['id']}")
        assert cross_session.status_code == 404

        other_session = client.get(f"/agent/sessions/s2/files/{session_file['id']}")
        assert other_session.status_code == 404

        delete_session = client.delete(f"/agent/sessions/s1/files/{session_file['id']}")
        assert delete_session.status_code == 200
        assert index.get(session_file['id']) is None
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
