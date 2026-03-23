#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
create_chart.py - ECharts 图表生成

输出 artifact 协议格式，由 execute_skill_script 自动持久化。

用法:
  python create_chart.py --data '[{"年份":2020,"人口":100}]' --chart-type bar --x-field 年份 --y-field 人口
  python create_chart.py --data data.csv --chart-type line --x-field 年份 --y-field 人口 --title "人口趋势"
"""

import sys
import os
import json
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.data_loader import load_records
from lib.chart_builder import build_echarts_option, build_chart_preview


def main():
    parser = argparse.ArgumentParser(description="ECharts 图表生成")
    parser.add_argument("--data", required=True, help="数据源：JSON 字符串或文件路径")
    parser.add_argument("--chart-type", default="bar",
                        choices=["line", "bar", "pie", "scatter"],
                        help="图表类型")
    parser.add_argument("--x-field", required=True, help="X 轴字段名")
    parser.add_argument("--y-field", required=True, help="Y 轴字段名")
    parser.add_argument("--series-field", default="", help="系列分组字段（可选）")
    parser.add_argument("--title", default="", help="图表标题（可选）")
    args = parser.parse_args()

    try:
        records = load_records(args.data)
    except ValueError as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

    # 校验字段存在
    columns = set()
    for r in records:
        columns.update(r.keys())

    for field_name, field_val in [("x_field", args.x_field), ("y_field", args.y_field)]:
        if field_val not in columns:
            print(json.dumps({
                "success": False,
                "error": f"{field_name} '{field_val}' 在数据中不存在。可用字段: {sorted(columns)}"
            }, ensure_ascii=False))
            sys.exit(1)

    if args.series_field and args.series_field not in columns:
        print(json.dumps({
            "success": False,
            "error": f"series_field '{args.series_field}' 在数据中不存在。可用字段: {sorted(columns)}"
        }, ensure_ascii=False))
        sys.exit(1)

    option = build_echarts_option(
        records=records,
        chart_type=args.chart_type,
        x_field=args.x_field,
        y_field=args.y_field,
        series_field=args.series_field,
        title=args.title,
    )

    preview = build_chart_preview(option, args.chart_type)
    final_title = option.get("title", {}).get("text", args.title or "未命名图表")

    output = {
        "success": True,
        "data": {"title": final_title, "preview": preview},
        "artifact": {
            "viz_type": "chart",
            "sub_type": args.chart_type,
            "title": final_title,
            "config": option,
        },
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
