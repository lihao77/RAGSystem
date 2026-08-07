"""Shared IO and File V2 helpers for vector spatial analysis."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any


def load_geopandas():
    try:
        import geopandas as gpd
        import pandas as pd
    except ImportError as error:
        raise RuntimeError("缺少 GeoPandas 依赖；请安装本 Skill 的 requirements.txt") from error
    return gpd, pd


def output_dir() -> Path:
    return Path.cwd()

def safe_name(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())[:80].strip(".-")
    return cleaned or fallback


def crs_name(crs: Any) -> str | None:
    if crs is None:
        return None
    try:
        return crs.to_string()
    except AttributeError:
        return str(crs)


def summarize(gdf: Any) -> dict[str, Any]:
    geometry_name = gdf.geometry.name
    geometry_types = {
        str(key): int(value)
        for key, value in gdf.geometry.geom_type.value_counts(dropna=False).items()
    }
    raw_bounds = [float(value) for value in gdf.total_bounds] if len(gdf) else []
    bounds = raw_bounds if all(math.isfinite(value) for value in raw_bounds) else []
    return {
        "feature_count": int(len(gdf)),
        "crs": crs_name(gdf.crs),
        "bounds": bounds,
        "geometry_types": geometry_types,
        "fields": [str(column) for column in gdf.columns if column != geometry_name],
    }


def _wgs84_bounds(gdf: Any) -> list[float]:
    export = gdf
    if export.crs is not None:
        try:
            export = export.to_crs("EPSG:4326")
        except Exception:
            pass
    raw = [float(value) for value in export.total_bounds] if len(export) else []
    if len(raw) != 4 or not all(math.isfinite(value) for value in raw):
        return []
    west, south, east, north = raw
    if west == east:
        west -= 0.00001
        east += 0.00001
    if south == north:
        south -= 0.00001
        north += 0.00001
    return [west, south, east, north]


def write_geojson_file(
    gdf: Any,
    output_name: str,
    subtype: str,
    title: str,
    processing: dict[str, Any],
) -> dict[str, Any]:
    output_root = output_dir()
    filename = f"{safe_name(output_name, 'vector-result')}.geojson"
    path = output_root / filename
    export = gdf
    if export.crs is not None:
        try:
            export = export.to_crs("EPSG:4326")
        except Exception:
            pass
    # to_json also handles a valid zero-feature selection, which some drivers reject.
    path.write_text(export.to_json(drop_id=True), encoding="utf-8")
    return {
        "file": {"path": filename, "media_type": "application/geo+json", "size": path.stat().st_size,
                 "metadata": {"spatial": {"crs": "EPSG:4326", "bounds": _wgs84_bounds(gdf)}, "processing": processing}},
        "subtype": subtype,
        "title": title,
    }


def write_table_file(
    rows: list[dict[str, Any]],
    output_name: str,
    subtype: str,
    title: str,
    processing: dict[str, Any],
    source_bounds: list[float] | None = None,
) -> dict[str, Any]:
    output_root = output_dir()
    filename = f"{safe_name(output_name, 'table-result')}.json"
    path = output_root / filename
    path.write_text(json.dumps(rows, ensure_ascii=False, allow_nan=False, default=str), encoding="utf-8")
    return {
        "file": {"path": filename, "media_type": "application/json", "size": path.stat().st_size,
                 "metadata": {"spatial": {"crs": "EPSG:4326", "bounds": source_bounds or []}, "processing": processing}},
        "subtype": subtype,
        "title": title,
    }


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str))


