#!/usr/bin/env python3
"""Shared vector processing implementation used by fixed operation entrypoints."""

from __future__ import annotations

import argparse
import ast
import math
import operator
import re
import sys
from pathlib import Path
from typing import Any

from _shared import (
    crs_name,
    load_geopandas,
    print_json,
    summarize,
    write_geojson_artifact,
    write_table_artifact,
)


OPERATIONS = [
    "project", "reproject", "define_projection", "buffer", "clip", "intersect",
    "union", "erase", "identity", "dissolve", "merge", "append", "spatial_join",
    "select", "select_by_location", "near", "repair_geometry",
    "multipart_to_singlepart", "calculate_field", "statistics", "export",
]


def _require_crs(frame: Any, operation: str) -> None:
    if frame.crs is None:
        raise ValueError(f"{operation} 需要输入图层声明 CRS")


def _align(frame: Any, other: Any, operation: str) -> Any:
    _require_crs(frame, operation)
    _require_crs(other, operation)
    if frame.crs != other.crs:
        return other.to_crs(frame.crs)
    return other


def _read(path: str, layer: str | None, gpd: Any) -> Any:
    kwargs = {"layer": layer} if layer else {}
    return gpd.read_file(path, **kwargs)


def _read_overlays(args: argparse.Namespace, gpd: Any, frame: Any) -> list[Any]:
    if not args.overlay:
        raise ValueError(f"{args.operation} 需要 --overlay")
    overlays = [_read(path, args.overlay_layer, gpd) for path in args.overlay]
    return [_align(frame, item, args.operation) for item in overlays]


def _buffer(frame: Any, distance: float) -> tuple[Any, bool]:
    if distance <= 0:
        raise ValueError("buffer distance 必须大于 0")
    _require_crs(frame, "buffer")
    original_crs = frame.crs
    temporary_projection = bool(getattr(original_crs, "is_geographic", False))
    work = frame.to_crs("EPSG:3857") if temporary_projection else frame.copy()
    work[work.geometry.name] = work.geometry.buffer(distance)
    return (work.to_crs(original_crs) if temporary_projection else work), temporary_projection


def _overlay_all(frame: Any, overlays: list[Any], how: str, gpd: Any) -> Any:
    result = frame
    for overlay in overlays:
        result = gpd.overlay(result, overlay, how=how, keep_geom_type=False)
    return result


def _repair(frame: Any) -> Any:
    from shapely import make_valid

    result = frame.copy()
    result[result.geometry.name] = result.geometry.map(
        lambda geometry: make_valid(geometry) if geometry is not None and not geometry.is_valid else geometry
    )
    return result


def _calculate(frame: Any, field: str, expression: str) -> Any:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", field):
        raise ValueError("field 必须是合法字段名")
    pattern = re.compile(r"!([A-Za-z_][A-Za-z0-9_]*)!")
    missing: set[str] = set()

    names: dict[str, str] = {}
    translated_parts: list[str] = []
    last = 0
    for match in pattern.finditer(expression):
        token = f"__field_{len(names)}"
        names[token] = match.group(1)
        if match.group(1) not in frame.columns:
            missing.add(match.group(1))
        translated_parts.extend([expression[last:match.start()], token])
        last = match.end()
    translated = "".join(translated_parts) + expression[last:]
    if missing:
        raise ValueError(f"字段不存在: {', '.join(sorted(missing))}")
    try:
        tree = ast.parse(translated, mode="eval")
    except SyntaxError as error:
        raise ValueError(f"表达式语法无效: {error.msg}") from error

    binary = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
              ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow}
    unary = {ast.UAdd: operator.pos, ast.USub: operator.neg}
    functions = {"round": round, "abs": abs, "min": min, "max": max, "len": len, "sqrt": math.sqrt, "log": math.log}

    def evaluate(row: Any) -> Any:
        variables = {token: row[field_name] for token, field_name in names.items()}

        def visit(node: ast.AST) -> Any:
            if isinstance(node, ast.Constant) and (node.value is None or isinstance(node.value, (int, float, str, bool))):
                return node.value
            if isinstance(node, ast.Name) and node.id in variables:
                return variables[node.id]
            if isinstance(node, ast.BinOp) and type(node.op) in binary:
                return binary[type(node.op)](visit(node.left), visit(node.right))
            if isinstance(node, ast.UnaryOp) and type(node.op) in unary:
                return unary[type(node.op)](visit(node.operand))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in functions and not node.keywords:
                return functions[node.func.id](*(visit(arg) for arg in node.args))
            raise ValueError(f"表达式语法不受支持: {type(node).__name__}")

        return visit(tree.body)

    result = frame.copy()
    result[field] = result.apply(evaluate, axis=1)
    return result


