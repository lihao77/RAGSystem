#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fetch_warning.py - 获取中央气象台气象预警信息。

数据源：http://www.nmc.cn/rest/findAlarm
支持按省份、城市、预警类型、预警级别过滤。
输出标准化 JSON，可直接传入 situation_assess.py --warnings。
"""

import argparse
import json
import re
import sys
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime

try:
    import _cache
except ImportError:
    _cache = None

BASE_URL = "http://www.nmc.cn/rest/findAlarm"

LEVEL_COLOR_MAP = {
    "红色": "red",
    "橙色": "orange",
    "黄色": "yellow",
    "蓝色": "blue",
}

# 正则：从 title 中解析城市、预警类型、预警级别
# 示例: "南宁市气象台发布暴雨橙色预警信号"
TITLE_PATTERN = re.compile(
    r"(?P<city>[\u4e00-\u9fa5]+?(?:市|县|区|州|盟))"
    r".*?发布"
    r"(?P<type>[\u4e00-\u9fa5]+?)"
    r"(?P<level>红色|橙色|黄色|蓝色)"
    r"预警"
)


def _fetch_json(url: str, timeout: int = 15) -> dict:
    """请求 URL 返回 JSON dict。"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_title(title: str) -> dict:
    """从预警标题中解析城市、类型、级别。"""
    m = TITLE_PATTERN.search(title or "")
    if not m:
        return {"city": None, "warning_type": None, "warning_level": None, "warning_color": None}
    level = m.group("level")
    return {
        "city": m.group("city"),
        "warning_type": m.group("type"),
        "warning_level": level,
        "warning_color": LEVEL_COLOR_MAP.get(level),
    }


def fetch_warnings(province="广西", city=None, warning_type=None,
                   warning_level=None, page_size=50) -> dict:
    """获取气象预警信息，返回标准化结果。"""
    cache_params = {
        "province": province, "city": city or "",
        "type": warning_type or "", "level": warning_level or "",
        "page_size": page_size,
    }
    if _cache:
        cached = _cache.get("warning", cache_params, ttl=300)
        if cached:
            return cached

    encoded_province = urllib.parse.quote(province)
    url = (f"{BASE_URL}?pageNo=1&pageSize={page_size}"
           f"&signaltype=&signallevel=&province={encoded_province}")

    try:
        raw = _fetch_json(url)
    except Exception as e:
        return {
            "degraded": True,
            "error": str(e),
            "warnings": [],
            "stat": {},
            "total": 0,
            "message": f"气象预警数据获取失败: {e}",
        }

    data = raw.get("data", {})
    alarm_list = (data.get("page") or {}).get("list") or []
    stat = data.get("stat", {})

    warnings = []
    for item in alarm_list:
        title = item.get("title", "")
        parsed = _parse_title(title)

        # 城市过滤
        if city and parsed["city"] and city not in parsed["city"]:
            continue
        # 类型过滤
        if warning_type and parsed["warning_type"] and warning_type not in parsed["warning_type"]:
            continue
        # 级别过滤
        if warning_level and parsed["warning_level"] and warning_level != parsed["warning_level"]:
            continue

        warnings.append({
            "title": title,
            "city": parsed["city"],
            "warning_type": parsed["warning_type"],
            "warning_level": parsed["warning_level"],
            "warning_color": parsed["warning_color"],
            "issued_at": item.get("issuetime"),
            "url": item.get("url"),
            "alert_id": item.get("alertid"),
        })

    result = {
        "warnings": warnings,
        "stat": stat,
        "total": len(warnings),
        "province": province,
        "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    if _cache:
        _cache.put("warning", cache_params, result)

    return result


def main():
    parser = argparse.ArgumentParser(description="获取中央气象台气象预警信息")
    parser.add_argument("--province", default="广西", help="省份名称，默认广西")
    parser.add_argument("--city", default=None, help="城市过滤，如 南宁市")
    parser.add_argument("--type", dest="warning_type", default=None,
                        help="预警类型过滤，如 暴雨、大风、雷电、冰雹")
    parser.add_argument("--level", dest="warning_level", default=None,
                        help="预警级别过滤：红色/橙色/黄色/蓝色")
    parser.add_argument("--page-size", type=int, default=50,
                        help="每页条数，默认50")
    args = parser.parse_args()

    result = fetch_warnings(
        province=args.province,
        city=args.city,
        warning_type=args.warning_type,
        warning_level=args.warning_level,
        page_size=args.page_size,
    )

    json.dump({"success": True, "data": result}, sys.stdout,
              ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
