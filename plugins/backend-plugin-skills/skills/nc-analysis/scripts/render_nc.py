#!/usr/bin/env python3
"""Render a bounded regular NetCDF variable slice as a PNG raster File."""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any


ALLOWED_SUFFIXES = {".nc", ".nc4", ".cdf"}
MAX_OUTPUT_CELLS = 20_000
WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066
COLOR_SCALE = ["#313695", "#4575b4", "#74add1", "#abd9e9", "#ffffbf", "#fdae61", "#f46d43", "#a50026"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="将规则经纬度网格变量切片生成 PNG 海洋栅格。")
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


def aggregate_values(
    values: Any,
    latitude_stride: int,
    longitude_stride: int,
    latitude_blocks: int,
    longitude_blocks: int,
    np: Any,
) -> tuple[Any, Any]:
    raster_values = np.full((latitude_blocks, longitude_blocks), np.nan, dtype=float)
    valid_counts = np.zeros((latitude_blocks, longitude_blocks), dtype=int)
    for output_latitude, latitude_index in enumerate(range(0, values.shape[0], latitude_stride)):
        for output_longitude, longitude_index in enumerate(range(0, values.shape[1], longitude_stride)):
            block = values[
                latitude_index:min(values.shape[0], latitude_index + latitude_stride),
                longitude_index:min(values.shape[1], longitude_index + longitude_stride),
            ].compressed()
            valid_counts[output_latitude, output_longitude] = int(block.size)
            if block.size:
                raster_values[output_latitude, output_longitude] = float(block.mean())
    return raster_values, valid_counts


def orient_raster(raster_values: Any, valid_counts: Any, latitude: Any, longitude: Any, np: Any) -> tuple[Any, Any]:
    if latitude[0] < latitude[-1]:
        raster_values = np.flipud(raster_values)
        valid_counts = np.flipud(valid_counts)
    if longitude[0] > longitude[-1]:
        raster_values = np.fliplr(raster_values)
        valid_counts = np.fliplr(valid_counts)
    return raster_values, valid_counts


def aggregated_axis_edges(edges: Any, stride: int, np: Any) -> Any:
    last_index = len(edges) - 1
    indices = list(range(0, last_index, stride)) + [last_index]
    return np.asarray(edges, dtype=float)[indices]


def reproject_rows_to_web_mercator(
    raster_values: Any,
    valid_counts: Any,
    north_to_south_edges: Any,
    np: Any,
) -> tuple[Any, Any]:
    edges = np.asarray(north_to_south_edges, dtype=float).reshape(-1)
    if edges.size != raster_values.shape[0] + 1 or not np.all(np.diff(edges) < 0):
        raise ValueError("纬度块边界必须按从北到南排列并与栅格高度一致")
    if edges[0] > WEB_MERCATOR_MAX_LATITUDE or edges[-1] < -WEB_MERCATOR_MAX_LATITUDE:
        raise ValueError(f"Web Mercator 仅支持纬度 ±{WEB_MERCATOR_MAX_LATITUDE:.8f}° 以内")

    projected_edges = np.arcsinh(np.tan(np.deg2rad(edges)))
    target_projected_edges = np.linspace(projected_edges[0], projected_edges[-1], raster_values.shape[0] + 1)
    target_projected_centers = (target_projected_edges[:-1] + target_projected_edges[1:]) / 2
    target_latitudes = np.rad2deg(np.arctan(np.sinh(target_projected_centers)))
    source_rows = np.searchsorted(-edges, -target_latitudes, side="right") - 1
    source_rows = np.clip(source_rows, 0, raster_values.shape[0] - 1)
    return raster_values[source_rows, :], valid_counts[source_rows, :]


def colorize_raster(raster_values: Any, minimum: float, maximum: float, np: Any) -> Any:
    palette = np.asarray(
        [[int(color[index:index + 2], 16) for index in (1, 3, 5)] for color in COLOR_SCALE],
        dtype=float,
    )
    rgba = np.zeros((*raster_values.shape, 4), dtype=np.uint8)
    valid = np.isfinite(raster_values)
    if not np.any(valid):
        return rgba

    if maximum == minimum:
        normalized = np.full(raster_values.shape, 0.5, dtype=float)
    else:
        normalized = np.clip((raster_values - minimum) / (maximum - minimum), 0.0, 1.0)
    normalized = np.where(valid, normalized, 0.0)
    positions = normalized * (len(COLOR_SCALE) - 1)
    lower = np.floor(positions).astype(int)
    upper = np.minimum(lower + 1, len(COLOR_SCALE) - 1)
    fraction = (positions - lower)[..., np.newaxis]
    rgb = np.rint(palette[lower] * (1.0 - fraction) + palette[upper] * fraction).astype(np.uint8)
    rgba[valid, :3] = rgb[valid]
    rgba[valid, 3] = 255
    return rgba


