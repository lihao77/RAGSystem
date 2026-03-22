# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.v1.files import router as files_router
import api.v1.files as files_api


class _FakeFileIndex:
    def __init__(self):
        self._records = {}
        self._seq = 0

    def list(self):
        return list(self._records.values())

    def get(self, file_id):
        return self._records.get(file_id)

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

    index = _FakeFileIndex()

    def _session_upload_root(session_id: str) -> Path:
        return tmp_root / 'sessions' / session_id / 'uploads'

    files_api._get_index = lambda: index
    files_api.get_session_uploads_root = _session_upload_root
    return TestClient(app), index, _session_upload_root


def test_files_upload_list_download_delete_with_session_isolation():
    tmp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    try:
        client, index, upload_root = _make_client(tmp_root)

        upload_resp_a = client.post(
            '/files/upload?session_id=session-a',
            files=[('files', ('a.txt', b'hello-a', 'text/plain'))],
        )
        assert upload_resp_a.status_code == 200
        payload_a = upload_resp_a.json()
        file_a = payload_a['files'][0]
        path_a = Path(file_a['stored_path'])
        assert path_a.parent == upload_root('session-a')
        assert path_a.read_bytes() == b'hello-a'

        upload_resp_b = client.post(
            '/files/upload?session_id=session-b',
            files=[('files', ('b.txt', b'hello-b', 'text/plain'))],
        )
        assert upload_resp_b.status_code == 200
        file_b = upload_resp_b.json()['files'][0]

        list_a = client.get('/files?session_id=session-a')
        assert list_a.status_code == 200
        assert [item['id'] for item in list_a.json()['files']] == [file_a['id']]

        list_b = client.get('/files?session_id=session-b')
        assert list_b.status_code == 200
        assert [item['id'] for item in list_b.json()['files']] == [file_b['id']]

        get_cross = client.get(f"/files/{file_a['id']}?session_id=session-b")
        assert get_cross.status_code == 404

        download_a = client.get(f"/files/{file_a['id']}/download?session_id=session-a")
        assert download_a.status_code == 200
        assert download_a.content == b'hello-a'
        assert 'a.txt' in download_a.headers.get('content-disposition', '')

        delete_cross = client.delete(f"/files/{file_a['id']}?session_id=session-b")
        assert delete_cross.status_code == 404
        assert path_a.exists()

        delete_a = client.delete(f"/files/{file_a['id']}?session_id=session-a")
        assert delete_a.status_code == 200
        assert not path_a.exists()
        assert index.get(file_a['id']) is None

        list_a_after = client.get('/files?session_id=session-a')
        assert list_a_after.status_code == 200
        assert list_a_after.json()['files'] == []
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_files_api_query_session_id_filters_records():
    tmp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    try:
        client, _, upload_root = _make_client(tmp_root)

        resp = client.post(
            '/files/upload?session_id=header-session',
            headers={'X-Session-ID': 'ignored-header-session'},
            files=[('files', ('header.txt', b'header-body', 'text/plain'))],
        )
        assert resp.status_code == 200
        file_record = resp.json()['files'][0]
        assert Path(file_record['stored_path']).parent == upload_root('header-session')

        list_resp = client.get('/files?session_id=header-session')
        assert list_resp.status_code == 200
        assert [item['id'] for item in list_resp.json()['files']] == [file_record['id']]
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_files_api_requires_session_id_for_session_scoped_endpoints():
    tmp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    try:
        client, _, _ = _make_client(tmp_root)

        upload_resp = client.post(
            '/files/upload',
            files=[('files', ('missing.txt', b'body', 'text/plain'))],
        )
        assert upload_resp.status_code == 422

        list_resp = client.get('/files')
        assert list_resp.status_code == 422
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_files_validate_and_get_only_see_current_session_records():
    tmp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    try:
        client, _, _ = _make_client(tmp_root)

        file_a = client.post(
            '/files/upload?session_id=session-a',
            files=[('files', ('a.txt', b'a', 'text/plain'))],
        ).json()['files'][0]
        file_b = client.post(
            '/files/upload?session_id=session-b',
            files=[('files', ('b.txt', b'b', 'text/plain'))],
        ).json()['files'][0]

        validate_a = client.post(
            '/files/validate?session_id=session-a',
            json={'file_ids': [file_a['id'], file_b['id'], 'missing']},
        )
        assert validate_a.status_code == 200
        assert validate_a.json()['valid'] == [file_a['id']]
        assert sorted(validate_a.json()['invalid']) == sorted([file_b['id'], 'missing'])

        get_a = client.get(f"/files/{file_a['id']}?session_id=session-a")
        assert get_a.status_code == 200
        assert get_a.json()['file']['id'] == file_a['id']

        get_b_from_a = client.get(f"/files/{file_b['id']}?session_id=session-a")
        assert get_b_from_a.status_code == 404
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
