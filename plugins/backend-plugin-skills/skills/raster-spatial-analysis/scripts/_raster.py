"""Independent raster analysis entrypoints for the raster-spatial-analysis skill.

Each public script calls ``main(tool)`` with a fixed operation.  The shared
implementation is intentionally small and uses Rasterio/NumPy primitives so
that tools are deterministic and easy for an agent to route.
"""

from __future__ import annotations

import argparse
import ast
import math
import operator
import warnings
from pathlib import Path
from typing import Any, Callable

from _shared import (
    describe_raster,
    load_rasterio,
    print_json,
    write_json_file,
    write_raster_array,
)


def _np():
    try:
        import numpy as np
    except ImportError as error:
        raise RuntimeError("缺少 NumPy 依赖；请安装 requirements.txt") from error
    return np


def _gpd():
    try:
        import geopandas as gpd
    except ImportError as error:
        raise RuntimeError("缺少 GeoPandas 依赖；请安装 requirements.txt") from error
    return gpd


def _profile(src: Any, *, count: int | None = None, dtype: str | None = None, nodata: Any = ...,
             height: int | None = None, width: int | None = None, transform: Any = None,
             crs: Any = ...) -> dict[str, Any]:
    profile = src.profile.copy()
    if count is not None:
        profile["count"] = int(count)
    if dtype is not None:
        profile["dtype"] = str(dtype)
    if nodata is not ...:
        profile["nodata"] = nodata
    if height is not None:
        profile["height"] = int(height)
    if width is not None:
        profile["width"] = int(width)
    if transform is not None:
        profile["transform"] = transform
    if crs is not ...:
        profile["crs"] = crs
    return profile


def _band(src: Any, band: int) -> Any:
    if band < 1 or band > src.count:
        raise ValueError(f"--band 必须在 1 到 {src.count} 之间")
    return src.read(band)


def _masked(src: Any, band: int) -> Any:
    if band < 1 or band > src.count:
        raise ValueError(f"--band 必须在 1 到 {src.count} 之间")
    return src.read(band, masked=True)


def _spatial(src: Any) -> dict[str, Any]:
    return {
        "crs": src.crs.to_string() if src.crs else None,
        "bounds": [float(value) for value in src.bounds],
    }


def _output(file: dict[str, Any], result: dict[str, Any], tool: str) -> dict[str, Any]:
    return {"success": True, "tool": tool, "result": result, "file": file}


def _read_mask_shapes(path: str, src: Any) -> list[Any]:
    gpd = _gpd()
    zones = gpd.read_file(path)
    if src.crs is None or zones.crs is None:
        raise ValueError("栅格和掩膜图层都必须声明 CRS")
    if zones.crs != src.crs:
        zones = zones.to_crs(src.crs)
    shapes = [geometry.__geo_interface__ for geometry in zones.geometry if geometry is not None and not geometry.is_empty]
    if not shapes:
        raise ValueError("掩膜图层没有有效几何")
    return shapes


def _clip(src: Any, mask_path: str, all_touched: bool) -> tuple[Any, Any, dict[str, Any]]:
    rio = load_rasterio()
    from rasterio.mask import mask

    values, transform = mask(src, _read_mask_shapes(mask_path, src), crop=True, all_touched=all_touched, filled=False)
    output_nodata = src.nodata if src.nodata is not None else 0
    array = values.filled(output_nodata)
    profile = _profile(src, height=array.shape[1], width=array.shape[2], transform=transform, nodata=output_nodata)
    return array, profile, {"mask": mask_path, "all_touched": all_touched}


