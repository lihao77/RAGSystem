#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fetch_river.py - 查询广西水利厅实时水情 API

通过 GET 请求获取江河实时水位、流量、超警信息。
支持查询单站水位过程线（历史趋势）。

用法:
  python scripts/fetch_river.py
  python scripts/fetch_river.py --keyword 郁江
  python scripts/fetch_river.py --warn-only
  python scripts/fetch_river.py --history 80700300
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import _cache

API_BASE = "http://slt.gxzf.gov.cn/gxsl/api/sl323/realtime/river/"
TIMEOUT = 15
TZ_CN = timezone(timedelta(hours=8))


def _fetch_json(url: str) -> dict:
    cached = _cache.get("river", {"url": url})
    if cached is not None:
        cached["_from_cache"] = True
        return cached

    req = Request(url, headers={"User-Agent": "RAGSystem-HydrologyWeb/1.0"})
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
        _cache.put("river", {"url": url}, result)
    return result


def _parse_timestamp(tm_value) -> str | None:
    """将毫秒时间戳转为可读字符串。"""
    if tm_value is None:
        return None
    try:
        ts = int(tm_value) / 1000
        return datetime.fromtimestamp(ts, TZ_CN).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError, OSError):
        return str(tm_value)


def _parse_record(item: dict) -> dict:
    warning_level = item.get("WRZ")
    water_level = item.get("Z")
    exceed = None
    is_warning = False
    if isinstance(water_level, (int, float)) and isinstance(warning_level, (int, float)):
        exceed = round(water_level - warning_level, 3)
        is_warning = exceed > 0

    return {
        "station_code": (item.get("STCD") or "").strip(),
        "station_name": (item.get("STNM") or "").strip(),
        "river_name": (item.get("RVNM") or "").strip(),
        "basin_name": (item.get("BSNM") or "").strip(),
        "water_level": water_level,
        "warning_level": warning_level,
        "exceed_warning": exceed,
        "is_warning": is_warning,
        "flow_rate": item.get("Q"),
        "longitude": item.get("LGTD"),
        "latitude": item.get("LTTD"),
        "timestamp": _parse_timestamp(item.get("TM")),
        "station_type": (item.get("STTP") or "").strip(),
        "flood_grade": (item.get("FRGRD") or "").strip(),
        "adcd": (item.get("ADDVCD") or "").strip(),
    }

def _filter_and_sort(records: list, keyword: str | None,
                     warn_only: bool, sort_by: str, limit: int) -> list:
    if warn_only:
        records = [r for r in records if r["is_warning"]]
    if keyword:
        kw = keyword.strip()
        records = [r for r in records if any(
            kw in str(r.get(f) or "")
            for f in ("station_name", "river_name", "basin_name", "station_code")
        )]
    if sort_by == "warn_delta":
        records.sort(
            key=lambda r: r["exceed_warning"] if r["exceed_warning"] is not None else -999,
            reverse=True,
        )
    else:
        records.sort(key=lambda r: r.get("station_name") or "")
    return records[:limit] if limit > 0 else records


def _fetch_history(stcd: str) -> dict:
    url = f"{API_BASE}gcx/{stcd}"
    raw = _fetch_json(url)
    from_cache = raw.pop("_from_cache", False)
    if "error" in raw:
        return raw
    items = raw.get("result") or []
    points = []
    for item in items:
        points.append({
            "water_level": item.get("Z"),
            "flow_rate": item.get("Q"),
            "timestamp": (item.get("TM") or "").strip(),
        })
    return {
        "station_code": stcd,
        "cached": from_cache,
        "total": len(points),
        "points": points,
        "usage_hint": "过程线数据可用于绘制水位趋势图（create_chart 折线图）",
    }


def main():
    parser = argparse.ArgumentParser(description="查询广西实时水情")
    parser.add_argument("--keyword", help="按站名/河流名/流域名过滤")
    parser.add_argument("--warn-only", action="store_true",
                        help="只返回超警站点")
    parser.add_argument("--limit", type=int, default=100,
                        help="最多返回记录数，默认 100")
    parser.add_argument("--sort", choices=["warn_delta", "name"],
                        default="warn_delta", help="排序方式，默认按超警值")
    parser.add_argument("--history", metavar="STCD",
                        help="查询指定站码的水位过程线")
    args = parser.parse_args()

    if args.history:
        output = _fetch_history(args.history)
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    raw = _fetch_json(API_BASE)
    from_cache = raw.pop("_from_cache", False)
    if "error" in raw:
        output = {"error": raw["error"], "degraded": True}
        print(json.dumps(output, ensure_ascii=False, indent=2))
        sys.exit(0)

    items = raw.get("result") or []
    records = [_parse_record(item) for item in items]
    records = _filter_and_sort(records, args.keyword, args.warn_only,
                               args.sort, args.limit)

    warning_count = sum(1 for r in records if r["is_warning"])
    output = {
        "query": {
            "keyword": args.keyword,
            "warn_only": args.warn_only,
        },
        "cached": from_cache,
        "total": len(records),
        "warning_count": warning_count,
        "records": records,
        "usage_hint": (
            "water_level/warning_level 可传入 assess_flood_risk；"
            "用 --history STCD 可获取单站过程线"
        ),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
