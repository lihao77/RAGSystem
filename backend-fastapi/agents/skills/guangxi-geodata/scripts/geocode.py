#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
geocode.py - 广西地名坐标解析

将广西地名转换为 WGS84 坐标，支持精确/别名/模糊匹配。
输出 wkt 字段可直接用于 create_map/create_risk_map 的 geometry 参数。

用法:
  python scripts/geocode.py --location "桂林市"
  python scripts/geocode.py --batch "南宁市,桂林市,柳州市"
"""

import sys
import json
import argparse
import os

# ─── 加载内嵌坐标数据库 ────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from _geodata import GUANGXI_CITIES, GUANGXI_DISTRICTS


def _build_alias_index():
    idx = {}
    for name, info in {**GUANGXI_CITIES, **GUANGXI_DISTRICTS}.items():
        idx[name] = name
        for alias in info.get("aliases", []):
            idx[alias] = name
    return idx


_ALIAS_INDEX = _build_alias_index()


def _geocode_single(name: str):
    """解析单个地名，返回结果 dict 或 None。"""
    name = name.strip()
    if not name:
        return None

    all_db = {**GUANGXI_CITIES, **GUANGXI_DISTRICTS}

    # 1. 精确匹配
    if name in all_db:
        info = all_db[name]
        level = "city" if name in GUANGXI_CITIES else "district"
        return _build(name, info, level)

    # 2. 别名匹配
    canonical = _ALIAS_INDEX.get(name)
    if canonical and canonical in all_db:
        info = all_db[canonical]
        level = "city" if canonical in GUANGXI_CITIES else "district"
        return _build(canonical, info, level)

    # 3. 前缀模糊匹配
    for db, level in [(GUANGXI_CITIES, "city"), (GUANGXI_DISTRICTS, "district")]:
        for key, info in db.items():
            bare = key.rstrip("市县区")
            if key.startswith(name) or name.startswith(bare):
                return _build(key, info, level)

    # 4. 包含匹配
    for db, level in [(GUANGXI_CITIES, "city"), (GUANGXI_DISTRICTS, "district")]:
        for key, info in db.items():
            bare = key.rstrip("市县区")
            if name in key or bare in name:
                return _build(key, info, level)

    return None


def _build(name, info, level):
    lat, lng = info["lat"], info["lng"]
    r = {
        "found": True,
        "name": name,
        "lat": lat,
        "lng": lng,
        "wkt": f"POINT ({lng} {lat})",
        "level": level,
    }
    if "code" in info:
        r["code"] = info["code"]
    if "parent" in info:
        r["parent"] = info["parent"]
    return r


def geocode_batch(names):
    results = []
    for name in names:
        r = _geocode_single(name)
        if r:
            results.append(r)
        else:
            results.append({
                "found": False,
                "name": name,
                "message": f"未找到地名 '{name}' 的坐标",
                "available_cities": list(GUANGXI_CITIES.keys()),
            })
    return results


def main():
    parser = argparse.ArgumentParser(description="广西地名坐标解析")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--location", help="单个地名")
    group.add_argument("--batch", help="多地名，逗号分隔")
    args = parser.parse_args()

    if args.batch:
        names = [n.strip() for n in args.batch.split(",") if n.strip()]
        results = geocode_batch(names)
        output = {
            "total": len(results),
            "found_count": sum(1 for r in results if r.get("found")),
            "results": results,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        r = _geocode_single(args.location)
        if r:
            print(json.dumps(r, ensure_ascii=False, indent=2))
        else:
            output = {
                "found": False,
                "location": args.location,
                "message": f"未找到地名 '{args.location}' 的坐标数据",
                "available_cities": list(GUANGXI_CITIES.keys()),
                "hint": "请检查地名拼写，或尝试使用地级市名称（如'桂林市'）",
            }
            print(json.dumps(output, ensure_ascii=False, indent=2))
            sys.exit(0)  # 未找到不视为错误，让 AI 自行判断


if __name__ == "__main__":
    main()