def _evaluate(expression: str, variables: dict[str, Any], np: Any) -> Any:
    if len(expression) > 500:
        raise ValueError("raster_calculator 表达式不能超过 500 个字符")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as error:
        raise ValueError(f"raster_calculator 表达式语法无效: {error.msg}") from error
    binary = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
              ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow,
              ast.BitAnd: operator.and_, ast.BitOr: operator.or_, ast.BitXor: operator.xor}
    unary = {ast.UAdd: operator.pos, ast.USub: operator.neg, ast.Invert: operator.invert, ast.Not: operator.not_}
    compare = {ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge,
               ast.Eq: operator.eq, ast.NotEq: operator.ne}
    functions = {"sqrt": np.sqrt, "log": np.log, "abs": np.abs, "where": np.where,
                 "minimum": np.minimum, "maximum": np.maximum, "clip": np.clip}
    arity = {"sqrt": (1, 1), "log": (1, 1), "abs": (1, 1), "where": (3, 3),
             "minimum": (2, 2), "maximum": (2, 2), "clip": (3, 3)}

    def visit(node: ast.AST) -> Any:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float, bool)) and not isinstance(node.value, complex):
                return node.value
            raise ValueError("raster_calculator 只允许数值和布尔常量")
        if isinstance(node, ast.Name):
            if node.id not in variables:
                raise ValueError(f"raster_calculator 未提供数组: {node.id}")
            return variables[node.id]
        if isinstance(node, ast.BinOp):
            operation = binary.get(type(node.op))
            if operation is None:
                raise ValueError(f"raster_calculator 不支持运算符: {type(node.op).__name__}")
            return operation(visit(node.left), visit(node.right))
        if isinstance(node, ast.UnaryOp):
            operation = unary.get(type(node.op))
            if operation is None:
                raise ValueError(f"raster_calculator 不支持一元运算符: {type(node.op).__name__}")
            return operation(visit(node.operand))
        if isinstance(node, ast.Compare):
            result = visit(node.left)
            values = []
            for op_node, comparator in zip(node.ops, node.comparators):
                operation = compare.get(type(op_node))
                if operation is None:
                    raise ValueError(f"raster_calculator 不支持比较符: {type(op_node).__name__}")
                next_value = visit(comparator)
                values.append(operation(result, next_value))
                result = next_value
            output = values[0]
            for value in values[1:]:
                output = np.logical_and(output, value)
            return output
        if isinstance(node, ast.BoolOp):
            if not node.values or not isinstance(node.op, (ast.And, ast.Or)):
                raise ValueError("raster_calculator 只支持 and/or 布尔运算")
            output = visit(node.values[0])
            operation = np.logical_and if isinstance(node.op, ast.And) else np.logical_or
            for value in node.values[1:]:
                output = operation(output, visit(value))
            return output
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in functions or node.keywords:
                raise ValueError("raster_calculator 只允许白名单函数")
            minimum, maximum = arity[node.func.id]
            if not minimum <= len(node.args) <= maximum:
                raise ValueError(f"raster_calculator 函数 {node.func.id} 参数数量无效")
            return functions[node.func.id](*(visit(argument) for argument in node.args))
        raise ValueError(f"raster_calculator 不支持语法节点: {type(node).__name__}")

    return visit(tree.body)


def _nodata_mask(values: Any, nodata: Any, np: Any) -> Any:
    mask = np.zeros(values.shape, dtype=bool)
    if np.issubdtype(values.dtype, np.floating):
        mask |= np.isnan(values)
    if nodata is not None:
        try:
            mask |= np.isnan(values) if isinstance(nodata, float) and math.isnan(nodata) else values == nodata
        except TypeError:
            mask |= values == nodata
    return mask


def _project(args: argparse.Namespace, rio: Any, np: Any) -> dict[str, Any]:
    from rasterio.enums import Resampling
    from rasterio.warp import calculate_default_transform, reproject

    with rio.open(args.input[0]) as src:
        if src.crs is None:
            raise ValueError("project_raster 需要输入栅格声明 CRS")
        transform, width, height = calculate_default_transform(src.crs, args.target_crs, src.width, src.height, *src.bounds)
        array = np.zeros((src.count, height, width), dtype=np.dtype(src.dtypes[0]))
        for index in range(src.count):
            reproject(src.read(index + 1), array[index], src_transform=src.transform, src_crs=src.crs,
                      dst_transform=transform, dst_crs=args.target_crs, src_nodata=src.nodata,
                      dst_nodata=src.nodata, resampling=Resampling.nearest)
        profile = _profile(src, height=height, width=width, transform=transform, crs=args.target_crs, nodata=src.nodata)
        file = write_raster_array(array, profile, args.output_name, args.tool, args.title or args.tool, {"target_crs": str(args.target_crs)})
        return _output(file, {"shape": list(array.shape), "crs": str(args.target_crs)}, args.tool)


