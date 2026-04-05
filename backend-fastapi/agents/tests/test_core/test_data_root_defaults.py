# -*- coding: utf-8 -*-

import importlib
from pathlib import Path


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