def safe_asset_name(variable_name: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", variable_name).strip("-._") or "variable"
    return f"{stem[:80]}-raster.png"


def stage_png(png_bytes: bytes, variable_name: str) -> str:
    output_path = Path.cwd() / safe_asset_name(variable_name)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(png_bytes)
    return output_path.name


def render(file_path: Path, args: argparse.Namespace, Dataset: Any, Image: Any, np: Any) -> dict[str, Any]:
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
        raster_values, valid_counts = aggregate_values(
            full_values,
            latitude_stride,
            longitude_stride,
            latitude_blocks,
            longitude_blocks,
            np,
        )
        raster_values, valid_counts = orient_raster(raster_values, valid_counts, lat_values, lon_values, np)
        latitude_block_edges = aggregated_axis_edges(lat_edges, latitude_stride, np)
        if latitude_block_edges[0] < latitude_block_edges[-1]:
            latitude_block_edges = latitude_block_edges[::-1]
        raster_values, valid_counts = reproject_rows_to_web_mercator(
            raster_values,
            valid_counts,
            latitude_block_edges,
            np,
        )
        minimum = float(valid_values.min())
        maximum = float(valid_values.max())
        mean = float(valid_values.mean())
        rgba = colorize_raster(raster_values, minimum, maximum, np)
        png_buffer = io.BytesIO()
        Image.fromarray(rgba).save(png_buffer, format="PNG", optimize=True)
        pathname = stage_png(png_buffer.getvalue(), args.variable)
        units = attribute_text(variable, "units")
        long_name = attribute_text(variable, "long_name") or args.variable
        title = f"{long_name} 分布"
        bounds = [[float(min(lat_edges)), float(min(lon_edges))], [float(max(lat_edges)), float(max(lon_edges))]]
        spatial_metadata = {
            "spatial": {"crs": "EPSG:4326", "bounds": [float(min(lon_edges)), float(min(lat_edges)), float(max(lon_edges)), float(max(lat_edges))]},
            "pixel_projection": "EPSG:3857",
            "width": longitude_blocks,
            "height": latitude_blocks,
            "value_range": {"min": minimum, "max": maximum},
            "units": units,
            "color_scale": COLOR_SCALE,
            "selection": {"variable": args.variable, "indices": selected_indices},
            "grid": {
                "latitude_count": int(lat_values.size),
                "longitude_count": int(lon_values.size),
                "latitude_stride": latitude_stride,
                "longitude_stride": longitude_stride,
            },
            "aggregation": {"method": "mean", "statistics_scope": "full_selected_slice"},
        }
        return {
            "success": True,
            "summary": f"生成 {longitude_blocks}×{latitude_blocks} 块均值 PNG 栅格",
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
                    "output_cells": latitude_blocks * longitude_blocks,
                    "valid_output_cells": int(np.count_nonzero(valid_counts)),
                },
                "aggregation": {
                    "method": "mean",
                    "block_stride": {"latitude": latitude_stride, "longitude": longitude_stride},
                    "statistics_scope": "full_selected_slice",
                },
                "raster": {
                    "width": longitude_blocks,
                    "height": latitude_blocks,
                    "orientation": "north-up-west-left",
                    "projection": "EPSG:3857",
                    "resampling": "nearest",
                    "bounds": bounds,
                    "nodata": None,
                },
            },
            "file": {"path": pathname, "media_type": "image/png", "size": (Path.cwd() / pathname).stat().st_size,
                     "metadata": spatial_metadata},
        }


def main() -> int:
    args = parse_args()
    try:
        file_path = validate_file(args.file)
        import numpy as np
        from netCDF4 import Dataset
        from PIL import Image
        result = render(file_path, args, Dataset, Image, np)
        json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
        sys.stdout.write("\n")
        return 0
    except (OSError, ValueError) as error:
        print(f"render_nc: {error}", file=sys.stderr)
        return 2
    except ImportError:
        print("render_nc: 缺少 netCDF4、NumPy 或 Pillow；请安装本 Skill 的 requirements.txt", file=sys.stderr)
        return 3
    except Exception as error:
        print(f"render_nc: 生成变量图层失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