def _raster_statistics(args: argparse.Namespace, rio: Any, np: Any) -> dict[str, Any]:
    with rio.open(args.input[0]) as src:
        bands = [args.band] if args.band else list(range(1, src.count + 1))
        statistics = []
        for band in bands:
            data = _masked(src, band).compressed().astype("float64")
            statistics.append({"band": band, "count": int(data.size), "min": float(np.min(data)) if data.size else None,
                               "max": float(np.max(data)) if data.size else None, "mean": float(np.mean(data)) if data.size else None,
                               "sum": float(np.sum(data)) if data.size else None, "std": float(np.std(data)) if data.size else None})
        value = {"input": str(args.input[0]), "statistics": statistics}
        file = write_json_file(value, args.output_name, args.tool, args.title or args.tool, {"source": _spatial(src)})
        return _output(file, value, args.tool)


def _zonal_statistics(args: argparse.Namespace, rio: Any, np: Any) -> dict[str, Any]:
    from rasterio.features import geometry_mask

    with rio.open(args.input[0]) as src:
        if src.crs is None:
            raise ValueError("zonal_statistics 需要输入栅格声明 CRS")
        gpd = _gpd()
        zones = gpd.read_file(args.overlay)
        if zones.crs is None:
            raise ValueError("分区图层必须声明 CRS")
        zones = zones.to_crs(src.crs)
        if args.zone_field and args.zone_field not in zones.columns:
            raise ValueError(f"分区字段不存在: {args.zone_field}")
        values = _band(src, args.band).astype("float64")
        invalid = _nodata_mask(values, src.nodata, np)
        rows = []
        for index, row in zones.iterrows():
            geometry = row.geometry
            if geometry is None or geometry.is_empty:
                continue
            mask = geometry_mask([geometry.__geo_interface__], out_shape=values.shape, transform=src.transform,
                                 invert=True, all_touched=args.all_touched)
            selected = values[mask & ~invalid]
            item = {"zone_index": int(index), "count": int(selected.size), "min": float(np.min(selected)) if selected.size else None,
                    "max": float(np.max(selected)) if selected.size else None, "mean": float(np.mean(selected)) if selected.size else None,
                    "sum": float(np.sum(selected)) if selected.size else None}
            if args.zone_field:
                item["zone_value"] = row.get(args.zone_field)
            rows.append(item)
        value = {"input": str(args.input[0]), "zone_field": args.zone_field, "band": args.band, "zones": rows}
        file = write_json_file(value, args.output_name, args.tool, args.title or args.tool, {"source": _spatial(src)})
        return _output(file, value, args.tool)


