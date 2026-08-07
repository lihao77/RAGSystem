"""Shared contracts for raster-spatial-analysis scripts."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


def load_rasterio():
    try:
        import rasterio
    except ImportError as error:
        raise RuntimeError("缺少 Rasterio 依赖；请安装本 Skill 的 requirements.txt") from error
    return rasterio


def require_staging() -> Path:
    raw = os.environ.get("RAGSYSTEM_ARTIFACT_OUTPUT_DIR", "").strip()
    if not raw:
        raise RuntimeError("脚本需要 execute_skill_script 提供 RAGSYSTEM_ARTIFACT_OUTPUT_DIR")
    output = Path(raw).resolve()
    output.mkdir(parents=True, exist_ok=True)
    return output


def safe_name(value: str | None, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())[:80].strip(".-")
    return cleaned or fallback


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str))


def describe_raster(dataset: Any) -> dict[str, Any]:
    return {
        "driver": dataset.driver,
        "width": int(dataset.width),
        "height": int(dataset.height),
        "bands": int(dataset.count),
        "dtype": list(dataset.dtypes),
        "nodata": dataset.nodata,
        "crs": dataset.crs.to_string() if dataset.crs else None,
        "bounds": [float(value) for value in dataset.bounds],
        "resolution": [float(value) for value in dataset.res],
    }


def _artifact(kind: str, subtype: str, title: str, metadata: dict[str, Any], filename: str, media_type: str) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "kind": kind,
        "subtype": subtype,
        "title": title,
        "assets": [{
            "asset_id": "data",
            "role": "data",
            "filename": filename,
            "media_type": media_type,
            "staged_file": filename,
        }],
        "presentations": [],
        "metadata": metadata,
    }


def write_raster_artifact(dataset: Any, output_name: str | None, subtype: str, title: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    output_dir = require_staging()
    filename = f"{safe_name(output_name, 'raster-result')}.tif"
    path = output_dir / filename
    profile = dataset.profile.copy()
    with load_rasterio().open(path, "w", **profile) as target:
        for index in range(1, dataset.count + 1):
            target.write(dataset.read(index), index)
        spatial = {
            "crs": target.crs.to_string() if target.crs else None,
            "bounds": [float(value) for value in target.bounds],
        }
    return _artifact("geospatial.raster", subtype, title, {"spatial": spatial, **(metadata or {})}, filename, "image/tiff")


def write_raster_array(array: Any, profile: dict[str, Any], output_name: str | None, subtype: str, title: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    """Stage a 2D or 3D array as a GeoTIFF Artifact V2."""
    values = array
    ndim = getattr(values, "ndim", 0)
    if ndim not in (2, 3):
        raise ValueError("栅格结果必须是二维或三维数组")
    output_dir = require_staging()
    filename = f"{safe_name(output_name or subtype, 'raster-result')}.tif"
    path = output_dir / filename
    profile = dict(profile)
    profile.update({
        "height": int(values.shape[-2]),
        "width": int(values.shape[-1]),
        "count": int(values.shape[0]) if ndim == 3 else 1,
        "dtype": str(values.dtype),
    })
    with load_rasterio().open(path, "w", **profile) as target:
        target.write(values if ndim == 3 else values[None, ...])
        spatial = {
            "crs": target.crs.to_string() if target.crs else None,
            "bounds": [float(value) for value in target.bounds],
        }
    return _artifact("geospatial.raster", subtype, title, {"spatial": spatial, **(metadata or {})}, filename, "image/tiff")


def write_json_artifact(value: Any, output_name: str | None, subtype: str, title: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    """Stage structured tabular/statistical output as JSON Artifact V2."""
    output_dir = require_staging()
    filename = f"{safe_name(output_name or subtype, 'table-result')}.json"
    (output_dir / filename).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str), encoding="utf-8")
    return _artifact("table.dataset", subtype, title, metadata or {}, filename, "application/json")
