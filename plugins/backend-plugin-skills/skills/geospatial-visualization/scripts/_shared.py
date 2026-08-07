"""Shared file-result helpers for geospatial visualization."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def output_dir() -> Path:
    return Path.cwd()

def safe_name(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())[:80].strip(".-")
    return cleaned or fallback


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str))