def _parse_literal(raw: str) -> Any:
    try:
        return ast.literal_eval(raw.strip())
    except (ValueError, SyntaxError):
        return raw.strip().strip("\"'")


def _select(frame: Any, where: str) -> Any:
    if len(where) > 500:
        raise ValueError("where 表达式不能超过 500 个字符")
    clauses = re.split(r"\s+(and|or)\s+", where, flags=re.IGNORECASE)
    masks: list[Any] = []
    connectors: list[str] = []
    for index in range(0, len(clauses), 2):
        match = re.fullmatch(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<|in|not_null)\s*(.*)\s*", clauses[index], flags=re.IGNORECASE)
        if not match:
            raise ValueError("where 仅支持 field == value、field > value、field in [a,b]、field not_null")
        field, operation, raw = match.groups()
        if field not in frame.columns:
            raise ValueError(f"字段不存在: {field}")
        series = frame[field]
        if operation.lower() == "not_null":
            mask = series.notna()
        elif operation.lower() == "in":
            raw_values = raw.strip().strip("[]()")
            mask = series.isin([_parse_literal(value) for value in raw_values.split(",") if value.strip()])
        else:
            value = _parse_literal(raw)
            operations = {"==": operator.eq, "!=": operator.ne, ">": operator.gt, ">=": operator.ge, "<": operator.lt, "<=": operator.le}
            mask = operations[operation](series, value)
        masks.append(mask)
        if index + 1 < len(clauses):
            connectors.append(clauses[index + 1].lower())
    result = masks[0]
    for index, connector in enumerate(connectors):
        result = result & masks[index + 1] if connector == "and" else result | masks[index + 1]
    return frame.loc[result].copy()


def _statistics(frame: Any, args: argparse.Namespace) -> list[dict[str, Any]]:
    if not args.stats:
        raise ValueError("statistics 需要 --stats field:stat[,field:stat]")
    specs: list[tuple[str, str]] = []
    for raw in args.stats.split(","):
        parts = raw.strip().split(":", 1)
        if len(parts) != 2 or parts[1] not in {"count", "sum", "mean", "min", "max", "median"}:
            raise ValueError(f"无效统计参数: {raw}")
        if parts[0] not in frame.columns:
            raise ValueError(f"字段不存在: {parts[0]}")
        specs.append((parts[0], parts[1]))
    group_fields = [field.strip() for field in (args.by or "").split(",") if field.strip()]
    missing = [field for field in group_fields if field not in frame.columns]
    if missing:
        raise ValueError(f"分组字段不存在: {', '.join(missing)}")
    grouped = frame.groupby(group_fields, dropna=False, sort=False) if group_fields else [((), frame)]
    rows: list[dict[str, Any]] = []
    for key, group in grouped:
        if not isinstance(key, tuple):
            key = (key,)
        row = {field: value for field, value in zip(group_fields, key)}
        for field, statistic in specs:
            series = group[field]
            if statistic == "count":
                value = int(series.count())
            else:
                value = getattr(series, statistic)()
                value = None if value is None or (isinstance(value, float) and not math.isfinite(value)) else value
                if hasattr(value, "item"):
                    value = value.item()
            row[f"{field}_{statistic}"] = value
        rows.append(row)
    return rows


