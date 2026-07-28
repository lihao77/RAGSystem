#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ECharts option 构建工具。零后端依赖。"""


def build_echarts_option(records, chart_type, x_field, y_field,
                         series_field="", title=""):
    """
    从记录列表构建 ECharts option 配置。

    Args:
        records: list[dict] 数据记录
        chart_type: line/bar/pie/scatter
        x_field: X 轴字段
        y_field: Y 轴字段
        series_field: 系列分组字段（可选）
        title: 图表标题

    Returns:
        dict ECharts option
    """
    final_title = title or f"{y_field} 随 {x_field} 变化"

    # 清理 NaN/None
    cleaned = []
    for r in records:
        row = {}
        for k, v in r.items():
            if v != v:  # NaN check
                row[k] = None
            else:
                row[k] = v
        cleaned.append(row)

    option = {
        "title": {"text": final_title, "left": "center"},
        "tooltip": {"trigger": "axis" if chart_type != "pie" else "item"},
        "legend": {"top": "bottom"},
        "dataset": {"source": cleaned},
        "xAxis": {"type": "category", "name": x_field} if chart_type != "pie" else None,
        "yAxis": {"type": "value", "name": y_field} if chart_type != "pie" else None,
        "series": [],
    }

    if series_field:
        # 数据透视
        pivot = _pivot_records(cleaned, x_field, series_field, y_field)
        option["dataset"]["source"] = pivot["records"]
        for s_name in pivot["series_names"]:
            option["series"].append({
                "type": chart_type,
                "name": str(s_name),
                "encode": {"x": x_field, "y": s_name},
            })
    else:
        series_cfg = {
            "type": chart_type,
            "encode": {"x": x_field, "y": y_field},
            "name": y_field,
        }
        if chart_type == "pie":
            series_cfg["encode"] = {"itemName": x_field, "value": y_field}
            series_cfg["radius"] = "50%"
        option["series"].append(series_cfg)

    return option


def _pivot_records(records, index_field, columns_field, values_field):
    """纯 Python 数据透视。"""
    # 收集所有系列名
    series_set = []
    seen = set()
    for r in records:
        s = r.get(columns_field)
        if s is not None and s not in seen:
            series_set.append(s)
            seen.add(s)

    # 按 index 分组
    groups = {}
    for r in records:
        idx = r.get(index_field)
        if idx not in groups:
            groups[idx] = {index_field: idx}
        groups[idx][r.get(columns_field)] = r.get(values_field)

    pivot_records = list(groups.values())
    return {"records": pivot_records, "series_names": series_set}


def build_chart_preview(option, chart_type):
    """构建图表预览摘要。"""
    title_block = option.get("title", {})
    title = title_block.get("text", "") if isinstance(title_block, dict) else ""
    series = option.get("series", [])
    series_count = len(series) if isinstance(series, list) else 0
    dataset = option.get("dataset", {})
    data_rows = 0
    if isinstance(dataset, dict):
        source = dataset.get("source")
        if isinstance(source, list):
            data_rows = len(source)
    return {
        "title": title or "未命名图表",
        "chart_type": chart_type,
        "series_count": series_count,
        "data_rows": data_rows,
    }
