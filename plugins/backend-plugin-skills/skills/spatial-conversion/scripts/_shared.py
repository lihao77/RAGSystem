from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any


def output_dir() -> Path:
    return Path.cwd()

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


def vector_file(frame: Any, output_name: str | None, subtype: str, title: str, processing: dict[str, Any]) -> dict[str, Any]:
    filename = f"{safe_name(output_name, 'vector-result')}.geojson"
    export = frame.to_crs("EPSG:4326") if frame.crs is not None else frame
    target = output_dir().joinpath(filename)
    target.write_text(export.to_json(drop_id=True), encoding="utf-8")
    return {
        "path": filename,
        "media_type": "application/geo+json",
        "size": target.stat().st_size,
        "metadata": {"spatial": {"crs": "EPSG:4326", "bounds": bounds_wgs84(frame)}, "processing": processing,
                     "subtype": subtype, "title": title},
    }


def raster_file(array: Any, profile: dict[str, Any], output_name: str | None, subtype: str, title: str, processing: dict[str, Any]) -> dict[str, Any]:
    import rasterio

    filename = f"{safe_name(output_name, 'raster-result')}.tif"
    profile = dict(profile)
    profile.update(height=int(array.shape[-2]), width=int(array.shape[-1]), count=int(array.shape[0]) if getattr(array, "ndim", 0) == 3 else 1, dtype=str(array.dtype))
    target = output_dir() / filename
    with rasterio.open(target, "w", **profile) as dst:
        dst.write(array if getattr(array, "ndim", 0) == 3 else array[None, ...])
        bounds = [float(dst.bounds.left), float(dst.bounds.bottom), float(dst.bounds.right), float(dst.bounds.top)]
        crs = crs_text(dst.crs)
    return {
        "path": filename,
        "media_type": "image/tiff",
        "size": target.stat().st_size,
        "metadata": {"spatial": {"crs": crs, "bounds": bounds}, "processing": processing,
                     "subtype": subtype, "title": title},
    }


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str))


