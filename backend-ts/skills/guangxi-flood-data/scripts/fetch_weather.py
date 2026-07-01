#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fetch_weather.py - 获取广西城市实时天气。

通过 wttr.in 获取天气数据，重点提取 24 小时降雨量。
返回的 rainfall_24h_mm 可直接传入 assess_flood_risk 工具。
"""

import argparse
import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

_CACHE = {}
_CACHE_TTL = 900

_CITY_MAP = {
    "南宁市": "Nanning",
    "南宁": "Nanning",
    "柳州市": "Liuzhou",
    "柳州": "Liuzhou",
    "桂林市": "Guilin",
    "桂林": "Guilin",
    "梧州市": "Wuzhou",
    "梧州": "Wuzhou",
    "北海市": "Beihai",
    "北海": "Beihai",
    "防城港市": "Fangchenggang",
    "防城港": "Fangchenggang",
    "钦州市": "Qinzhou",
    "钦州": "Qinzhou",
    "贵港市": "Guigang",
    "贵港": "Guigang",
    "玉林市": "Yulin",
    "玉林": "Yulin",
    "百色市": "Baise",
    "百色": "Baise",
    "贺州市": "Hezhou",
    "贺州": "Hezhou",
    "河池市": "Hechi",
    "河池": "Hechi",
    "来宾市": "Laibin",
    "来宾": "Laibin",
    "崇左市": "Chongzuo",
    "崇左": "Chongzuo",
}


def _fetch_wttr(city_en: str, include_forecast: bool = False) -> dict:
    cache_key = f"{city_en}_{include_forecast}"
    cached = _CACHE.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        return cached["data"]

    url = f"https://wttr.in/{quote(city_en)}?format=j1"
    headers = {"User-Agent": "RAGSystem-FloodData/1.0"}
    req = Request(url, headers=headers)

    try:
        with urlopen(req, timeout=8) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        return {"error": f"wttr.in HTTP {exc.code}: {exc.reason}", "source": "wttr.in"}
    except URLError as exc:
        return {"error": f"wttr.in 网络不可达: {exc.reason}", "source": "wttr.in"}
    except Exception as exc:
        return {"error": f"请求失败: {exc}", "source": "wttr.in"}

    result = _parse_wttr(raw, include_forecast)
    _CACHE[cache_key] = {"data": result, "ts": time.time()}
    return result


def _parse_wttr(raw: dict, include_forecast: bool) -> dict:
    try:
        current = raw.get("current_condition", [{}])[0]
        weather_days = raw.get("weather", [])

        precip_mm_now = float(current.get("precipMM", 0))
        temp_c = float(current.get("temp_C", 0))
        humidity = int(current.get("humidity", 0))
        desc = current.get("lang_zh", [{}])[0].get("value", "") or current.get("weatherDesc", [{}])[0].get("value", "")

        rainfall_24h = 0.0
        if weather_days:
            today = weather_days[0]
            for hourly in today.get("hourly", []):
                rainfall_24h += float(hourly.get("precipMM", 0))

        result = {
            "source": "wttr.in",
            "temp_c": temp_c,
            "humidity_pct": humidity,
            "description": desc,
            "rainfall_24h_mm": round(rainfall_24h, 1),
            "precip_now_mm": round(precip_mm_now, 1),
        }

        if include_forecast and len(weather_days) >= 2:
            tomorrow = weather_days[1]
            forecast_rain = sum(float(h.get("precipMM", 0)) for h in tomorrow.get("hourly", []))
            result["forecast_rainfall_mm"] = round(forecast_rain, 1)
            result["forecast_note"] = "次日预报降雨量（mm），可传入 assess_flood_risk 的 forecast_rainfall 参数"

        result["usage_hint"] = "rainfall_24h_mm 可直接传入 assess_flood_risk 的 rainfall_24h 参数"
        return result
    except Exception as exc:
        return {"error": f"解析天气数据失败: {exc}", "source": "wttr.in", "raw_keys": list(raw.keys())}


def fetch_weather(location: str, include_forecast: bool = False) -> dict:
    city_en = _CITY_MAP.get(location) or _CITY_MAP.get(location.rstrip("市")) or location

    data = _fetch_wttr(city_en, include_forecast)
    data["location"] = location
    data["city_en"] = city_en

    if "error" in data:
        data["rainfall_24h_mm"] = None
        data["degraded"] = True
        data["degraded_note"] = (
            "天气服务暂时不可用，rainfall_24h_mm 为 null。"
            "可请用户手动提供降雨量，或跳过该城市的风险评估。"
        )
    return data


def main():
    parser = argparse.ArgumentParser(description="获取广西城市实时天气")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--location", help="城市名，如'南宁市'")
    group.add_argument("--batch", help="多城市，逗号分隔")
    parser.add_argument("--include-forecast", action="store_true", help="同时返回次日预报降雨量")
    args = parser.parse_args()

    if args.batch:
        cities = [c.strip() for c in args.batch.split(",") if c.strip()]
        results = [fetch_weather(city, args.include_forecast) for city in cities]
        output = {
            "total": len(results),
            "results": results,
            "usage_hint": (
                "每条结果的 rainfall_24h_mm 可传入 assess_flood_risk 的 rainfall_24h 参数；"
                "配合 guangxi-geodata/geocode.py 获取 geometry(wkt)，即可批量生成风险地图数据"
            ),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    print(json.dumps(fetch_weather(args.location, args.include_forecast), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