def _run(args: argparse.Namespace) -> dict[str, Any]:
    rio = load_rasterio()
    np = _np()
    tool = args.tool
    if tool == "describe_raster":
        with rio.open(args.input[0]) as src:
            return {"success": True, "tool": tool, "result": describe_raster(src)}
    if tool == "project_raster":
        return _project(args, rio, np)
    if tool in {"clip_raster", "extract_by_mask"}:
        with rio.open(args.input[0]) as src:
            array, profile, details = _clip(src, args.mask, args.all_touched)
            file = write_raster_array(array, profile, args.output_name, tool, args.title or tool, details)
            return _output(file, {"shape": list(array.shape), **details}, tool)
    if tool == "resample_raster":
        from rasterio.enums import Resampling
        if args.scale <= 0:
            raise ValueError("resample_raster 的 --scale 必须大于 0")
        with rio.open(args.input[0]) as src:
            height, width = max(1, round(src.height * args.scale)), max(1, round(src.width * args.scale))
            array = src.read(out_shape=(src.count, height, width), resampling=getattr(Resampling, args.resampling))
            transform = src.transform * src.transform.scale(src.width / width, src.height / height)
            profile = _profile(src, height=height, width=width, transform=transform)
            file = write_raster_array(array, profile, args.output_name, tool, args.title or tool, {"scale": args.scale, "resampling": args.resampling})
            return _output(file, {"shape": list(array.shape), "scale": args.scale}, tool)
    if tool == "raster_calculator":
        second = rio.open(args.overlay) if args.overlay else None
        try:
            with rio.open(args.input[0]) as src:
                first = _band(src, args.band)
                arrays = {"A": first.astype("float64")}
                second_values = None
                if second:
                    _band(second, args.overlay_band)
                    if second.shape != src.shape or second.crs != src.crs or second.transform != src.transform:
                        raise ValueError("raster_calculator 的两个栅格尺寸、CRS 和变换必须一致")
                    second_values = _band(second, args.overlay_band)
                    arrays["B"] = second_values.astype("float64")
                value = np.asarray(_evaluate(args.expression, arrays, np))
                if value.shape != first.shape:
                    raise ValueError("raster_calculator 表达式结果必须与输入栅格尺寸一致")
                invalid = _nodata_mask(first, src.nodata, np)
                if second is not None:
                    invalid |= _nodata_mask(second_values, second.nodata, np)
                if src.nodata is not None:
                    value = np.where(invalid, src.nodata, value)
                profile = _profile(src, count=1, dtype="float32", nodata=src.nodata)
                file = write_raster_array(value.astype("float32"), profile, args.output_name, tool, args.title or tool,
                                              {"expression": args.expression})
                finite = np.isfinite(value)
                result = {"expression": args.expression, "min": float(np.min(value[finite])) if finite.any() else None,
                          "max": float(np.max(value[finite])) if finite.any() else None}
                return _output(file, result, tool)
        finally:
            if second:
                second.close()
    if tool == "reclassify":
        breaks = [float(value.strip()) for value in args.breaks.split(",") if value.strip()]
        if not breaks or breaks != sorted(set(breaks)):
            raise ValueError("reclassify 的 --breaks 必须是严格递增的数值")
        with rio.open(args.input[0]) as src:
            values = _band(src, args.band)
            result = np.digitize(values, breaks, right=False).astype("int16") + 1
            result[_nodata_mask(values, src.nodata, np)] = 0
            profile = _profile(src, count=1, dtype="int16", nodata=0)
            file = write_raster_array(result, profile, args.output_name, tool, args.title or tool, {"breaks": breaks})
            return _output(file, {"breaks": breaks, "classes": len(breaks) + 1}, tool)
    if tool == "focal_statistics":
        if args.window < 1 or args.window % 2 == 0:
            raise ValueError("focal_statistics 的 --window 必须是正奇数")
        with rio.open(args.input[0]) as src:
            data = _band(src, args.band).astype("float64")
            invalid = _nodata_mask(data, src.nodata, np)
            data[invalid] = np.nan
            radius = args.window // 2
            padded = np.pad(data, radius, mode="edge")
            windows = np.lib.stride_tricks.sliding_window_view(padded, (args.window, args.window))
            reducer: Callable[..., Any] | None = {"mean": np.nanmean, "sum": np.nansum, "min": np.nanmin, "max": np.nanmax}.get(args.statistic)
            if reducer is None:
                raise ValueError("focal_statistics 的 --statistic 只能是 mean、sum、min 或 max")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                result = reducer(windows, axis=(-2, -1)).astype("float32")
            if src.nodata is not None:
                result[np.isnan(result)] = src.nodata
            profile = _profile(src, count=1, dtype="float32", nodata=src.nodata)
            file = write_raster_array(result, profile, args.output_name, tool, args.title or tool, {"window": args.window, "statistic": args.statistic})
            return _output(file, {"window": args.window, "statistic": args.statistic}, tool)
    if tool == "zonal_statistics":
        return _zonal_statistics(args, rio, np)
    if tool == "raster_statistics":
        return _raster_statistics(args, rio, np)
    if tool == "set_nodata":
        with rio.open(args.input[0]) as src:
            array = src.read(masked=True).filled(args.nodata)
            profile = _profile(src, nodata=args.nodata)
            file = write_raster_array(array, profile, args.output_name, tool, args.title or tool,
                                          {"nodata": args.nodata, "source_nodata": src.nodata})
            return _output(file, {"source_nodata": src.nodata, "nodata": args.nodata}, tool)
    if tool == "fill_nodata":
        from rasterio.fill import fillnodata
        with rio.open(args.input[0]) as src:
            array = np.empty((src.count, src.height, src.width), dtype="float32")
            for index in range(src.count):
                masked = src.read(index + 1, masked=True)
                values = masked.filled(0).astype("float32")
                valid = (~masked.mask).astype("uint8")
                array[index] = fillnodata(values, mask=valid, max_search_distance=args.max_distance)
            profile = _profile(src, dtype="float32")
            file = write_raster_array(array, profile, args.output_name, tool, args.title or tool,
                                          {"max_distance": args.max_distance, "source_nodata": src.nodata})
            return _output(file, {"bands": src.count, "max_distance": args.max_distance}, tool)
    if tool == "aggregate_raster":
        factor = args.factor
        if factor < 2:
            raise ValueError("aggregate_raster 的 --factor 必须不小于 2")
        with rio.open(args.input[0]) as src:
            out_h, out_w = src.height // factor, src.width // factor
            if not out_h or not out_w:
                raise ValueError("aggregate_raster factor 大于输入栅格尺寸")
            values = src.read().astype("float64")[:, :out_h * factor, :out_w * factor]
            invalid = _np().zeros(values.shape, dtype=bool)
            if src.nodata is not None:
                invalid |= values == src.nodata
            values[invalid] = np.nan
            blocks = values.reshape(src.count, out_h, factor, out_w, factor)
            reducer = {"mean": np.nanmean, "sum": np.nansum, "min": np.nanmin, "max": np.nanmax, "median": np.nanmedian}.get(args.statistic)
            if reducer is None:
                raise ValueError("aggregate_raster 的 --statistic 只能是 mean、sum、min、max 或 median")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                result = reducer(blocks, axis=(2, 4)).astype("float32")
            output_nodata = src.nodata if src.nodata is not None else -9999.0
            result[np.isnan(result)] = output_nodata
            transform = src.transform * src.transform.scale(factor, factor)
            profile = _profile(src, height=out_h, width=out_w, transform=transform, dtype="float32", nodata=output_nodata)
            file = write_raster_array(result, profile, args.output_name, tool, args.title or tool,
                                          {"factor": factor, "statistic": args.statistic})
            return _output(file, {"shape": list(result.shape), "factor": factor, "statistic": args.statistic}, tool)
    if tool == "cell_statistics":
        if len(args.input) < 2:
            raise ValueError("cell_statistics 至少需要两个输入栅格")
        datasets = [rio.open(path) for path in args.input]
        try:
            first = datasets[0]
            if any((dataset.shape != first.shape or dataset.transform != first.transform or dataset.crs != first.crs) for dataset in datasets[1:]):
                raise ValueError("cell_statistics 的输入栅格必须具有相同尺寸、CRS 和变换")
            stack = np.stack([dataset.read(args.band).astype("float64") for dataset in datasets])
            invalid = np.zeros(stack.shape, dtype=bool)
            for index, dataset in enumerate(datasets):
                invalid[index] = _nodata_mask(stack[index], dataset.nodata, np)
            stack[invalid] = np.nan
            reducer = {"mean": np.nanmean, "sum": np.nansum, "min": np.nanmin, "max": np.nanmax, "median": np.nanmedian}.get(args.statistic)
            if reducer is None:
                raise ValueError("cell_statistics 的 --statistic 只能是 mean、sum、min、max 或 median")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                result = reducer(stack, axis=0).astype("float32")
            output_nodata = first.nodata if first.nodata is not None else -9999.0
            result[np.isnan(result)] = output_nodata
            profile = _profile(first, count=1, dtype="float32", nodata=output_nodata)
            file = write_raster_array(result, profile, args.output_name, tool, args.title or tool,
                                          {"inputs": len(datasets), "statistic": args.statistic})
            return _output(file, {"shape": list(result.shape), "inputs": len(datasets), "statistic": args.statistic}, tool)
        finally:
            for dataset in datasets:
                dataset.close()
    if tool == "mosaic":
        from rasterio.merge import merge
        datasets = [rio.open(path) for path in args.input]
        try:
            if not datasets:
                raise ValueError("mosaic 至少需要一个输入栅格")
            array, transform = merge(datasets)
            profile = _profile(datasets[0], height=array.shape[1], width=array.shape[2], transform=transform)
            file = write_raster_array(array, profile, args.output_name, tool, args.title or tool, {"inputs": len(datasets)})
            return _output(file, {"shape": list(array.shape), "inputs": len(datasets)}, tool)
        finally:
            for dataset in datasets:
                dataset.close()
    raise ValueError(f"未知栅格工具: {tool}")


