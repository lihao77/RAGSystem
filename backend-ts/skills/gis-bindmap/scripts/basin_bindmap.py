#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
basin_bindmap.py - 流域上下游关联分析

操作:
  downstream   — 下游影响分析
  upstream     — 上游溯源
  river-bindmap — 整条河流可视化

用法:
  python scripts/basin_bindmap.py --operation downstream --station "柳州水文站"
  python scripts/basin_bindmap.py --operation upstream --station "梧州水文站"
  python scripts/basin_bindmap.py --operation river-bindmap --river "柳江"
"""

import sys
import os
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shared import (
    load_river_topology, load_geodata_features, error_exit,
    build_marker_layer, geocode_location, make_wkt_point,
)


def _load_station_map():
    """加载水文站数据，构建 name -> station 映射"""
    features, err = load_geodata_features("hydrological_station")
    if err:
        error_exit(err)
    return {s["name"]: s for s in features}


def _find_station_in_rivers(station_name, rivers):
    """查找站点所在的所有河流及位置索引"""
    results = []
    for river in rivers:
        if station_name in river["stations"]:
            idx = river["stations"].index(station_name)
            results.append({"river": river, "index": idx})
    return results


def _find_river_by_name(name, rivers):
    """通过名称或别名查找河流"""
    for river in rivers:
        if name == river["name"] or name in river.get("alias", []):
            return river
    return None


def _resolve_downstream(station_name, topo, station_map, visited=None):
    """递归查找下游站点（含跨河流追踪）"""
    if visited is None:
        visited = set()
    if station_name in visited:
        return []
    visited.add(station_name)

    rivers = topo["rivers"]
    confluences = topo["confluences"]
    downstream = []

    # 在当前所在河流中找下游
    locations = _find_station_in_rivers(station_name, rivers)
    for loc in locations:
        river = loc["river"]
        idx = loc["index"]
        # 该河流中索引更大的站点是下游
        for i in range(idx + 1, len(river["stations"])):
            ds_name = river["stations"][i]
            if ds_name not in visited and ds_name in station_map:
                visited.add(ds_name)
                downstream.append(station_map[ds_name])

        # 检查是否有汇入关系：本河流作为支流汇入更大的河流
        for conf in confluences:
            if conf["tributary"] == river["name"]:
                # 找到汇入点在主河流中的位置，继续追踪
                main_river = _find_river_by_name(conf["main"], rivers)
                if main_river and conf["at_station"] in main_river["stations"]:
                    join_idx = main_river["stations"].index(conf["at_station"])
                    for i in range(join_idx, len(main_river["stations"])):
                        ds_name = main_river["stations"][i]
                        if ds_name not in visited and ds_name in station_map:
                            visited.add(ds_name)
                            downstream.append(station_map[ds_name])

    return downstream


def _resolve_upstream(station_name, topo, station_map, visited=None):
    """递归查找上游站点（含支流溯源）"""
    if visited is None:
        visited = set()
    if station_name in visited:
        return []
    visited.add(station_name)

    rivers = topo["rivers"]
    confluences = topo["confluences"]
    upstream = []

    locations = _find_station_in_rivers(station_name, rivers)
    for loc in locations:
        river = loc["river"]
        idx = loc["index"]
        # 该河流中索引更小的站点是上游
        for i in range(idx - 1, -1, -1):
            us_name = river["stations"][i]
            if us_name not in visited and us_name in station_map:
                visited.add(us_name)
                upstream.append(station_map[us_name])

        # 检查是否有支流在本站或上游汇入
        for conf in confluences:
            if conf["main"] == river["name"] and conf["at_station"] in river["stations"]:
                join_idx = river["stations"].index(conf["at_station"])
                if join_idx <= idx:
                    # 支流在当前站点或上游汇入，追踪支流全部站点
                    trib_river = _find_river_by_name(conf["tributary"], rivers)
                    if trib_river:
                        for ts_name in reversed(trib_river["stations"]):
                            if ts_name not in visited and ts_name in station_map:
                                visited.add(ts_name)
                                upstream.append(station_map[ts_name])

    return upstream


def do_downstream(args):
    station_map = _load_station_map()
    topo, err = load_river_topology()
    if err:
        error_exit(err)

    station_name = args.station
    if station_name not in station_map:
        error_exit(f"未找到水文站: {station_name}")

    origin = station_map[station_name]
    downstream = _resolve_downstream(station_name, topo, station_map)
    affected_cities = list(set(s.get("city", "") for s in downstream if s.get("city")))

    # 找到所在河流名
    locations = _find_station_in_rivers(station_name, topo["rivers"])
    river_name = locations[0]["river"]["name"] if locations else "未知"

    # 构建 bindmap_ready
    layers = [
        build_marker_layer([origin], "起点站"),
    ]
    if downstream:
        layers.append(build_marker_layer(downstream, f"下游站点({len(downstream)})"))
    if affected_cities:
        city_items = []
        for city in affected_cities:
            geo, _ = geocode_location(city)
            if geo:
                city_items.append({"name": city, "lat": geo["lat"], "lng": geo["lng"]})
        if city_items:
            layers.append(build_marker_layer(city_items, f"受影响城市({len(city_items)})"))

    output = {
        "operation": "downstream",
        "station": station_name,
        "river": river_name,
        "downstream_stations": [
            {"name": s["name"], "city": s.get("city", ""),
             "lat": s["lat"], "lng": s["lng"],
             "warning_level": s.get("warning_level")}
            for s in downstream
        ],
        "affected_cities": affected_cities,
        "bindmap_ready": {
            "layers": layers,
            "title": f"{station_name}下游影响分析",
        },
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


def do_upstream(args):
    station_map = _load_station_map()
    topo, err = load_river_topology()
    if err:
        error_exit(err)

    station_name = args.station
    if station_name not in station_map:
        error_exit(f"未找到水文站: {station_name}")

    origin = station_map[station_name]
    upstream = _resolve_upstream(station_name, topo, station_map)

    locations = _find_station_in_rivers(station_name, topo["rivers"])
    river_name = locations[0]["river"]["name"] if locations else "未知"

    layers = [
        build_marker_layer([origin], "当前站点"),
    ]
    if upstream:
        layers.append(build_marker_layer(upstream, f"上游站点({len(upstream)})"))

    output = {
        "operation": "upstream",
        "station": station_name,
        "river": river_name,
        "upstream_stations": [
            {"name": s["name"], "city": s.get("city", ""),
             "lat": s["lat"], "lng": s["lng"],
             "warning_level": s.get("warning_level")}
            for s in upstream
        ],
        "bindmap_ready": {
            "layers": layers,
            "title": f"{station_name}上游溯源分析",
        },
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


def do_river_bindmap(args):
    station_map = _load_station_map()
    topo, err = load_river_topology()
    if err:
        error_exit(err)

    river_name = args.river
    river = _find_river_by_name(river_name, topo["rivers"])
    if not river:
        error_exit(f"未找到河流: {river_name}，支持: {[r['name'] for r in topo['rivers']]}")

    stations = []
    missing = []
    for sname in river["stations"]:
        if sname in station_map:
            stations.append(station_map[sname])
        else:
            missing.append(sname)

    # 查找汇入本河流的支流
    tributaries = []
    for conf in topo["confluences"]:
        if conf["main"] == river["name"]:
            tributaries.append({
                "tributary": conf["tributary"],
                "at_station": conf["at_station"],
                "note": conf.get("note", ""),
            })

    layers = []
    if stations:
        layers.append(build_marker_layer(stations, f"{river['name']}站点({len(stations)})"))

    # 添加支流汇入点标记
    if tributaries:
        trib_items = []
        for t in tributaries:
            if t["at_station"] in station_map:
                s = station_map[t["at_station"]]
                trib_items.append({
                    "name": f"{t['tributary']}汇入({t['at_station']})",
                    "lat": s["lat"], "lng": s["lng"],
                })
        if trib_items:
            layers.append(build_marker_layer(trib_items, f"支流汇入({len(trib_items)})"))

    output = {
        "operation": "river-bindmap",
        "river": river["name"],
        "station_count": len(stations),
        "stations": [
            {"name": s["name"], "city": s.get("city", ""),
             "lat": s["lat"], "lng": s["lng"],
             "river": s.get("river", ""),
             "warning_level": s.get("warning_level")}
            for s in stations
        ],
        "tributaries": tributaries,
        "bindmap_ready": {
            "layers": layers,
            "title": f"{river['name']}流域水文站分布",
        },
    }
    if missing:
        output["missing_stations"] = missing
    print(json.dumps(output, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="流域关联分析")
    parser.add_argument("--operation", required=True,
                        choices=["downstream", "upstream", "river-bindmap"],
                        help="操作类型")
    parser.add_argument("--station", help="水文站名称（downstream/upstream 用）")
    parser.add_argument("--river", help="河流名称（river-bindmap 用）")
    args = parser.parse_args()

    if args.operation in ("downstream", "upstream"):
        if not args.station:
            error_exit(f"{args.operation} 操作需要 --station 参数")
        if args.operation == "downstream":
            do_downstream(args)
        else:
            do_upstream(args)
    elif args.operation == "river-bindmap":
        if not args.river:
            error_exit("river-bindmap 操作需要 --river 参数")
        do_river_bindmap(args)


if __name__ == "__main__":
    main()
