from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from typing import Any


def staging_dir() -> Path:
    raw = os.environ.get("RAGSYSTEM_ARTIFACT_OUTPUT_DIR", "").strip()
    if not raw:
        raise RuntimeError("转换工具需要 execute_skill_script 提供 RAGSYSTEM_ARTIFACT_OUTPUT_DIR")
    path = Path(raw).resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_name(value: str | None, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())[:80].strip(".-")
    return cleaned or fallback


def crs_text(crs: Any) -> str | None:
    if crs is None:
        return None
    try:
        return crs.to_string()
    except AttributeError:
        return str(crs)


def bounds_wgs84(frame: Any) -> list[float]:
    if len(frame) == 0:
        return []
    export = frame.to_crs("EPSG:4326") if frame.crs is not None else frame
    values = [float(v) for v in export.total_bounds]
    if len(values) != 4 or not all(math.isfinite(v) for v in values):
        return []
    return values


def vector_artifact(frame: Any, output_name: str | None, subtype: str, title: str, processing: dict[str, Any]) -> dict[str, Any]:
    filename = f"{safe_name(output_name, 'vector-result')}.geojson"
    export = frame.to_crs("EPSG:4326") if frame.crs is not None else frame
    staging_dir().joinpath(filename).write_text(export.to_json(drop_id=True), encoding="utf-8")
    return {
        "schema_version": 2,
        "kind": "geospatial.vector",
        "subtype": subtype,
        "title": title,
        "assets": [{"asset_id": "data", "role": "data", "filename": filename, "media_type": "application/geo+json", "staged_file": filename}],
        "presentations": [],
        "metadata": {"spatial": {"crs": "EPSG:4326", "bounds": bounds_wgs84(frame)}, "processing": processing},
    }


def raster_artifact(array: Any, profile: dict[str, Any], output_name: str | None, subtype: str, title: str, processing: dict[str, Any]) -> dict[str, Any]:
    import rasterio

    filename = f"{safe_name(output_name, 'raster-result')}.tif"
    profile = dict(profile)
    profile.update(height=int(array.shape[-2]), width=int(array.shape[-1]), count=int(array.shape[0]) if getattr(array, "ndim", 0) == 3 else 1, dtype=str(array.dtype))
    with rasterio.open(staging_dir() / filename, "w", **profile) as dst:
        dst.write(array if getattr(array, "ndim", 0) == 3 else array[None, ...])
        bounds = [float(dst.bounds.left), float(dst.bounds.bottom), float(dst.bounds.right), float(dst.bounds.top)]
        crs = crs_text(dst.crs)
    return {
        "schema_version": 2,
        "kind": "geospatial.raster",
        "subtype": subtype,
        "title": title,
        "assets": [{"asset_id": "data", "role": "data", "filename": filename, "media_type": "image/tiff", "staged_file": filename}],
        "presentations": [],
        "metadata": {"spatial": {"crs": crs, "bounds": bounds}, "processing": processing},
    }


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str))
