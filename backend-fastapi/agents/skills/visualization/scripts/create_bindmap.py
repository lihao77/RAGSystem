#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
create_bindmap.py - 多图层叠加地图

输出 artifact 协议格式，由 execute_skill_script 自动持久化。

用法:
  python create_bindmap.py --layers '[{"data":"[...]","map_type":"heatmap","label":"热力图","value_field":"value"},{"data":"[...]","map_type":"marker","label":"标记","value_field":"value"}]' --title "防汛态势图"
"""

import sys
import os
import json
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.data_loader import load_records
from scripts.create_map import process_map_layer


def main():
    parser = argparse.ArgumentParser(description="多图层叠加地图")
    parser.add_argument("--layers", required=True,
                        help="图层列表 JSON，每项含 data/map_type/value_field/label 等")
    parser.add_argument("--title", default="", help="地图标题")
    args = parser.parse_args()

    try:
        layers_cfg = json.loads(args.layers)
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"layers JSON 解析失败: {e}"}, ensure_ascii=False))
        sys.exit(1)

    if not isinstance(layers_cfg, list) or not layers_cfg:
        print(json.dumps({"success": False, "error": "layers 必须是非空数组"}, ensure_ascii=False))
        sys.exit(1)

    processed_layers = []
    all_lats = []
    all_lngs = []
    total_points = 0

    for i, cfg in enumerate(layers_cfg):
        if not isinstance(cfg, dict):
            print(json.dumps({"success": False, "error": f"第 {i+1} 个图层配置无效"}, ensure_ascii=False))
            sys.exit(1)

        data_str = cfg.get("data", "")
        map_type = cfg.get("map_type", "marker")
        label = cfg.get("label", f"图层 {i+1}")
        name_field = cfg.get("name_field", "")
        value_field = cfg.get("value_field", "")
        geometry_field = cfg.get("geometry_field", "geometry")
        marker_style = cfg.get("marker_style")

        if not value_field:
            print(json.dumps({"success": False, "error": f"图层 '{label}' 缺少 value_field"}, ensure_ascii=False))
            sys.exit(1)

        try:
            records = load_records(data_str)
        except ValueError as e:
            print(json.dumps({"success": False, "error": f"图层 '{label}' 数据加载失败: {e}"}, ensure_ascii=False))
            sys.exit(1)

        try:
            layer_data = process_map_layer(
                records, map_type, name_field, value_field,
                geometry_field, marker_style=marker_style,
            )
        except ValueError as e:
            print(json.dumps({"success": False, "error": f"图层 '{label}' 处理失败: {e}"}, ensure_ascii=False))
            sys.exit(1)

        bounds = layer_data["bounds"]
        all_lats.extend([bounds[0][0], bounds[1][0]])
        all_lngs.extend([bounds[0][1], bounds[1][1]])
        total_points += layer_data["total_points"]

        processed_layers.append({
            "id": f"layer_{i}",
            "label": label,
            "map_type": map_type,
            "heat_data": layer_data["heat_data"] if map_type == "heatmap" else [],
            "markers": layer_data["markers"] if map_type in ("marker", "circle", "choropleth", "geojson") else [],
            "geojson": layer_data["geojson"],
            "value_field": layer_data["value_field"],
            "total_points": layer_data["total_points"],
            "value_range": layer_data["value_range"],
            "color_scale": layer_data["color_scale"],
            "marker_style": layer_data["marker_style"],
            "visible": True,
        })

    merged_bounds = [[min(all_lats), min(all_lngs)], [max(all_lats), max(all_lngs)]]
    merged_center = [(min(all_lats) + max(all_lats)) / 2, (min(all_lngs) + max(all_lngs)) / 2]

    title = args.title or f"多图层地图（{len(processed_layers)}个图层）"

    map_data = {
        "map_type": "bindmap",
        "layers": processed_layers,
        "bounds": merged_bounds,
        "center": merged_center,
        "title": title,
        "total_layers": len(processed_layers),
        "total_points": total_points,
    }

    output = {
        "success": True,
        "data": {
            "title": title,
            "preview": {
                "map_type": "bindmap",
                "total_layers": len(processed_layers),
                "total_points": total_points,
                "center": merged_center,
            },
        },
        "artifact": {
            "viz_type": "map",
            "sub_type": "bindmap",
            "title": title,
            "config": map_data,
        },
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
