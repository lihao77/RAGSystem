#!/usr/bin/env python3
"""Inspect bounded NetCDF metadata and emit one JSON object."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any


ALLOWED_SUFFIXES = {".nc", ".nc4", ".cdf"}
MAX_DIMENSIONS = 500
MAX_VARIABLES = 200
MAX_GLOBAL_ATTRIBUTES = 100
MAX_ATTRIBUTE_ITEMS = 50
MAX_ATTRIBUTE_TEXT = 2_048
MAX_COORDINATE_VARIABLES = 32
MAX_COORDINATE_ELEMENTS = 500_000
MAX_COORDINATE_SKIP_DETAILS = 50

SELECTED_VARIABLE_ATTRIBUTES = (
    "units",
    "long_name",
    "standard_name",
    "axis",
    "calendar",
)

COORDINATE_NAMES = {
    "depth",
    "lat",
    "latitude",
    "lev",
    "level",
    "lon",
    "longitude",
    "time",
    "x",
    "y",
    "z",
}

COORDINATE_STANDARD_NAMES = {
    "depth",
    "height",
    "latitude",
    "longitude",
    "projection_x_coordinate",
    "projection_y_coordinate",
    "time",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="检查本地 NetCDF 文件的维度、变量、坐标范围和时间范围。"
    )
    parser.add_argument("--file", required=True, help="现有 .nc、.nc4 或 .cdf 文件的绝对路径")
    return parser.parse_args()


def validate_file(raw_path: str) -> Path:
    file_path = Path(raw_path)
    if not file_path.is_absolute():
        raise ValueError("--file 必须是绝对路径")
    if file_path.suffix.lower() not in ALLOWED_SUFFIXES:
        raise ValueError("--file 只支持 .nc、.nc4 或 .cdf 文件")
    if not file_path.exists():
        raise ValueError(f"文件不存在: {file_path}")
    if not file_path.is_file():
        raise ValueError(f"路径不是文件: {file_path}")
    return file_path.resolve(strict=True)


def limited_text(value: str) -> tuple[str, bool]:
    if len(value) <= MAX_ATTRIBUTE_TEXT:
        return value, False
    return value[:MAX_ATTRIBUTE_TEXT], True


def normalize_attribute(value: Any, np: Any) -> tuple[Any, bool]:
    if value is None or isinstance(value, (bool, int)):
        return value, False
    if isinstance(value, float):
        return (value, False) if math.isfinite(value) else (str(value), False)
    if isinstance(value, str):
        return limited_text(value)
    if isinstance(value, bytes):
        return limited_text(value.decode("utf-8", errors="replace"))
    if isinstance(value, np.generic):
        return normalize_attribute(value.item(), np)
    if isinstance(value, np.ndarray):
        items = value.reshape(-1).tolist()
        return normalize_sequence(items, np)
    if isinstance(value, (list, tuple)):
        return normalize_sequence(value, np)
    return limited_text(str(value))


def normalize_sequence(values: Any, np: Any) -> tuple[list[Any], bool]:
    output = []
    truncated = len(values) > MAX_ATTRIBUTE_ITEMS
    for value in values[:MAX_ATTRIBUTE_ITEMS]:
        normalized, item_truncated = normalize_attribute(value, np)
        output.append(normalized)
        truncated = truncated or item_truncated
    return output, truncated


def read_selected_attributes(variable: Any, np: Any) -> tuple[dict[str, Any], bool]:
    attributes = {}
    truncated = False
    available = set(variable.ncattrs())
    for name in SELECTED_VARIABLE_ATTRIBUTES:
        if name not in available:
            continue
        value, value_truncated = normalize_attribute(variable.getncattr(name), np)
        attributes[name] = value
        truncated = truncated or value_truncated
    return attributes, truncated


def attribute_text(variable: Any, name: str) -> str:
    try:
        value = variable.getncattr(name)
    except (AttributeError, KeyError):
        return ""
    return str(value).strip().lower()


def is_coordinate_variable(name: str, variable: Any, np: Any) -> bool:
    try:
        dtype = np.dtype(variable.dtype)
    except (TypeError, ValueError):
        return False
    if not np.issubdtype(dtype, np.number) or np.issubdtype(dtype, np.complexfloating):
        return False

    normalized_name = name.strip().lower()
    axis = attribute_text(variable, "axis")
    standard_name = attribute_text(variable, "standard_name")
    units = attribute_text(variable, "units")
    return (
        normalized_name in COORDINATE_NAMES
        or axis in {"t", "x", "y", "z"}
        or standard_name in COORDINATE_STANDARD_NAMES
        or units in {"degree_north", "degrees_north", "degree_east", "degrees_east"}
        or (len(variable.dimensions) == 1 and variable.dimensions[0] == name)
    )


def variable_size(variable: Any) -> int:
    return math.prod(variable.shape) if variable.shape else 1


def numeric_range(variable: Any, np: Any) -> tuple[dict[str, Any] | None, str | None]:
    size = variable_size(variable)
    if size > MAX_COORDINATE_ELEMENTS:
        return None, f"元素数量 {size} 超过限制 {MAX_COORDINATE_ELEMENTS}"
    if size == 0:
        return None, "坐标变量为空"

    values = np.ma.asarray(variable[...])
    compressed = values.compressed()
    if compressed.size == 0:
        return None, "坐标变量没有有效值"
    if np.issubdtype(compressed.dtype, np.inexact):
        compressed = compressed[np.isfinite(compressed)]
    if compressed.size == 0:
        return None, "坐标变量没有有限数值"

    minimum = compressed.min().item()
    maximum = compressed.max().item()
    result = {
        "min": minimum,
        "max": maximum,
        "value_count": int(compressed.size),
    }
    if len(variable.dimensions) == 1 and compressed.size == values.size and compressed.size >= 2:
        ordered = np.asarray(compressed, dtype=float).reshape(-1)
        differences = np.diff(ordered)
        if np.all(np.isfinite(ordered)) and (np.all(differences > 0) or np.all(differences < 0)):
            edges = np.empty(ordered.size + 1, dtype=float)
            edges[1:-1] = (ordered[:-1] + ordered[1:]) / 2
            edges[0] = ordered[0] - differences[0] / 2
            edges[-1] = ordered[-1] + differences[-1] / 2
            result["edge_min"] = float(np.min(edges))
            result["edge_max"] = float(np.max(edges))
    return result, None


def date_text(value: Any) -> str:
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def decode_time_range(
    name: str,
    variable: Any,
    coordinate_range: dict[str, Any],
    num2date: Any,
) -> dict[str, Any] | None:
    units = attribute_text(variable, "units")
    if " since " not in f" {units} ":
        return None
    calendar = attribute_text(variable, "calendar") or "standard"
    try:
        dates = num2date(
            [coordinate_range["min"], coordinate_range["max"]],
            units=units,
            calendar=calendar,
            only_use_cftime_datetimes=False,
            only_use_python_datetimes=False,
        )
    except (TypeError, ValueError, OverflowError):
        return None
    return {
        "coordinate": name,
        "start": date_text(dates[0]),
        "end": date_text(dates[1]),
        "units": units,
        "calendar": calendar,
    }


def coordinate_axis(name: str, variable: Any) -> str | None:
    normalized_name = name.strip().lower()
    axis = attribute_text(variable, "axis")
    standard_name = attribute_text(variable, "standard_name")
    units = attribute_text(variable, "units")
    if (
        normalized_name in {"lon", "longitude"}
        or axis == "x"
        or standard_name == "longitude"
        or units in {"degree_east", "degrees_east"}
    ):
        return "longitude"
    if (
        normalized_name in {"lat", "latitude"}
        or axis == "y"
        or standard_name == "latitude"
        or units in {"degree_north", "degrees_north"}
    ):
        return "latitude"
    return None


def build_footprint_file(
    variable_items: list[tuple[str, Any]],
    coordinate_ranges: dict[str, dict[str, Any]],
    filename: str,
) -> dict[str, Any] | None:
    axes: dict[str, tuple[str, dict[str, Any]]] = {}
    for name, variable in variable_items:
        axis = coordinate_axis(name, variable)
        if axis and name in coordinate_ranges and axis not in axes:
            axes[axis] = (name, coordinate_ranges[name])
    if "longitude" not in axes or "latitude" not in axes:
        return None

    longitude_name, longitude = axes["longitude"]
    latitude_name, latitude = axes["latitude"]
    west, east = float(longitude.get("edge_min", longitude["min"])), float(longitude.get("edge_max", longitude["max"]))
    south, north = float(latitude.get("edge_min", latitude["min"])), float(latitude.get("edge_max", latitude["max"]))
    coordinate_west, coordinate_east = float(longitude["min"]), float(longitude["max"])
    coordinate_south, coordinate_north = float(latitude["min"]), float(latitude["max"])
    if west == east or south == north:
        return None
    ring = [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
    ]
    geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [ring]},
                "properties": {
                    "name": filename,
                    "longitude_coordinate": longitude_name,
                    "latitude_coordinate": latitude_name,
                    "west": west,
                    "east": east,
                    "south": south,
                    "north": north,
                    "coordinate_west": coordinate_west,
                    "coordinate_east": coordinate_east,
                    "coordinate_south": coordinate_south,
                    "coordinate_north": coordinate_north,
                },
            }
        ],
    }
    pathname = "netcdf-footprint.geojson"
    output_path = Path.cwd() / pathname
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(geojson, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    return {
        "file": {"path": pathname, "media_type": "application/geo+json", "size": output_path.stat().st_size,
                 "metadata": {
            "spatial": {"crs": "EPSG:4326", "bounds": [west, south, east, north]},
            "feature_count": 1,
        }},
        "subtype": "dataset-footprint",
        "title": f"{filename} 数据覆盖范围",
    }


def inspect_file(file_path: Path, Dataset: Any, num2date: Any, np: Any) -> dict[str, Any]:
    attribute_values_truncated = False
    with Dataset(str(file_path), mode="r") as dataset:
        dimension_items = list(dataset.dimensions.items())
        variable_items = list(dataset.variables.items())
        global_attribute_names = list(dataset.ncattrs())

        dimensions = {}
        for name, dimension in dimension_items[:MAX_DIMENSIONS]:
            dimensions[name] = {
                "size": len(dimension),
                "unlimited": bool(dimension.isunlimited()),
            }

        variables = []
        for name, variable in variable_items[:MAX_VARIABLES]:
            attributes, attrs_truncated = read_selected_attributes(variable, np)
            attribute_values_truncated = attribute_values_truncated or attrs_truncated
            variables.append(
                {
                    "name": name,
                    "dimensions": list(variable.dimensions),
                    "shape": list(variable.shape),
                    "dtype": str(variable.dtype),
                    "attributes": attributes,
                }
            )

        coordinate_ranges = {}
        coordinate_range_skips = {}
        time_range = None
        coordinate_count = 0
        coordinate_ranges_truncated = False
        for name, variable in variable_items:
            if not is_coordinate_variable(name, variable, np):
                continue
            if coordinate_count >= MAX_COORDINATE_VARIABLES:
                coordinate_ranges_truncated = True
                if len(coordinate_range_skips) < MAX_COORDINATE_SKIP_DETAILS:
                    coordinate_range_skips[name] = "坐标变量数量超过检查限制"
                continue
            coordinate_count += 1
            try:
                value_range, skip_reason = numeric_range(variable, np)
            except (IndexError, OSError, RuntimeError, TypeError, ValueError) as error:
                value_range, skip_reason = None, f"读取失败: {error}"
            if value_range is None:
                if len(coordinate_range_skips) < MAX_COORDINATE_SKIP_DETAILS:
                    coordinate_range_skips[name] = skip_reason or "无法读取范围"
                continue
            units = attribute_text(variable, "units")
            if units:
                value_range["units"] = units
            coordinate_ranges[name] = value_range
            if time_range is None and (
                name.strip().lower() == "time"
                or attribute_text(variable, "axis") == "t"
                or attribute_text(variable, "standard_name") == "time"
            ):
                time_range = decode_time_range(name, variable, value_range, num2date)

        global_attributes = {}
        for name in global_attribute_names[:MAX_GLOBAL_ATTRIBUTES]:
            value, value_truncated = normalize_attribute(dataset.getncattr(name), np)
            global_attributes[name] = value
            attribute_values_truncated = attribute_values_truncated or value_truncated

        data = {
            "file": str(file_path),
            "filename": file_path.name,
            "size_bytes": file_path.stat().st_size,
            "format": str(dataset.file_format),
            "data_model": str(dataset.data_model),
            "dimensions": dimensions,
            "variables": variables,
            "coordinate_ranges": coordinate_ranges,
            "coordinate_range_skips": coordinate_range_skips,
            "time_range": time_range,
            "global_attributes": global_attributes,
            "truncated": {
                "dimensions": len(dimension_items) > MAX_DIMENSIONS,
                "variables": len(variable_items) > MAX_VARIABLES,
                "global_attributes": len(global_attribute_names) > MAX_GLOBAL_ATTRIBUTES,
                "attribute_values": attribute_values_truncated,
                "coordinate_ranges": coordinate_ranges_truncated,
            },
        }
        file = build_footprint_file(variable_items, coordinate_ranges, file_path.name)
        model_variables = [
            {
                "name": item["name"],
                "dimensions": item["dimensions"],
                "shape": item["shape"],
                "units": item["attributes"].get("units", ""),
                "long_name": item["attributes"].get("long_name", ""),
            }
            for item in variables
        ]
        return {
            "success": True,
            "summary": f"读取到 {len(dimension_items)} 个维度和 {len(variable_items)} 个变量",
            "data": data,
            "metadata": {
                "sample": {
                    "filename": file_path.name,
                    "variables": model_variables,
                    "coordinate_ranges": coordinate_ranges,
                    "time_range": time_range,
                }
            },
            **({"file": file} if file else {}),
        }


def main() -> int:
    args = parse_args()
    try:
        file_path = validate_file(args.file)
    except (OSError, ValueError) as error:
        print(f"inspect_nc: {error}", file=sys.stderr)
        return 2

    try:
        import numpy as np
        from netCDF4 import Dataset, num2date
    except ImportError:
        print(
            "inspect_nc: 缺少 netCDF4；请先执行 "
            "python -m pip install -r "
            "plugins/backend-plugin-skills/skills/nc-analysis/requirements.txt",
            file=sys.stderr,
        )
        return 3

    try:
        result = inspect_file(file_path, Dataset, num2date, np)
        json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
        sys.stdout.write("\n")
        return 0
    except (OSError, ValueError) as error:
        print(f"inspect_nc: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"inspect_nc: 无法读取 NetCDF 文件: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

