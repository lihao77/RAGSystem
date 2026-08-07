"""Deterministic inspection and data-management operations for spatial files."""

from __future__ import annotations

import argparse
import ast
import math
import operator
import re
import sys
from pathlib import Path
from typing import Any, Callable

from _shared import (
    crs_text,
    describe_dataset,
    describe_frame,
    load_geopandas,
    load_rasterio,
    print_json,
    wgs84_bounds,
    write_table_file,
    write_vector_file,
)


OPERATIONS = {
    "describe_vector",
    "describe_raster",
    "list_layers",
    "validate_crs",
    "define_projection",
    "repair_geometry",
    "copy_features",
    "delete_fields",
    "rename_fields",
    "calculate_field",
    "summary_statistics",
}
VECTOR_OPERATIONS = OPERATIONS - {"describe_raster", "list_layers", "validate_crs"}
PRODUCING_OPERATIONS = OPERATIONS - {"describe_vector", "describe_raster", "list_layers", "validate_crs"}


def read_vector(path: str, layer: str | None = None) -> Any:
    gpd = load_geopandas()
    kwargs = {"layer": layer} if layer else {}
    frame = gpd.read_file(path, **kwargs)
    if not hasattr(frame, "geometry"):
        raise ValueError(f"输入不是带几何列的矢量数据: {path}")
    return frame


def read_spatial(path: str, data_type: str) -> tuple[str, Any]:
    if data_type in {"auto", "vector"}:
        try:
            return "vector", read_vector(path)
        except Exception:
            if data_type == "vector":
                raise
    if data_type in {"auto", "raster"}:
        rio = load_rasterio()
        dataset = rio.open(path)
        return "raster", dataset
    raise ValueError(f"无法识别空间数据类型: {path}")


def _parse_mapping(raw: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for item in raw.split(","):
        pair = item.strip().split(":", 1)
        if len(pair) != 2 or not pair[0].strip() or not pair[1].strip():
            raise ValueError("--mapping 格式应为 old_name:new_name[,old2:new2]")
        old, new = pair[0].strip(), pair[1].strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", new):
            raise ValueError(f"字段名不合法: {new}")
        mapping[old] = new
    if not mapping:
        raise ValueError("--mapping 不能为空")
    return mapping


def _parse_fields(raw: str) -> list[str]:
    fields = [item.strip() for item in raw.split(",") if item.strip()]
    if not fields:
        raise ValueError("--fields 不能为空")
    return fields


_BINOPS: dict[type[ast.operator], Callable[[Any, Any], Any]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARYOPS: dict[type[ast.unaryop], Callable[[Any], Any]] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}
_COMPAREOPS: dict[type[ast.cmpop], Callable[[Any, Any], Any]] = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
}
_FUNCTIONS: dict[str, Callable[..., Any]] = {
    "abs": abs,
    "round": round,
    "min": min,
    "max": max,
    "sqrt": math.sqrt,
    "log": math.log,
}


def _compile_expression(expression: str, fields: set[str]) -> Callable[[Any], Any]:
    if len(expression) > 500:
        raise ValueError("表达式不能超过 500 个字符")
    names: dict[str, str] = {}
    missing: set[str] = set()

    def replace(match: re.Match[str]) -> str:
        field = match.group(1)
        if field not in fields:
            missing.add(field)
        token = f"__field_{len(names)}"
        names[token] = field
        return token

    translated = re.sub(r"!([A-Za-z_][A-Za-z0-9_]*)!", replace, expression)
    if missing:
        raise ValueError(f"字段不存在: {', '.join(sorted(missing))}")
    try:
        tree = ast.parse(translated, mode="eval")
    except SyntaxError as error:
        raise ValueError(f"表达式语法无效: {error.msg}") from error

    def evaluate(row: Any) -> Any:
        variables = {token: row[field] for token, field in names.items()}

        def visit(node: ast.AST) -> Any:
            if isinstance(node, ast.Constant) and (node.value is None or isinstance(node.value, (int, float, str, bool))):
                return node.value
            if isinstance(node, ast.Name):
                if node.id not in variables:
                    raise ValueError("表达式只能引用 !field! 字段占位符")
                return variables[node.id]
            if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
                return _BINOPS[type(node.op)](visit(node.left), visit(node.right))
            if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARYOPS:
                return _UNARYOPS[type(node.op)](visit(node.operand))
            if isinstance(node, ast.Compare):
                left = visit(node.left)
                values = []
                for operation_node, comparator in zip(node.ops, node.comparators):
                    if type(operation_node) not in _COMPAREOPS:
                        raise ValueError("表达式比较符不受支持")
                    right = visit(comparator)
                    values.append(_COMPAREOPS[type(operation_node)](left, right))
                    left = right
                return all(values)
            if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)):
                values = [bool(visit(value)) for value in node.values]
                return all(values) if isinstance(node.op, ast.And) else any(values)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCTIONS:
                if node.keywords:
                    raise ValueError("表达式函数不允许关键字参数")
                return _FUNCTIONS[node.func.id](*(visit(arg) for arg in node.args))
            raise ValueError(f"表达式语法不受支持: {type(node).__name__}")

        return visit(tree.body)

    return evaluate


