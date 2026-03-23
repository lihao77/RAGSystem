#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
create_risk_map.py - 批量风险评估 + 自动生成风险地图

对多个地点批量调用风险评估，生成带风险等级颜色标记的地图。
输出 artifact 协议格式，由 execute_skill_script 自动持久化。

用法:
  python create_risk_map.py --data '[{"location":"南宁市","geometry":"POINT (108.32 22.82)","rainfall_24h":150}]'
  python create_risk_map.py --data '[...]' --title "广西防汛风险评估" --disaster-type 洪涝
"""

import sys
import os
import json
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
# 复用同 skill 内的 assess_flood_risk
from scripts.assess_flood_risk import assess_single

RISK_COLORS = {
    "I": "#d32f2f",
    "II": "#ff9800",
    "III": "#fdd835",
    "IV": "#1976d2",
}
RISK_LABELS = {
    "I": "特别重大",
    "II": "重大",
    "III": "较大",
    "IV": "一般",
}


def _parse_geometry_simple(raw):
    """简易 POINT WKT 解析，返回 [lat, lng] 或 None。"""
    if raw is None:
        return None
    if isinstance(raw, str):
        raw = raw.strip()
        # POINT (lng lat)
        import re
        m = re.match(r'POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)', raw, re.IGNORECASE)
        if m:
            lng, lat = float(m.group(1)), float(m.group(2))
            return [lat, lng]
        # GeoJSON string
        if raw.startswith("{"):
            try:
                obj = json.loads(raw)
                if obj.get("type") == "Point":
                    coords = obj["coordinates"]
                    return [coords[1], coords[0]]
            except (json.JSONDecodeError, KeyError, IndexError):
                pass
    return None


def _try_geocode(location):
    """尝试通过 guangxi-geodata skill 的 geocode 脚本获取坐标。"""
    try:
        import subprocess
        geocode_script = os.path.normpath(os.path.join(
            os.path.dirname(__file__), "..", "..", "guangxi-geodata", "scripts", "geocode.py",
        ))
        if not os.path.exists(geocode_script):
            return None
        proc = subprocess.run(
            [sys.executable, geocode_script, "--location", location],
            capture_output=True, text=True, timeout=5,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            geo_r = json.loads(proc.stdout)
            if geo_r.get("found"):
                return [geo_r["lat"], geo_r["lng"]]
    except Exception:
        pass
    return None


def main():
    parser = argparse.ArgumentParser(description="批量风险评估 + 风险地图生成")
    parser.add_argument("--data", required=True,
                        help="JSON 数组，每项含 location/geometry + 气象水文字段")
    parser.add_argument("--title", default="", help="地图标题")
    parser.add_argument("--disaster-type", default="洪涝", help="灾害类型")
    args = parser.parse_args()

    try:
        items = json.loads(args.data)
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"data JSON 解析失败: {e}"}, ensure_ascii=False))
        sys.exit(1)

    if not isinstance(items, list) or not items:
        print(json.dumps({"success": False, "error": "data 必须是非空 JSON 数组"}, ensure_ascii=False))
        sys.exit(1)

    markers = []
    assessment_summary = {"I": 0, "II": 0, "III": 0, "IV": 0}
    detailed_results = []

    for item in items:
        if not isinstance(item, dict) or "location" not in item:
            continue

        location = str(item["location"])

        # 解析坐标
        centroid = _parse_geometry_simple(item.get("geometry"))
        if centroid is None:
            centroid = _try_geocode(location)
        if centroid is None:
            continue

        # 风险评估
        risk = assess_single(
            location=location,
            rainfall_24h=item.get("rainfall_24h"),
            water_level=item.get("water_level"),
            warning_level=item.get("warning_level"),
            forecast_rainfall=item.get("forecast_rainfall"),
        )

        risk_level = risk.get("risk_level")
        risk_label = risk.get("risk_label", "未知")
        risk_factors = risk.get("risk_factors", [])
        assessment = risk.get("assessment", "")
        risk_color = RISK_COLORS.get(risk_level, "#999999")

        if risk_level and risk_level in assessment_summary:
            assessment_summary[risk_level] += 1

        markers.append({
            "lat": centroid[0],
            "lng": centroid[1],
            "name": location,
            "value": 0,
            "risk_level": risk_level or "无",
            "risk_label": risk_label,
            "risk_color": risk_color,
            "risk_factors": risk_factors,
            "assessment": assessment,
        })

        detailed_results.append({
            "location": location,
            "risk_level": risk_level,
            "risk_label": risk_label,
            "risk_factors": risk_factors,
            "assessment": assessment,
        })

    if not markers:
        print(json.dumps({"success": False, "error": "没有有效的评估数据"}, ensure_ascii=False))
        sys.exit(1)

    lats = [m["lat"] for m in markers]
    lngs = [m["lng"] for m in markers]
    bounds = [[min(lats), min(lngs)], [max(lats), max(lngs)]]
    center = [(min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2]

    title = args.title or f"{args.disaster_type}风险评估地图"

    risk_legend = {}
    for level in ("I", "II", "III", "IV"):
        risk_legend[level] = {"color": RISK_COLORS[level], "label": RISK_LABELS[level]}

    map_data = {
        "map_type": "risk",
        "markers": markers,
        "bounds": bounds,
        "center": center,
        "title": title,
        "total_points": len(markers),
        "risk_legend": risk_legend,
        "assessment_summary": assessment_summary,
        "disaster_type": args.disaster_type,
    }

    # 构建摘要
    summary_parts = []
    for level in ("I", "II", "III", "IV"):
        count = assessment_summary[level]
        if count > 0:
            summary_parts.append(f"{level}级({RISK_LABELS[level]}):{count}个")

    output = {
        "success": True,
        "data": {
            "title": title,
            "total_points": len(markers),
            "assessment_summary": assessment_summary,
            "detailed_results": detailed_results,
        },
        "summary": f"风险地图：{title}（{len(markers)}个监测点，{', '.join(summary_parts) or '无风险'}）",
        "artifact": {
            "viz_type": "map",
            "sub_type": "risk",
            "title": title,
            "config": map_data,
        },
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