def _process(frame: Any, args: argparse.Namespace, gpd: Any) -> tuple[Any | None, dict[str, Any], list[dict[str, Any]] | None]:
    operation = args.operation
    details: dict[str, Any] = {"operation": operation, "input": summarize(frame), "input_crs": crs_name(frame.crs)}
    if operation in {"project", "reproject"}:
        if not args.target_crs:
            raise ValueError("project 需要 --target-crs")
        result = frame.to_crs(args.target_crs)
        details["target_crs"] = crs_name(result.crs)
    elif operation == "define_projection":
        if not args.target_crs:
            raise ValueError("define_projection 需要 --target-crs")
        result = frame.set_crs(args.target_crs, allow_override=args.allow_override)
        details["target_crs"] = crs_name(result.crs)
        details["allow_override"] = args.allow_override
    elif operation == "buffer":
        result, temporary_projection = _buffer(frame, args.distance)
        details.update({"distance": args.distance, "distance_unit": "input CRS units or metres for geographic CRS", "temporary_projection": temporary_projection})
    elif operation == "clip":
        result = gpd.clip(frame, _read_overlays(args, gpd, frame)[0])
    elif operation in {"intersect", "union", "erase", "identity"}:
        overlays = _read_overlays(args, gpd, frame)
        if operation == "erase":
            result = _overlay_all(frame, overlays, "difference", gpd)
        else:
            result = _overlay_all(frame, overlays, "intersection" if operation == "intersect" else operation, gpd)
    elif operation == "dissolve":
        if args.by:
            result = frame.dissolve(by=[field.strip() for field in args.by.split(",")], as_index=False)
        else:
            result = frame.assign(_dissolve_group=1).dissolve(by="_dissolve_group", as_index=False).drop(columns=["_dissolve_group"])
        details["by"] = args.by
    elif operation in {"merge", "append"}:
        if len(args.input) < 2:
            raise ValueError("merge/append 至少需要两个 --input")
        frames = [_read(path, args.layer, gpd) for path in args.input]
        base_crs = frames[0].crs
        if base_crs is None:
            raise ValueError("merge/append 的输入图层必须声明 CRS")
        frames = [item if item.crs == base_crs else item.to_crs(base_crs) for item in frames]
        _, pandas = load_geopandas()
        result = pandas.concat(frames, ignore_index=True)
        result = gpd.GeoDataFrame(result, geometry=frames[0].geometry.name, crs=base_crs)
        details["inputs"] = args.input
    elif operation == "spatial_join":
        overlay = _read_overlays(args, gpd, frame)[0]
        result = gpd.sjoin(frame, overlay, how=args.join_type, predicate=args.predicate, lsuffix="input", rsuffix="join")
        if "index_join" in result:
            result = result.drop(columns=["index_join"])
    elif operation == "select":
        if not args.where:
            raise ValueError("select 需要 --where")
        result = _select(frame, args.where)
        details["where"] = args.where
    elif operation == "select_by_location":
        overlay = _read_overlays(args, gpd, frame)[0]
        joined = gpd.sjoin(frame, overlay[[overlay.geometry.name]], how="inner", predicate=args.predicate, lsuffix="input", rsuffix="location")
        result = frame.loc[~frame.index.duplicated(keep="first")].loc[joined.index.unique()].copy()
        details["predicate"] = args.predicate
    elif operation == "near":
        overlay = _read_overlays(args, gpd, frame)[0]
        _require_crs(frame, "near")
        work_frame, work_overlay = frame, overlay
        temporary_projection = bool(getattr(frame.crs, "is_geographic", False))
        if temporary_projection:
            work_frame, work_overlay = frame.to_crs("EPSG:3857"), overlay.to_crs("EPSG:3857")
        result = gpd.sjoin_nearest(work_frame, work_overlay, how="left", distance_col="NEAR_DIST", lsuffix="input", rsuffix="near")
        if temporary_projection:
            result = result.to_crs(frame.crs)
        result["NEAR_FID"] = result.get("index_near", result.index)
        details.update({"distance_field": "NEAR_DIST", "distance_unit": "metres" if temporary_projection else "input CRS units"})
    elif operation == "repair_geometry":
        result = _repair(frame)
    elif operation == "multipart_to_singlepart":
        result = frame.explode(index_parts=False, ignore_index=True)
    elif operation == "calculate_field":
        if not args.field or not args.expression:
            raise ValueError("calculate_field 需要 --field 和 --expression")
        result = _calculate(frame, args.field, args.expression)
        details.update({"field": args.field, "expression": args.expression})
    elif operation == "statistics":
        rows = _statistics(frame, args)
        details.update({"stats": args.stats, "by": args.by, "row_count": len(rows)})
        return None, details, rows
    elif operation == "export":
        result = frame.copy()
    else:
        raise ValueError(f"不支持的 operation: {operation}")
    details["output"] = summarize(result)
    return result, details, None


