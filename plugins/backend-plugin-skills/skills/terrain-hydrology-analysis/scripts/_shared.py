from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any


def output_dir() -> Path:
    return Path.cwd()

def safe_name(value: str | None, fallback: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())[:80].strip(".-")
    return clean or fallback


def crs_text(crs: Any) -> str | None:
    if crs is None:
        return None
    try:
        return crs.to_string()
    except AttributeError:
        return str(crs)


def write_raster(array: Any, source: Any, output_name: str, subtype: str, title: str, processing: dict[str, Any]) -> dict[str, Any]:
    import rasterio

    filename = f"{safe_name(output_name, 'terrain-result')}.tif"
    profile = source.profile.copy()
    nodata = 0 if getattr(array.dtype, "kind", "f") in "ui" else -9999.0
    profile.update(driver="GTiff", dtype=str(array.dtype), count=1, nodata=nodata)
    target_path = output_dir() / filename
    with rasterio.open(target_path, "w", **profile) as target:
        target.write(array, 1)
        bounds = [float(target.bounds.left), float(target.bounds.bottom), float(target.bounds.right), float(target.bounds.top)]
        crs = crs_text(target.crs)
    return {"path": filename, "media_type": "image/tiff", "size": target_path.stat().st_size,
            "metadata": {"spatial": {"crs": crs, "bounds": bounds}, "processing": processing,
                         "subtype": subtype, "title": title}}


def write_vector(frame: Any, output_name: str, subtype: str, title: str, processing: dict[str, Any]) -> dict[str, Any]:
    filename = f"{safe_name(output_name, 'contours')}.geojson"
    export = frame.to_crs("EPSG:4326") if frame.crs is not None else frame
    target_path = output_dir().joinpath(filename)
    target_path.write_text(export.to_json(drop_id=True), encoding="utf-8")
    bounds = [float(value) for value in export.total_bounds] if len(export) else []
    return {"path": filename, "media_type": "application/geo+json", "size": target_path.stat().st_size,
            "metadata": {"spatial": {"crs": "EPSG:4326", "bounds": bounds}, "processing": processing,
                         "subtype": subtype, "title": title}}


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, default=str))


