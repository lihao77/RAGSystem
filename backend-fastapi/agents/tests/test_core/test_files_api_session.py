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
    upload_root = tmp_root / 'uploads'

    files_api._get_index = lambda: index
    files_api.get_uploads_root = lambda: upload_root
    return TestClient(app), index, upload_root


def test_files_upload_list_download_delete_global_pool():
    tmp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    try:
        client, index, upload_root = _make_client(tmp_root)

        upload_resp_a = client.post(
            '/files/upload',
            files=[('files', ('a.txt', b'hello-a', 'text/plain'))],
        )
        assert upload_resp_a.status_code == 200
        file_a = upload_resp_a.json()['files'][0]
        path_a = Path(file_a['stored_path'])
        assert path_a.parent == upload_root
        assert path_a.read_bytes() == b'hello-a'

        upload_resp_b = client.post(
            '/files/upload',
            files=[('files', ('b.txt', b'hello-b', 'text/plain'))],
        )
        assert upload_resp_b.status_code == 200
        file_b = upload_resp_b.json()['files'][0]

        list_resp = client.get('/files')
        assert list_resp.status_code == 200
        assert [item['id'] for item in list_resp.json()['files']] == [file_a['id'], file_b['id']]

        get_resp = client.get(f"/files/{file_a['id']}")
        assert get_resp.status_code == 200
        assert get_resp.json()['file']['id'] == file_a['id']

        download_resp = client.get(f"/files/{file_a['id']}/download")
        assert download_resp.status_code == 200
        assert download_resp.content == b'hello-a'
        assert 'a.txt' in download_resp.headers.get('content-disposition', '')

        delete_resp = client.delete(f"/files/{file_a['id']}")
        assert delete_resp.status_code == 200
        assert not path_a.exists()
        assert index.get(file_a['id']) is None

        list_after = client.get('/files')
        assert list_after.status_code == 200
        assert [item['id'] for item in list_after.json()['files']] == [file_b['id']]
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_files_validate_global_records():
    tmp_root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    try:
        client, _, _ = _make_client(tmp_root)

        file_a = client.post(
            '/files/upload',
            files=[('files', ('a.txt', b'a', 'text/plain'))],
        ).json()['files'][0]
        file_b = client.post(
            '/files/upload',
            files=[('files', ('b.txt', b'b', 'text/plain'))],
        ).json()['files'][0]

        validate_resp = client.post(
            '/files/validate',
            json={'file_ids': [file_a['id'], file_b['id'], 'missing']},
        )
        assert validate_resp.status_code == 200
        assert sorted(validate_resp.json()['valid']) == sorted([file_a['id'], file_b['id']])
        assert validate_resp.json()['invalid'] == ['missing']
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
