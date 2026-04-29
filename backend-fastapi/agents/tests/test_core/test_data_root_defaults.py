# -*- coding: utf-8 -*-

import importlib
from pathlib import Path

from utils.yaml_store import load_yaml_file


def test_path_resolution_defaults_data_root_to_user_home(monkeypatch):
    monkeypatch.delenv('RAG_DATA_ROOT', raising=False)
    monkeypatch.setattr(Path, 'home', lambda: Path('C:/Users/tester'))

    import core.path_resolution as path_resolution
    path_resolution = importlib.reload(path_resolution)

    try:
        assert path_resolution.DATA_ROOT == Path('C:/Users/tester/.ragsystem')
        assert path_resolution.CONFIG_ROOT == Path('C:/Users/tester/.ragsystem/config')
    finally:
        monkeypatch.undo()
        importlib.reload(path_resolution)


def test_path_resolution_respects_rag_data_root_override(monkeypatch):
    monkeypatch.setenv('RAG_DATA_ROOT', 'D:/custom-ragsystem')

    import core.path_resolution as path_resolution
    path_resolution = importlib.reload(path_resolution)

    try:
        assert path_resolution.DATA_ROOT == Path('D:/custom-ragsystem')
        assert path_resolution.CONFIG_ROOT == Path('D:/custom-ragsystem/config')
    finally:
        monkeypatch.undo()
        importlib.reload(path_resolution)


def test_vectorizer_config_default_path_uses_config_root(monkeypatch, tmp_path):
    monkeypatch.setenv('RAG_DATA_ROOT', str(tmp_path / 'data-root'))

    import core.path_resolution as path_resolution
    path_resolution = importlib.reload(path_resolution)
    import vector_store.vectorizer_config as vectorizer_config
    vectorizer_config = importlib.reload(vectorizer_config)

    try:
        assert vectorizer_config.DEFAULT_CONFIG_PATH == path_resolution.CONFIG_ROOT / 'vector_store' / 'vectorizers.yaml'
    finally:
        monkeypatch.undo()
        importlib.reload(path_resolution)
        importlib.reload(vectorizer_config)


def test_app_config_seed_uses_managed_database_default():
    seed_path = Path(__file__).resolve().parents[3] / 'config' / 'yaml' / 'config.yaml.example'
    seed = load_yaml_file(seed_path, default_factory=dict)

    assert seed['vector_store']['sqlite_vec']['database_path'] == ''
