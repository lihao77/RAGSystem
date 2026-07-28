#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
situation_assess.py - 态势研判

聚合气象、水文、预警数据，形成态势概览。
用法:
  python scripts/situation_assess.py --location "南宁市" --rainfall 180 --water-level 78.5 --warning-level 77.0
"""

import sys
import json
import argparse


def assess_situation(args):
    """聚合态势数据并生成概览。"""
    situation = {
        "location": args.location,
        "meteorological": {},
        "hydrological": {},
        "warnings": [],
        "summary": [],
    }

    # 气象数据
    if args.rainfall is not None:
        situation["meteorological"]["rainfall_24h_mm"] = args.rainfall
        if args.rainfall >= 250:
            situation["summary"].append(f"特大暴雨：24小时降雨量 {args.rainfall}mm")
        elif args.rainfall >= 100:
            situation["summary"].append(f"暴雨：24小时降雨量 {args.rainfall}mm")
        elif args.rainfall >= 50:
            situation["summary"].append(f"大雨：24小时降雨量 {args.rainfall}mm")
        else:
            situation["summary"].append(f"降雨量 {args.rainfall}mm")

    if args.forecast_rainfall is not None:
        situation["meteorological"]["forecast_rainfall_24h_mm"] = args.forecast_rainfall
        if args.forecast_rainfall >= 100:
            situation["summary"].append(f"预报未来24小时降雨 {args.forecast_rainfall}mm，需高度关注")

    # 水文数据
    if args.water_level is not None:
        situation["hydrological"]["water_level_m"] = args.water_level
        if args.warning_level is not None:
            situation["hydrological"]["warning_level_m"] = args.warning_level
            exceed = args.water_level - args.warning_level
            situation["hydrological"]["exceed_warning_m"] = round(exceed, 2)
            if exceed > 0:
                situation["summary"].append(f"水位超警戒 {exceed:.2f}m（当前 {args.water_level}m / 警戒 {args.warning_level}m）")
            else:
                situation["summary"].append(f"水位未超警（当前 {args.water_level}m / 警戒 {args.warning_level}m）")
        else:
            situation["summary"].append(f"当前水位 {args.water_level}m（未提供警戒水位）")

    # 预警信息
    if args.warnings:
        try:
            warning_list = json.loads(args.warnings)
            situation["warnings"] = warning_list
            situation["summary"].append(f"当前生效 {len(warning_list)} 条预警")
        except json.JSONDecodeError:
            situation["warnings"] = [{"raw": args.warnings}]

    # 综合评语
    if not situation["summary"]:
        situation["overall"] = "数据不足，无法形成有效态势研判"
    else:
        situation["overall"] = f"{args.location}当前态势：{'；'.join(situation['summary'])}"

    return situation


def main():
    parser = argparse.ArgumentParser(description="态势研判")
    parser.add_argument("--location", required=True, help="评估地点")
    parser.add_argument("--rainfall", type=float, default=None, help="24小时降雨量(mm)")
    parser.add_argument("--forecast-rainfall", type=float, default=None, help="预报降雨量(mm)")
    parser.add_argument("--water-level", type=float, default=None, help="当前水位(m)")
    parser.add_argument("--warning-level", type=float, default=None, help="警戒水位(m)")
    parser.add_argument("--warnings", default=None, help="预警信息(JSON)")
    args = parser.parse_args()

    result = assess_situation(args)
    json.dump({"success": True, "data": result}, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
