"""Shared Artifact V2 helpers for geospatial visualization."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


def require_staging() -> Path:
    raw = os.environ.get("RAGSYSTEM_ARTIFACT_OUTPUT_DIR", "").strip()
    if not raw:
        raise RuntimeError("脚本需要 execute_skill_script 提供 RAGSYSTEM_ARTIFACT_OUTPUT_DIR")
    path = Path(raw).resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_name(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())[:80].strip(".-")
    return cleaned or fallback


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str))
