"""Shared workspace-file contracts for raster-spatial-analysis scripts."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def load_rasterio():
    try:
        import rasterio
    except ImportError as error:
        raise RuntimeError("缺少 Rasterio 依赖；请安装本 Skill 的 requirements.txt") from error
    return rasterio


def output_dir() -> Path:
    return Path.cwd()

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


def _file(kind: str, subtype: str, title: str, metadata: dict[str, Any], filename: str, media_type: str) -> dict[str, Any]:
    return {
        "file": {"path": filename, "media_type": media_type, "size": (output_dir() / filename).stat().st_size,
                 "metadata": metadata},
        "kind": kind,
        "subtype": subtype,
        "title": title,
    }


def write_raster_file(dataset: Any, output_name: str | None, subtype: str, title: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    output_root = output_dir()
    filename = f"{safe_name(output_name, 'raster-result')}.tif"
    path = output_root / filename
    profile = dataset.profile.copy()
    with load_rasterio().open(path, "w", **profile) as target:
        for index in range(1, dataset.count + 1):
            target.write(dataset.read(index), index)
        spatial = {
            "crs": target.crs.to_string() if target.crs else None,
            "bounds": [float(value) for value in target.bounds],
        }
    return _file("geospatial.raster", subtype, title, {"spatial": spatial, **(metadata or {})}, filename, "image/tiff")


def write_raster_array(array: Any, profile: dict[str, Any], output_name: str | None, subtype: str, title: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    """Stage a 2D or 3D array as a GeoTIFF File V2."""
    values = array
    ndim = getattr(values, "ndim", 0)
    if ndim not in (2, 3):
        raise ValueError("栅格结果必须是二维或三维数组")
    output_root = output_dir()
    filename = f"{safe_name(output_name or subtype, 'raster-result')}.tif"
    path = output_root / filename
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
    return _file("geospatial.raster", subtype, title, {"spatial": spatial, **(metadata or {})}, filename, "image/tiff")


def write_json_file(value: Any, output_name: str | None, subtype: str, title: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    """Stage structured tabular/statistical output as JSON File V2."""
    output_root = output_dir()
    filename = f"{safe_name(output_name or subtype, 'table-result')}.json"
    (output_root / filename).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str), encoding="utf-8")
    return _file("table.dataset", subtype, title, metadata or {}, filename, "application/json")


