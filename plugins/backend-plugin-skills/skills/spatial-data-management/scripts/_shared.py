"""Shared IO and generic file-result helpers for spatial data management."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any


def load_geopandas() -> Any:
    try:
        import geopandas as gpd
    except ImportError as error:
        raise RuntimeError("缺少 GeoPandas；请安装本 Skill 的 requirements.txt") from error
    return gpd


def load_rasterio() -> Any:
    try:
        import rasterio
    except ImportError as error:
        raise RuntimeError("缺少 Rasterio；请安装本 Skill 的 requirements.txt") from error
    return rasterio


def output_dir() -> Path:
    return Path.cwd()

def safe_name(value: str | None, fallback: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())[:80].strip(".-")
    return name or fallback


def crs_text(crs: Any) -> str | None:
    if crs is None:
        return None
    try:
        return crs.to_string()
    except AttributeError:
        return str(crs)


def finite_bounds(values: Any) -> list[float]:
    try:
        result = [float(value) for value in values]
    except (TypeError, ValueError):
        return []
    return result if len(result) == 4 and all(math.isfinite(value) for value in result) else []


def wgs84_bounds(frame: Any) -> list[float]:
    if getattr(frame, "crs", None) is None:
        return []
    export = frame
    try:
        export = export.to_crs("EPSG:4326")
    except Exception:
        return []
    if len(export) == 0:
        return []
    bounds = finite_bounds(export.total_bounds)
    if len(bounds) != 4:
        return []
    west, south, east, north = bounds
    if west == east:
        west -= 1e-5
        east += 1e-5
    if south == north:
        south -= 1e-5
        north += 1e-5
    return [west, south, east, north]


def describe_frame(frame: Any) -> dict[str, Any]:
    geometry_name = frame.geometry.name
    bounds = finite_bounds(frame.total_bounds) if len(frame) else []
    return {
        "feature_count": int(len(frame)),
        "crs": crs_text(frame.crs),
        "bounds": bounds,
        "geometry_types": {
            str(key): int(value)
            for key, value in frame.geometry.geom_type.value_counts(dropna=False).items()
        },
        "fields": [str(column) for column in frame.columns if column != geometry_name],
        "numeric_fields": [
            str(column)
            for column in frame.select_dtypes(include="number").columns
            if column != geometry_name
        ],
    }


def describe_dataset(dataset: Any) -> dict[str, Any]:
    return {
        "driver": dataset.driver,
        "width": int(dataset.width),
        "height": int(dataset.height),
        "bands": int(dataset.count),
        "dtype": list(dataset.dtypes),
        "nodata": dataset.nodata,
        "crs": crs_text(dataset.crs),
        "bounds": [
            float(dataset.bounds.left),
            float(dataset.bounds.bottom),
            float(dataset.bounds.right),
            float(dataset.bounds.top),
        ],
        "resolution": [float(dataset.res[0]), float(dataset.res[1])],
    }


def write_vector_file(
    frame: Any,
    output_name: str | None,
    subtype: str,
    title: str,
    processing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    output_root = output_dir()
    filename = f"{safe_name(output_name, 'vector-result')}.geojson"
    path = output_root / filename
    export = frame.to_crs("EPSG:4326") if frame.crs is not None else frame
    # JSON serialization remains valid for an empty selection and avoids driver-specific errors.
    path.write_text(export.to_json(drop_id=True), encoding="utf-8")
    return {
        "path": filename,
        "media_type": "application/geo+json",
        "size": path.stat().st_size,
        "metadata": {
            "spatial": {"crs": "EPSG:4326" if frame.crs is not None else None, "bounds": wgs84_bounds(frame)},
            "processing": processing or {},
            "subtype": subtype,
            "title": title,
        },
    }


def write_table_file(
    rows: list[dict[str, Any]],
    output_name: str | None,
    subtype: str,
    title: str,
    processing: dict[str, Any] | None = None,
    source_bounds: list[float] | None = None,
) -> dict[str, Any]:
    output_root = output_dir()
    filename = f"{safe_name(output_name, 'table-result')}.json"
    path = output_root / filename
    path.write_text(json.dumps(rows, ensure_ascii=False, allow_nan=False, default=str), encoding="utf-8")
    return {
        "path": filename,
        "media_type": "application/json",
        "size": path.stat().st_size,
        "metadata": {
            "spatial": {"crs": "EPSG:4326", "bounds": source_bounds or []},
            "processing": processing or {},
            "subtype": subtype,
            "title": title,
        },
    }


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str))


