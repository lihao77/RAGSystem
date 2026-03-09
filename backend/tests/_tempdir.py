# -*- coding: utf-8 -*-
"""Test helpers for repository-local temporary directories."""

from __future__ import annotations

import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


_TEMP_ROOT = Path(__file__).resolve().parent / ".tmp"


@contextmanager
def repo_temp_dir(*, prefix: str = "test-") -> Iterator[Path]:
    """Create a temporary directory under the repository test tree."""
    _TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=prefix, dir=_TEMP_ROOT))
    try:
        yield temp_dir
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
