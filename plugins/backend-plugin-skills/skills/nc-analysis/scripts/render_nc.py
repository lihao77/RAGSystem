#!/usr/bin/env python3
"""Render a bounded regular NetCDF variable slice as a GeoJSON Artifact."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


ALLOWED_SUFFIXES = {".nc", ".nc4", ".cdf"}
MAX_OUTPUT_CELLS = 5_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="将规则经纬度网格变量切片生成 GeoJSON 海洋图层。")
    parser.add_argument("--file", required=True, help="现有 .nc、.nc4 或 .cdf 文件的绝对路径")
    parser.add_argument("--variable", required=True, help="要渲染的数值变量名")
    parser.add_argument("--time-index", type=int, default=0, help="时间维索引，默认 0")
    parser.add_argument("--depth-index", type=int, default=0, help="深度维索引，默认 0")
    parser.add_argument("--max-cells", type=int, default=MAX_OUTPUT_CELLS, help="输出网格上限")
    return parser.parse_args()


def validate_file(raw_path: str) -> Path:
    file_path = Path(raw_path)
    if not file_path.is_absolute():
        raise ValueError("--file 必须是绝对路径")
    if file_path.suffix.lower() not in ALLOWED_SUFFIXES:
        raise ValueError("--file 只支持 .nc、.nc4 或 .cdf 文件")
    if not file_path.is_file():
        raise ValueError(f"文件不存在或不是文件: {file_path}")
    return file_path.resolve(strict=True)


def attribute_text(variable: Any, name: str) -> str:
    try:
        return str(variable.getncattr(name)).strip()
    except (AttributeError, KeyError):
        return ""


def coordinate_axis(name: str, variable: Any) -> str | None:
    normalized = name.strip().lower()
    axis = attribute_text(variable, "axis").lower()
    standard_name = attribute_text(variable, "standard_name").lower()
    units = attribute_text(variable, "units").lower()
    if normalized in {"lon", "longitude"} or axis == "x" or standard_name == "longitude" or units in {"degree_east", "degrees_east"}:
        return "longitude"
    if normalized in {"lat", "latitude"} or axis == "y" or standard_name == "latitude" or units in {"degree_north", "degrees_north"}:
        return "latitude"
    if normalized == "time" or axis == "t" or standard_name == "time":
        return "time"
    if normalized in {"depth", "lev", "level", "z"} or axis == "z" or standard_name in {"depth", "height"}:
        return "depth"
    return None


def find_coordinate(dataset: Any, axis: str) -> tuple[str, Any]:
    for name, variable in dataset.variables.items():
        if coordinate_axis(name, variable) == axis:
            return name, variable
    raise ValueError(f"无法识别 {axis} 坐标变量")


def coordinate_edges(values: Any, np: Any) -> Any:
    array = np.asarray(values, dtype=float).reshape(-1)
    if array.size < 2:
        raise ValueError("经纬度坐标至少需要两个值")
    if not np.all(np.isfinite(array)):
        raise ValueError("经纬度坐标包含非有限值")
    differences = np.diff(array)
    if not (np.all(differences > 0) or np.all(differences < 0)):
        raise ValueError("当前仅支持单调的一维规则经纬度坐标")
    edges = np.empty(array.size + 1, dtype=float)
    edges[1:-1] = (array[:-1] + array[1:]) / 2
    edges[0] = array[0] - differences[0] / 2
    edges[-1] = array[-1] + differences[-1] / 2
    return edges


def dimension_index(name: str, size: int, dataset: Any, args: argparse.Namespace) -> int:
    coordinate = dataset.variables.get(name)
    axis = coordinate_axis(name, coordinate) if coordinate is not None else None
    if size == 1:
        return 0
    if axis == "time":
        index = args.time_index
    elif axis == "depth":
        index = args.depth_index
    else:
        raise ValueError(f"变量包含未选择的非空间维度 {name}（大小 {size}）")
    if index < 0 or index >= size:
        raise ValueError(f"{name} 索引 {index} 超出范围 0..{size - 1}")
    return index


def select_spatial_slice(dataset: Any, variable: Any, lat_name: str, lon_name: str, args: argparse.Namespace, np: Any) -> tuple[Any, dict[str, int]]:
    lat_dim = dataset.variables[lat_name].dimensions[0]
    lon_dim = dataset.variables[lon_name].dimensions[0]
    if lat_dim not in variable.dimensions or lon_dim not in variable.dimensions:
        raise ValueError(f"变量 {args.variable} 不包含纬度和经度维度")
    selection: list[Any] = []
    selected_indices: dict[str, int] = {}
    remaining_dimensions: list[str] = []
    for dimension in variable.dimensions:
        if dimension in {lat_dim, lon_dim}:
            selection.append(slice(None))
            remaining_dimensions.append(dimension)
        else:
            index = dimension_index(dimension, len(dataset.dimensions[dimension]), dataset, args)
            selection.append(index)
            selected_indices[dimension] = index
    values = np.ma.asarray(variable[tuple(selection)])
    if remaining_dimensions == [lon_dim, lat_dim]:
        values = values.T
    elif remaining_dimensions != [lat_dim, lon_dim]:
        raise ValueError(f"变量空间维度顺序不受支持: {remaining_dimensions}")
    return values, selected_indices


def aggregation_grid(latitude_count: int, longitude_count: int, max_cells: int) -> tuple[int, int, int, int]:
    if latitude_count * longitude_count <= max_cells:
        return 1, 1, latitude_count, longitude_count

    source_aspect = latitude_count / longitude_count
    best: tuple[int, float, int, int, int, int, int] | None = None
    for requested_latitude_blocks in range(1, min(latitude_count, max_cells) + 1):
        latitude_stride = math.ceil(latitude_count / requested_latitude_blocks)
        latitude_blocks = math.ceil(latitude_count / latitude_stride)
        requested_longitude_blocks = min(longitude_count, max_cells // latitude_blocks)
        longitude_stride = math.ceil(longitude_count / requested_longitude_blocks)
        longitude_blocks = math.ceil(longitude_count / longitude_stride)
        output_cells = latitude_blocks * longitude_blocks
        aspect_error = abs(math.log((latitude_blocks / longitude_blocks) / source_aspect))
        candidate = (
            output_cells,
            -aspect_error,
            -abs(latitude_stride - longitude_stride),
            latitude_stride,
            longitude_stride,
            latitude_blocks,
            longitude_blocks,
        )
        if best is None or candidate[:3] > best[:3]:
            best = candidate

    if best is None:
        raise ValueError("无法计算输出聚合网格")
    return best[3], best[4], best[5], best[6]


def render(file_path: Path, args: argparse.Namespace, Dataset: Any, np: Any) -> dict[str, Any]:
    if args.max_cells < 1 or args.max_cells > 20_000:
        raise ValueError("--max-cells 必须在 1..20000 之间")
    with Dataset(str(file_path), mode="r") as dataset:
        if args.variable not in dataset.variables:
            raise ValueError(f"变量不存在: {args.variable}")
        variable = dataset.variables[args.variable]
        try:
            dtype = np.dtype(variable.dtype)
        except (TypeError, ValueError) as error:
            raise ValueError(f"变量类型不受支持: {error}") from error
        if not np.issubdtype(dtype, np.number) or np.issubdtype(dtype, np.complexfloating):
            raise ValueError(f"变量 {args.variable} 不是可渲染的实数变量")

        lat_name, latitude = find_coordinate(dataset, "latitude")
        lon_name, longitude = find_coordinate(dataset, "longitude")
        if len(latitude.dimensions) != 1 or len(longitude.dimensions) != 1:
            raise ValueError("当前仅支持一维规则经纬度坐标")
        lat_values = np.asarray(latitude[:], dtype=float).reshape(-1)
        lon_values = np.asarray(longitude[:], dtype=float).reshape(-1)
        lat_edges = coordinate_edges(lat_values, np)
        lon_edges = coordinate_edges(lon_values, np)
        values, selected_indices = select_spatial_slice(dataset, variable, lat_name, lon_name, args, np)
        if values.shape != (lat_values.size, lon_values.size):
            raise ValueError(f"空间切片形状 {values.shape} 与坐标不一致")

        full_values = np.ma.masked_invalid(np.ma.asarray(values, dtype=float))
        valid_values = full_values.compressed()
        if valid_values.size == 0:
            raise ValueError("所选切片没有有效数值")

        total_cells = int(full_values.size)
        latitude_stride, longitude_stride, latitude_blocks, longitude_blocks = aggregation_grid(
            int(lat_values.size),
            int(lon_values.size),
            args.max_cells,
        )
        features = []
        for lat_index in range(0, lat_values.size, latitude_stride):
            for lon_index in range(0, lon_values.size, longitude_stride):
                lat_end_index = min(lat_values.size, lat_index + latitude_stride)
                lon_end_index = min(lon_values.size, lon_index + longitude_stride)
                block_values = full_values[lat_index:lat_end_index, lon_index:lon_end_index].compressed()
                if block_values.size == 0:
                    continue
                value = float(block_values.mean())
                south, north = sorted((float(lat_edges[lat_index]), float(lat_edges[lat_end_index])))
                west, east = sorted((float(lon_edges[lon_index]), float(lon_edges[lon_end_index])))
                features.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
                    },
                    "properties": {
                        "value": value,
                        "source_min": float(block_values.min()),
                        "source_max": float(block_values.max()),
                        "source_count": int(block_values.size),
                        "aggregation": "mean",
                        "variable": args.variable,
                        "latitude": float(lat_values[lat_index:lat_end_index].mean()),
                        "longitude": float(lon_values[lon_index:lon_end_index].mean()),
                        **selected_indices,
                    },
                })
        minimum = float(valid_values.min())
        maximum = float(valid_values.max())
        mean = float(valid_values.mean())
        units = attribute_text(variable, "units")
        long_name = attribute_text(variable, "long_name") or args.variable
        title = f"{long_name} 分布"
        config = {
            "map_type": "value-grid",
            "bounds": [[float(min(lat_edges)), float(min(lon_edges))], [float(max(lat_edges)), float(max(lon_edges))]],
            "geojson": {"type": "FeatureCollection", "features": features},
            "value_field": "value",
            "value_range": {"min": minimum, "max": maximum},
            "units": units,
            "color_scale": {
                "colors": ["#313695", "#4575b4", "#74add1", "#abd9e9", "#ffffbf", "#fdae61", "#f46d43", "#a50026"],
            },
            "style": {"fill_opacity": 0.78, "line_color": "#ffffff", "line_width": 0.25},
            "selection": {"variable": args.variable, "indices": selected_indices},
        }
        return {
            "success": True,
            "summary": f"生成 {len(features)} 个均值聚合网格单元",
            "data": {
                "file": str(file_path),
                "filename": file_path.name,
                "variable": args.variable,
                "long_name": long_name,
                "units": units,
                "selection": selected_indices,
                "statistics": {"min": minimum, "max": maximum, "mean": mean, "valid_count": int(valid_values.size)},
                "grid": {
                    "latitude_count": int(lat_values.size),
                    "longitude_count": int(lon_values.size),
                    "latitude_stride": latitude_stride,
                    "longitude_stride": longitude_stride,
                    "source_cells": total_cells,
                    "maximum_output_cells": args.max_cells,
                    "candidate_output_cells": latitude_blocks * longitude_blocks,
                    "output_cells": len(features),
                },
                "aggregation": {
                    "method": "mean",
                    "block_stride": {"latitude": latitude_stride, "longitude": longitude_stride},
                    "statistics_scope": "full_selected_slice",
                },
            },
            "artifact": {"viz_type": "ocean-map", "sub_type": "value-grid", "title": title, "config": config},
        }


def main() -> int:
    args = parse_args()
    try:
        file_path = validate_file(args.file)
        import numpy as np
        from netCDF4 import Dataset
        result = render(file_path, args, Dataset, np)
        json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
        sys.stdout.write("\n")
        return 0
    except (OSError, ValueError) as error:
        print(f"render_nc: {error}", file=sys.stderr)
        return 2
    except ImportError:
        print("render_nc: 缺少 netCDF4；请安装本 Skill 的 requirements.txt", file=sys.stderr)
        return 3
    except Exception as error:
        print(f"render_nc: 生成变量图层失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