def _statistics(frame: Any, stats: str, by: str | None) -> list[dict[str, Any]]:
    specs: list[tuple[str, str]] = []
    allowed = {"count", "sum", "mean", "min", "max", "median", "std", "stddev"}
    for raw in stats.split(","):
        field, separator, method = raw.strip().partition(":")
        method = "std" if method == "stddev" else method
        if not separator or method not in allowed or field not in frame.columns:
            raise ValueError(f"无效统计规格: {raw}")
        specs.append((field, method))
    groups = [item.strip() for item in (by or "").split(",") if item.strip()]
    missing = [field for field in groups if field not in frame.columns]
    if missing:
        raise ValueError(f"分组字段不存在: {', '.join(missing)}")
    grouped = frame.groupby(groups, dropna=False, sort=False) if groups else [((), frame)]
    rows: list[dict[str, Any]] = []
    for key, group in grouped:
        key = key if isinstance(key, tuple) else (key,)
        row = {field: value for field, value in zip(groups, key)}
        for field, method in specs:
            series = group[field]
            if method == "count":
                value = int(series.count())
            else:
                value = getattr(series, method)()
                if hasattr(value, "item"):
                    value = value.item()
                if isinstance(value, float) and not math.isfinite(value):
                    value = None
            row[f"{field}_{method}"] = value
        rows.append(row)
    return rows


def process(operation: str, args: argparse.Namespace) -> dict[str, Any]:
    if operation == "describe_raster":
        rio = load_rasterio()
        with rio.open(args.input) as dataset:
            return {"success": True, "data": {"operation": operation, "raster": describe_dataset(dataset)}}
    if operation == "list_layers":
        try:
            try:
                import fiona

                layers = list(fiona.listlayers(args.input))
            except ImportError:
                import pyogrio

                layers = [str(row[0]) for row in pyogrio.list_layers(args.input)]
        except Exception as error:
            raise ValueError(f"无法列出数据集图层: {error}") from error
        return {"success": True, "data": {"operation": operation, "input": args.input, "layers": layers}}
    if operation == "validate_crs":
        data_type, value = read_spatial(args.input, args.data_type)
        try:
            actual = value.crs
            description = describe_frame(value) if data_type == "vector" else describe_dataset(value)
        finally:
            if data_type == "raster":
                value.close()
        actual_text = crs_text(actual)
        expected_text = None
        valid = actual is not None
        if args.expected_crs:
            try:
                from pyproj import CRS

                expected = CRS.from_user_input(args.expected_crs)
                expected_text = crs_text(expected)
                valid = valid and CRS.from_user_input(actual).equals(expected) if actual is not None else False
            except Exception as error:
                raise ValueError(f"无效 CRS: {args.expected_crs}") from error
        return {
            "success": True,
            "data": {"operation": operation, "data_type": data_type, "crs": actual_text, "expected_crs": expected_text, "valid": bool(valid), "dataset": description},
        }

    frame = read_vector(args.input, getattr(args, "layer", None))
    details: dict[str, Any] = {"operation": operation, "input": describe_frame(frame)}
    if operation == "describe_vector":
        return {"success": True, "data": details}
    if operation == "define_projection":
        if frame.crs is not None and not args.allow_override:
            raise ValueError("输入已有 CRS；如需替换请显式传 --allow-override")
        result = frame.set_crs(args.target_crs, allow_override=args.allow_override)
        details["target_crs"] = crs_text(result.crs)
    elif operation == "repair_geometry":
        try:
            from shapely import make_valid
        except ImportError:
            make_valid = None
        result = frame.copy()
        geometry_name = result.geometry.name

        def repair(geometry: Any) -> Any:
            if geometry is None or geometry.is_empty or geometry.is_valid:
                return geometry
            if make_valid is not None:
                return make_valid(geometry)
            return geometry.buffer(0)

        result[geometry_name] = result.geometry.map(repair)
    elif operation == "copy_features":
        result = frame.copy()
    elif operation == "delete_fields":
        fields = _parse_fields(args.fields)
        geometry_name = frame.geometry.name
        missing = [field for field in fields if field not in frame.columns]
        if missing:
            raise ValueError(f"字段不存在: {', '.join(missing)}")
        if geometry_name in fields:
            raise ValueError("不能删除几何字段")
        result = frame.drop(columns=fields).copy()
    elif operation == "rename_fields":
        mapping = _parse_mapping(args.mapping)
        geometry_name = frame.geometry.name
        missing = [field for field in mapping if field not in frame.columns]
        if missing:
            raise ValueError(f"字段不存在: {', '.join(missing)}")
        if geometry_name in mapping:
            raise ValueError("不能重命名几何字段")
        if len(set(mapping.values())) != len(mapping.values()) or any(target in frame.columns and target not in mapping for target in mapping.values()):
            raise ValueError("重命名目标字段已存在或重复")
        result = frame.rename(columns=mapping).copy()
    elif operation == "calculate_field":
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.field):
            raise ValueError("字段名不合法")
        evaluator = _compile_expression(args.expression, set(frame.columns))
        result = frame.copy()
        result[args.field] = frame.apply(evaluator, axis=1)
        details.update({"field": args.field, "expression": args.expression})
    elif operation == "summary_statistics":
        rows = _statistics(frame, args.stats, args.by)
        details.update({"stats": args.stats, "by": args.by, "row_count": len(rows)})
        file = write_table_file(rows, args.output_name, operation, f"{operation} · {Path(args.input).name}", details, wgs84_bounds(frame))
        return {"success": True, "data": details, "file": file}
    else:
        raise ValueError(f"不支持的操作: {operation}")
    details["output"] = describe_frame(result)
    file = write_vector_file(result, args.output_name, operation, f"{operation} · {Path(args.input).name}", details)
    return {"success": True, "data": details, "file": file}


