#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
create_map.py - Leaflet 地图生成

输出 artifact 协议格式，由 execute_skill_script 自动持久化。

用法:
  python create_map.py --data '[{"name":"南宁","value":12,"geometry":"POINT (108.32 22.82)"}]' \
    --map-type marker --value-field value --name-field name
"""

import sys
import os
import json
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.data_loader import load_records
from lib.geometry import parse_geometry

SUPPORTED_MAP_TYPES = ["heatmap", "marker", "circle", "choropleth", "geojson"]

SUPPORTED_MARKER_ICONS = {
    "pin", "dot", "ring", "square", "diamond", "triangle", "star", "flag",
    "badge", "hospital", "shelter", "station", "warning", "rescue", "supply",
    "school", "bridge", "dam", "reservoir", "pump", "cross", "hexagon",
    "arrow", "shield", "drop",
}
DEFAULT_MARKER_STYLE = {
    "icon": "pin", "color": "#2a81cb", "border_color": "#1a6ab5",
    "glyph": "", "glyph_color": "#ffffff", "size": "md",
}


def _normalize_marker_style(ms):
    if not isinstance(ms, dict):
        return dict(DEFAULT_MARKER_STYLE)
    normalized = dict(DEFAULT_MARKER_STYLE)
    icon = ms.get("icon")
    if isinstance(icon, str) and icon.strip().lower() in SUPPORTED_MARKER_ICONS:
        normalized["icon"] = icon.strip().lower()
    for key in ("color", "border_color", "glyph_color"):
        val = ms.get(key)
        if isinstance(val, str) and val.strip():
            normalized[key] = val.strip()
    glyph = ms.get("glyph")
    if glyph is not None:
        normalized["glyph"] = str(glyph)[:2]
    size = ms.get("size")
    if isinstance(size, str) and size.strip().lower() in {"sm", "md", "lg", "xl"}:
        normalized["size"] = size.strip().lower()
    elif isinstance(size, (int, float)) and size > 0:
        normalized["size"] = int(size)
    return normalized


def process_map_layer(records, map_type, name_field, value_field,
                      geometry_field="geometry", marker_style=None):
    """处理地图数据层，返回 layer_data dict。"""
    columns = set()
    for r in records:
        columns.update(r.keys())

    if value_field not in columns:
        raise ValueError(f"数值字段 '{value_field}' 不存在。可用: {sorted(columns)}")
    if geometry_field not in columns:
        raise ValueError(f"几何字段 '{geometry_field}' 不存在。可用: {sorted(columns)}")

    heat_data = []
    markers = []
    geojson_features = []
    all_lats = []
    all_lngs = []
    valid_count = 0

    # 收集有效数值
    values = []
    for r in records:
        v = r.get(value_field)
        if v is not None:
            try:
                values.append(float(v))
            except (ValueError, TypeError):
                pass
    if not values:
        raise ValueError(f"{value_field} 字段没有有效的数值数据")
    min_val, max_val = min(values), max(values)

    for idx, row in enumerate(records):
        geom = parse_geometry(row.get(geometry_field))
        if geom is None:
            continue

        try:
            value = float(row.get(value_field, 0) or 0)
        except (ValueError, TypeError):
            value = 0

        name = ""
        if name_field and row.get(name_field) is not None:
            name = str(row[name_field])
        else:
            name = f"点 {valid_count + 1}"

        centroid = geom["centroid"]
        all_lats.append(centroid[0])
        all_lngs.append(centroid[1])

        if geom["type"] == "Point":
            lat, lng = centroid[0], centroid[1]
            if max_val > min_val:
                intensity = 0.1 + 0.9 * (value - min_val) / (max_val - min_val)
            else:
                intensity = 0.5
            heat_data.append([lat, lng, intensity])

            marker_data = {"lat": lat, "lng": lng, "value": value, "name": name}
            if map_type == "circle":
                if max_val > min_val:
                    normalized = (value - min_val) / (max_val - min_val)
                    marker_data["radius"] = int(500 + normalized * 4500)
                else:
                    marker_data["radius"] = 2000

            row_icon = row.get("icon")
            row_ms = row.get("marker_style")
            if isinstance(row_ms, dict):
                marker_data["marker_style"] = _normalize_marker_style(row_ms)
            elif isinstance(row_icon, str) and row_icon.strip().lower() in SUPPORTED_MARKER_ICONS:
                per = dict(marker_style or {})
                per["icon"] = row_icon.strip().lower()
                marker_data["marker_style"] = _normalize_marker_style(per)
            markers.append(marker_data)
        else:
            properties = {"name": name, "value": value}
            for col in columns:
                if col not in (geometry_field, value_field, name_field):
                    v = row.get(col)
                    if v is not None:
                        properties[col] = round(v, 4) if isinstance(v, float) else v
            geojson_features.append({
                "type": "Feature",
                "geometry": {"type": geom["type"], "coordinates": geom["coordinates"]},
                "properties": properties,
            })
        valid_count += 1

    if valid_count == 0:
        raise ValueError(f"没有有效的地理坐标数据。请检查 {geometry_field} 字段。")

    bounds = [[min(all_lats), min(all_lngs)], [max(all_lats), max(all_lngs)]]
    center = [(min(all_lats) + max(all_lats)) / 2, (min(all_lngs) + max(all_lngs)) / 2]

    return {
        "heat_data": heat_data,
        "markers": markers,
        "geojson": {"type": "FeatureCollection", "features": geojson_features} if geojson_features else None,
        "bounds": bounds,
        "center": center,
        "total_points": valid_count,
        "value_field": value_field,
        "value_range": {"min": min_val, "max": max_val},
        "color_scale": {
            "type": "sequential",
            "colors": ["#ffffcc", "#fd8d3c", "#e31a1c", "#800026"],
        } if map_type == "choropleth" else None,
        "marker_style": _normalize_marker_style(marker_style) if markers else None,
    }


def main():
    parser = argparse.ArgumentParser(description="Leaflet 地图生成")
    parser.add_argument("--data", required=True, help="数据源：JSON 字符串或文件路径")
    parser.add_argument("--map-type", default="heatmap", choices=SUPPORTED_MAP_TYPES)
    parser.add_argument("--title", default="", help="地图标题")
    parser.add_argument("--name-field", default="", help="名称字段")
    parser.add_argument("--value-field", required=True, help="数值字段")
    parser.add_argument("--geometry-field", default="geometry", help="几何字段")
    parser.add_argument("--marker-style", default=None,
                        help='点样式 JSON，如 {"icon":"star","color":"#ef4444"}')
    args = parser.parse_args()

    try:
        records = load_records(args.data)
    except ValueError as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

    ms = None
    if args.marker_style:
        try:
            ms = json.loads(args.marker_style)
        except json.JSONDecodeError:
            print(json.dumps({"success": False, "error": "marker-style JSON 解析失败"}, ensure_ascii=False))
            sys.exit(1)

    try:
        layer = process_map_layer(
            records, args.map_type, args.name_field, args.value_field,
            args.geometry_field, marker_style=ms,
        )
    except ValueError as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

    title = args.title
    if not title:
        type_names = {
            "heatmap": "热力图", "marker": "标记点地图", "circle": "圆圈标记地图",
            "choropleth": "区域填色图", "geojson": "GeoJSON地图",
        }
        title = f"{args.value_field}分布{type_names.get(args.map_type, '地图')}"

    map_data = {
        "map_type": args.map_type,
        "heat_data": layer["heat_data"] if args.map_type == "heatmap" else [],
        "markers": layer["markers"] if args.map_type in ("marker", "circle", "choropleth", "geojson") else [],
        "geojson": layer["geojson"],
        "bounds": layer["bounds"],
        "center": layer["center"],
        "title": title,
        "value_field": layer["value_field"],
        "total_points": layer["total_points"],
        "value_range": layer["value_range"],
        "color_scale": layer["color_scale"],
        "marker_style": layer["marker_style"],
    }

    output = {
        "success": True,
        "data": {
            "title": title,
            "preview": {
                "map_type": args.map_type,
                "total_points": layer["total_points"],
                "center": layer["center"],
            },
        },
        "artifact": {
            "viz_type": "map",
            "sub_type": args.map_type,
            "title": title,
            "config": map_data,
        },
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