def build_parser(tool: str) -> argparse.ArgumentParser:
    descriptions = {
        "describe_raster": "查看栅格元数据",
        "project_raster": "重投影栅格",
        "clip_raster": "按矢量范围裁剪栅格",
        "extract_by_mask": "按矢量掩膜提取栅格",
        "resample_raster": "重采样栅格",
        "raster_calculator": "按安全表达式计算像元",
        "reclassify": "按断点重分类",
        "focal_statistics": "邻域统计",
        "zonal_statistics": "分区统计",
        "raster_statistics": "栅格统计摘要",
        "set_nodata": "设置栅格 NoData",
        "fill_nodata": "填充栅格 NoData",
        "aggregate_raster": "按因子聚合栅格",
        "cell_statistics": "多个栅格逐像元统计",
        "mosaic": "镶嵌多个栅格",
    }
    parser = argparse.ArgumentParser(description=descriptions.get(tool, "栅格空间分析"))
    parser.set_defaults(tool=tool)
    parser.add_argument("--input", required=True, nargs="+" if tool in {"mosaic", "cell_statistics"} else 1, help="输入栅格路径")
    if tool not in {"describe_raster", "raster_statistics", "zonal_statistics"}:
        parser.add_argument("--output-name", default=None)
        parser.add_argument("--title", default=None)
    elif tool in {"raster_statistics", "zonal_statistics"}:
        parser.add_argument("--output-name", default=None)
        parser.add_argument("--title", default=None)
    if tool == "project_raster":
        parser.add_argument("--target-crs", required=True)
    if tool in {"clip_raster", "extract_by_mask"}:
        parser.add_argument("--mask", "--overlay", dest="mask", required=True)
        parser.add_argument("--all-touched", action="store_true")
    if tool == "resample_raster":
        parser.add_argument("--scale", required=True, type=float)
        parser.add_argument("--resampling", choices=["nearest", "bilinear", "cubic", "average"], default="bilinear")
    if tool == "raster_calculator":
        parser.add_argument("--expression", required=True)
        parser.add_argument("--overlay")
        parser.add_argument("--band", type=int, default=1)
        parser.add_argument("--overlay-band", type=int, default=1)
    if tool == "reclassify":
        parser.add_argument("--breaks", required=True)
        parser.add_argument("--band", type=int, default=1)
    if tool == "focal_statistics":
        parser.add_argument("--window", type=int, default=3)
        parser.add_argument("--statistic", choices=["mean", "sum", "min", "max"], default="mean")
        parser.add_argument("--band", type=int, default=1)
    if tool == "zonal_statistics":
        parser.add_argument("--overlay", required=True, help="分区矢量图层")
        parser.add_argument("--zone-field")
        parser.add_argument("--band", type=int, default=1)
        parser.add_argument("--all-touched", action="store_true")
    if tool == "raster_statistics":
        parser.add_argument("--band", type=int)
    if tool == "set_nodata":
        parser.add_argument("--nodata", required=True, type=float)
    if tool == "fill_nodata":
        parser.add_argument("--max-distance", type=float, default=100.0)
    if tool == "aggregate_raster":
        parser.add_argument("--factor", required=True, type=int)
        parser.add_argument("--statistic", choices=["mean", "sum", "min", "max", "median"], default="mean")
    if tool == "cell_statistics":
        parser.add_argument("--statistic", choices=["mean", "sum", "min", "max", "median"], default="mean")
        parser.add_argument("--band", type=int, default=1)
    if tool == "mosaic":
        pass
    return parser


def main(tool: str) -> None:
    args = build_parser(tool).parse_args()
    try:
        print_json(_run(args))
    except Exception as error:
        print_json({"success": False, "tool": tool, "error": str(error)})
        raise SystemExit(1) from error


