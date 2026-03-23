#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fetch_rain.py - 查询广西水利厅实时雨情 API

通过 POST 请求获取指定时段内各雨量站累计降雨量。
返回的 accumulated_rain_mm 可直接用于风险评估。

用法:
  python scripts/fetch_rain.py --hours 24
  python scripts/fetch_rain.py --hours 12 --min-rain 50
  python scripts/fetch_rain.py --stnm 水榕树
  python scripts/fetch_rain.py --start-time "2026-03-16 08:00:00" --end-time "2026-03-16 20:00:00"
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import _cache

API_URL = "http://slt.gxzf.gov.cn/gxsl/api/sl323/realtime/rain/history"
TIMEOUT = 15
TZ_CN = timezone(timedelta(hours=8))

# 默认降雨量分级阈值（mm）
DEFAULT_RANGES = {
    "range4": "25",
    "range5": "50",
    "range6": "100",
    "range7": "250",
}


def _build_request_body(start_time: str, end_time: str,
                        stnm: str = "", adcd: str = "") -> dict:
    return {
        "adcd": adcd,
        "stnm": stnm,
        "startTime": start_time,
        "endTime": end_time,
        "range1": "",
        "range2": "",
        "range3": "",
        **DEFAULT_RANGES,
    }


def _fetch_rain_api(body: dict) -> dict:
    cached = _cache.get("rain", body)
    if cached is not None:
        cached["_from_cache"] = True
        return cached

    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = Request(
        API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "RAGSystem-HydrologyWeb/1.0",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=TIMEOUT) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        return {"error": f"HTTP {exc.code}: {exc.reason}"}
    except URLError as exc:
        return {"error": f"网络不可达: {exc.reason}"}
    except Exception as exc:
        return {"error": f"请求失败: {exc}"}

    if "error" not in result:
        _cache.put("rain", body, result)
    return result

def _parse_record(item: dict) -> dict:
    accp = item.get("ACCP")
    rain_mm = None
    if accp is not None:
        try:
            rain_mm = float(accp)
        except (ValueError, TypeError):
            pass
    return {
        "station_code": (item.get("STCD") or "").strip(),
        "station_name": (item.get("STNM") or "").strip(),
        "accumulated_rain_mm": rain_mm,
        "longitude": item.get("LGTD"),
        "latitude": item.get("LTTD"),
        "location": (item.get("STLC") or "").strip(),
    }


def _filter_and_sort(records: list, min_rain: float,
                     sort_order: str, limit: int) -> list:
    if min_rain > 0:
        records = [r for r in records
                   if r["accumulated_rain_mm"] is not None
                   and r["accumulated_rain_mm"] >= min_rain]
    reverse = sort_order == "desc"
    records.sort(
        key=lambda r: r["accumulated_rain_mm"] if r["accumulated_rain_mm"] is not None else -1,
        reverse=reverse,
    )
    return records[:limit] if limit > 0 else records


def main():
    parser = argparse.ArgumentParser(description="查询广西实时雨情")
    parser.add_argument("--hours", type=int, default=24,
                        help="查询最近 N 小时降雨，默认 24")
    parser.add_argument("--start-time", help="自定义起始时间 (YYYY-MM-DD HH:MM:SS)")
    parser.add_argument("--end-time", help="自定义结束时间，默认当前")
    parser.add_argument("--stnm", default="", help="按站名过滤（模糊匹配）")
    parser.add_argument("--adcd", default="", help="按行政区划代码过滤")
    parser.add_argument("--min-rain", type=float, default=0,
                        help="最小降雨量过滤 (mm)")
    parser.add_argument("--limit", type=int, default=100,
                        help="最多返回记录数，默认 100")
    parser.add_argument("--sort", choices=["desc", "asc"], default="desc",
                        help="按降雨量排序，默认 desc")
    args = parser.parse_args()

    now = datetime.now(TZ_CN)
    # 时间截断到分钟，确保同一分钟内的请求能命中缓存
    now = now.replace(second=0, microsecond=0)
    if args.start_time:
        start_time = args.start_time
    else:
        start_time = (now - timedelta(hours=args.hours)).strftime("%Y-%m-%d %H:%M:%S")
    end_time = args.end_time or now.strftime("%Y-%m-%d %H:%M:%S")

    body = _build_request_body(start_time, end_time, args.stnm, args.adcd)
    raw = _fetch_rain_api(body)
    from_cache = raw.pop("_from_cache", False)

    if "error" in raw:
        output = {
            "error": raw["error"],
            "query": {"start_time": start_time, "end_time": end_time},
            "degraded": True,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        sys.exit(0)

    items = raw.get("result") or []
    records = [_parse_record(item) for item in items]
    records = _filter_and_sort(records, args.min_rain, args.sort, args.limit)

    output = {
        "query": {
            "start_time": start_time,
            "end_time": end_time,
            "stnm": args.stnm or None,
            "adcd": args.adcd or None,
            "min_rain_mm": args.min_rain,
        },
        "cached": from_cache,
        "total": len(records),
        "records": records,
        "usage_hint": "accumulated_rain_mm 可传入 assess_flood_risk 的 rainfall_24h 参数",
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

