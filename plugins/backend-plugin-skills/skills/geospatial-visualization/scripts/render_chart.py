#!/usr/bin/env python3
"""Build a small ECharts File from JSON or CSV records."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

from _shared import print_json


def load_records(raw: str):
    path = Path(raw)
    if path.exists():
        if path.suffix.lower() == ".csv":
            with path.open(newline="", encoding="utf-8-sig") as stream:
                return list(csv.DictReader(stream))
        return json.loads(path.read_text(encoding="utf-8"))
    return json.loads(raw)


def main() -> int:
    parser = argparse.ArgumentParser(description="空间数据 ECharts 图表")
    parser.add_argument("--data", required=True, help="JSON 字符串、JSON 文件或 CSV 文件")
    parser.add_argument("--chart-type", choices=["line", "bar", "pie", "scatter"], default="bar")
    parser.add_argument("--x-field", required=True)
    parser.add_argument("--y-field", required=True)
    parser.add_argument("--series-field", default="")
    parser.add_argument("--title", default="")
    args = parser.parse_args()
    try:
        records = load_records(args.data)
        if not isinstance(records, list) or not records:
            raise ValueError("数据必须是非空记录数组")
        fields = set().union(*(record.keys() for record in records if isinstance(record, dict)))
        for field in [args.x_field, args.y_field] + ([args.series_field] if args.series_field else []):
            if field not in fields:
                raise ValueError(f"字段不存在: {field}；可用字段: {sorted(fields)}")
        if args.chart_type == "pie":
            series = [{"type": "pie", "radius": "62%", "data": [{"name": str(row[args.x_field]), "value": float(row[args.y_field])} for row in records]}]
            option = {"title": {"text": args.title}, "tooltip": {"trigger": "item"}, "series": series}
        else:
            categories = [row[args.x_field] for row in records]
            groups = {}
            for row in records:
                group = str(row.get(args.series_field) or "系列") if args.series_field else "系列"
                groups.setdefault(group, []).append([row[args.x_field], float(row[args.y_field])])
            option = {"title": {"text": args.title}, "tooltip": {"trigger": "axis"}, "legend": {"show": bool(args.series_field)}, "xAxis": {"type": "category", "data": categories}, "yAxis": {"type": "value"}, "series": [{"name": name, "type": args.chart_type, "data": [point[1] for point in points]} for name, points in groups.items()]}
            if args.chart_type == "scatter":
                option["xAxis"] = {"type": "value"}
                option["series"] = [{"name": name, "type": "scatter", "data": points} for name, points in groups.items()]
        title = args.title or "空间数据图表"
        option["title"]["text"] = title
        filename = f"{args.output_name}.json"
        output_path = Path.cwd() / filename
        output_path.write_text(json.dumps(option, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        file = {"path": filename, "media_type": "application/json", "size": output_path.stat().st_size,
                "metadata": {"chart_type": args.chart_type, "record_count": len(records), "renderer": "echarts"}}
        print_json({"success": True, "data": {"title": title, "record_count": len(records)}, "file": file})
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"render_chart: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"render_chart: 生成图表失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