def _parser(forced_operation: str | None = None) -> argparse.ArgumentParser:
    if forced_operation is None:
        raise ValueError("必须通过同名入口脚本选择矢量操作")
    parser = argparse.ArgumentParser(description=f"矢量空间分析{f'：{forced_operation}' if forced_operation else ''}")
    parser.add_argument("--input", action="append", required=True, help="输入矢量文件；merge/append 可重复")
    parser.add_argument("--layer", help="主输入 GeoPackage 图层")
    parser.add_argument("--output-name", default="vector-result")
    if forced_operation not in OPERATIONS:
        raise ValueError(f"未知操作: {forced_operation}")
    parser.set_defaults(operation=forced_operation)
    selected = {forced_operation}

    if selected & {"clip", "intersect", "union", "erase", "identity", "spatial_join", "select_by_location", "near"}:
        parser.add_argument("--overlay", action="append", help="叠加图层；多图层时重复传入")
        parser.add_argument("--overlay-layer", help="叠加 GeoPackage 图层")
    if selected & {"project", "reproject", "define_projection"}:
        parser.add_argument("--target-crs", "--crs", dest="target_crs", help="目标 CRS，例如 EPSG:3857")
    if "define_projection" in selected:
        parser.add_argument("--allow-override", action="store_true", help="覆盖已有 CRS 声明")
    if "buffer" in selected:
        parser.add_argument("--distance", type=float, required=forced_operation == "buffer", help="缓冲距离")
    if selected & {"dissolve", "statistics"}:
        parser.add_argument("--by", help="分组字段，可逗号分隔")
    if selected & {"spatial_join", "select_by_location"}:
        parser.add_argument("--predicate", default="intersects", choices=["intersects", "contains", "within", "touches", "crosses", "overlaps", "covers", "covered_by"])
    if "spatial_join" in selected:
        parser.add_argument("--join-type", default="left", choices=["left", "inner"])
    if "select" in selected:
        parser.add_argument("--where", required=forced_operation == "select", help="pandas 查询表达式")
    if "calculate_field" in selected:
        parser.add_argument("--field", required=forced_operation == "calculate_field", help="目标字段")
        parser.add_argument("--expression", required=forced_operation == "calculate_field", help="表达式，支持 !field! 占位符")
    if "statistics" in selected:
        parser.add_argument("--stats", required=forced_operation == "statistics", help="统计规格，如 POP:sum,POP:mean")
    return parser


def main(forced_operation: str | None = None) -> int:
    args = _parser(forced_operation).parse_args()
    try:
        gpd, _ = load_geopandas()
        frame = _read(args.input[0], args.layer, gpd)
        result, details, rows = _process(frame, args, gpd)
        title = f"{args.operation} · {Path(args.input[0]).name}"
        if rows is not None:
            artifact = write_table_artifact(rows, args.output_name, args.operation, title, details, details["input"].get("bounds", []))
        else:
            artifact = write_geojson_artifact(result, args.output_name, args.operation, title, details)
        print_json({"success": True, "data": details, "artifact": artifact})
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"vector_geoprocessing: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"vector_geoprocessing: 处理失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