def build_parser(forced_operation: str | None = None) -> argparse.ArgumentParser:
    if forced_operation is None:
        raise ValueError("必须通过同名入口脚本选择数据管理操作")
    selected = {forced_operation} if forced_operation else OPERATIONS
    parser = argparse.ArgumentParser(description=f"Spatial data management{f': {forced_operation}' if forced_operation else ''}")
    parser.add_argument("--input", required=True, help="输入空间数据路径")
    if selected & VECTOR_OPERATIONS:
        parser.add_argument("--layer", help="GeoPackage 图层名")
    if selected & PRODUCING_OPERATIONS:
        parser.add_argument("--output-name", default="spatial-result", help="staging 输出文件名")
    if "validate_crs" in selected:
        parser.add_argument("--data-type", choices=["auto", "vector", "raster"], default="auto")
        parser.add_argument("--expected-crs", help="可选，期望的 CRS，如 EPSG:4326")
    if "define_projection" in selected:
        parser.add_argument("--target-crs", required=forced_operation == "define_projection", help="要声明的 CRS")
        parser.add_argument("--allow-override", action="store_true", help="允许替换已有 CRS 声明")
    if "delete_fields" in selected:
        parser.add_argument("--fields", required=forced_operation == "delete_fields", help="逗号分隔字段名")
    if "rename_fields" in selected:
        parser.add_argument("--mapping", required=forced_operation == "rename_fields", help="old:new,old2:new2")
    if "calculate_field" in selected:
        parser.add_argument("--field", required=forced_operation == "calculate_field", help="目标字段名")
        parser.add_argument("--expression", required=forced_operation == "calculate_field", help="使用 !field! 占位符的表达式")
    if "summary_statistics" in selected:
        parser.add_argument("--stats", required=forced_operation == "summary_statistics", help="field:stat,field2:stat")
        parser.add_argument("--by", help="逗号分隔分组字段")
    parser.set_defaults(operation=forced_operation)
    return parser


def main(forced_operation: str | None = None) -> int:
    args = build_parser(forced_operation).parse_args()
    try:
        print_json(process(args.operation, args))
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"spatial-data-management: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"spatial-data-management: 处理失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

