"""Common workspace-file helpers for GeoJSON analysis results."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def safe_name(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())[:80].strip(".-")
    return cleaned or fallback


def bounds(feature_collection: dict[str, Any]) -> list[float]:
    points: list[tuple[float, float]] = []

    def visit(value: Any) -> None:
        if isinstance(value, list) and value and isinstance(value[0], (int, float)):
            if len(value) >= 2:
                points.append((float(value[0]), float(value[1])))
            return
        if isinstance(value, list):
            for child in value:
                visit(child)

    for feature in feature_collection.get("features", []):
        visit((feature.get("geometry") or {}).get("coordinates", []))
    if not points:
        return []
    lngs, lats = zip(*points)
    west, south, east, north = min(lngs), min(lats), max(lngs), max(lats)
    if west == east:
        west -= 0.00001
        east += 0.00001
    if south == north:
        south -= 0.00001
        north += 0.00001
    return [west, south, east, north]


def write_file(
    data: dict[str, Any],
    output_name: str,
    subtype: str,
    title: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    filename = f"{safe_name(output_name, 'geojson-result')}.geojson"
    target = Path.cwd() / filename
    target.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    return {
        "path": filename,
        "media_type": "application/geo+json",
        "size": target.stat().st_size,
        "metadata": {
            "spatial": {"crs": "EPSG:4326", "bounds": bounds(data)},
            "subtype": subtype,
            "title": title,
            **metadata,
        },
    }
