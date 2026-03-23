#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fetch_hydrology.py - 抓取并解析广西水情网页。

支持：
- portal: 入口页链接提取
- river: 江河实时水情表格解析
- reservoir: 水库实时水情表格解析
- all: 一次抓取全部来源

也支持通过 --html-file 读取本地 HTML 进行离线调试。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

SOURCE_CATALOG_PATH = Path(__file__).resolve().parents[1] / "data" / "source_catalog.json"
FALLBACK_STATIONS_PATH = (
    Path(__file__).resolve().parents[2] / "guangxi-geodata" / "data" / "hydrological_stations.json"
)
GEODATA_SCRIPT_DIR = Path(__file__).resolve().parents[2] / "guangxi-geodata" / "scripts"

HEADER_ALIASES = {
    "station_name": ["站名", "测站", "站点", "水文站"],
    "reservoir_name": ["水库名称", "库名", "水库"],
    "river_name": ["河流", "河道", "河名", "水系"],
    "county_name": ["县名", "区县", "行政区", "区域"],
    "water_level": ["水位", "库水位", "实时水位", "当前水位"],
    "warning_level": ["警戒水位", "警戒", "汛限水位", "汛限"],
    "guarantee_level": ["保证水位", "保证"],
    "timestamp": ["时间", "日期", "时刻", "更新时间"],
    "trend": ["趋势", "水势", "涨势", "涨幅", "变幅"],
    "water_level_change": ["涨幅", "变幅"],
    "warning_delta": ["超警", "超警旱", "超警(旱)", "超警（旱）"],
    "flow_rate": ["流量", "流速", "出流"],
    "storage_capacity": ["蓄水量", "库容"],
    "inflow": ["入库流量", "入流", "入库"],
    "outflow": ["出库流量", "出流", "出库", "泄量"],
}

NUMERIC_FIELDS = {
    "water_level",
    "warning_level",
    "guarantee_level",
    "warning_delta",
    "water_level_change",
    "flow_rate",
    "storage_capacity",
    "inflow",
    "outflow",
}


class TableLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tables: List[List[List[str]]] = []
        self.links: List[Dict[str, str]] = []
        self.iframes: List[str] = []
        self._table_depth = 0
        self._current_table: Optional[List[List[str]]] = None
        self._current_row: Optional[List[str]] = None
        self._in_cell = False
        self._cell_chunks: List[str] = []
        self._in_anchor = False
        self._anchor_href = ""
        self._anchor_chunks: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        attrs_map = {key.lower(): (value or "") for key, value in attrs}
        tag = tag.lower()

        if tag == "table":
            if self._table_depth == 0:
                self._current_table = []
            self._table_depth += 1
            return

        if self._table_depth > 0 and tag == "tr":
            self._current_row = []
            return

        if self._table_depth > 0 and tag in {"th", "td"}:
            self._in_cell = True
            self._cell_chunks = []
            return

        if self._in_cell and tag == "br":
            self._cell_chunks.append("\n")

        if tag == "a":
            self._in_anchor = True
            self._anchor_href = attrs_map.get("href", "")
            self._anchor_chunks = []
            return

        if tag == "iframe":
            src = attrs_map.get("src", "").strip()
            if src:
                self.iframes.append(src)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()

        if self._table_depth > 0 and tag in {"th", "td"} and self._in_cell:
            value = _clean_text("".join(self._cell_chunks))
            if self._current_row is not None:
                self._current_row.append(value)
            self._in_cell = False
            self._cell_chunks = []
            return

        if self._table_depth > 0 and tag == "tr":
            if self._current_table is not None and self._current_row is not None:
                row = [cell for cell in self._current_row]
                if any(cell.strip() for cell in row):
                    self._current_table.append(row)
            self._current_row = None
            return

        if tag == "table" and self._table_depth > 0:
            self._table_depth -= 1
            if self._table_depth == 0 and self._current_table is not None:
                cleaned_rows = [row for row in self._current_table if any(cell.strip() for cell in row)]
                if cleaned_rows:
                    self.tables.append(cleaned_rows)
                self._current_table = None
            return

        if tag == "a" and self._in_anchor:
            text = _clean_text("".join(self._anchor_chunks))
            self.links.append({"text": text, "href": self._anchor_href.strip()})
            self._in_anchor = False
            self._anchor_href = ""
            self._anchor_chunks = []

    def handle_data(self, data: str) -> None:
        if self._in_cell:
            self._cell_chunks.append(data)
        if self._in_anchor:
            self._anchor_chunks.append(data)


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\xa0", " ")).strip()


def _normalize_header(value: str) -> str:
    return re.sub(r"[\s()（）\[\]【】:/：.-]+", "", _clean_text(value))


def _normalize_site_key(value: str) -> str:
    normalized = re.sub(r"\s+", "", value or "")
    for suffix in ("水文站", "水库", "站"):
        if normalized.endswith(suffix):
            normalized = normalized[: -len(suffix)]
    return normalized


def _parse_number(value: str) -> Optional[float]:
    text = _clean_text(value)
    if not text or text in {"--", "-", "/", "无"}:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text.replace(",", ""))
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _coerce_value(field: str, value: str):
    if field in NUMERIC_FIELDS:
        return _parse_number(value)
    return _clean_text(value)


def _load_source_catalog() -> Dict[str, Dict[str, str]]:
    raw = json.loads(SOURCE_CATALOG_PATH.read_text(encoding="utf-8"))
    return {item["key"]: item for item in raw}


def _load_warning_fallbacks() -> Dict[str, Dict[str, object]]:
    if not FALLBACK_STATIONS_PATH.exists():
        return {}
    data = json.loads(FALLBACK_STATIONS_PATH.read_text(encoding="utf-8"))
    lookup = {}
    for item in data:
        key = _normalize_site_key(item.get("name", ""))
        if key:
            lookup[key] = item
    return lookup


def _load_geodata_city_lookup() -> Dict[str, str]:
    """从 _geodata.py 加载区县→市映射，用于站名/县名反查城市。"""
    lookup: Dict[str, str] = {}
    geodata_path = GEODATA_SCRIPT_DIR / "_geodata.py"
    if not geodata_path.exists():
        return lookup
    ns: Dict[str, object] = {}
    exec(geodata_path.read_text(encoding="utf-8"), ns)
    cities = ns.get("GUANGXI_CITIES", {})
    districts = ns.get("GUANGXI_DISTRICTS", {})
    # 市名本身及别名 → 市
    for city_name, info in cities.items():
        lookup[city_name.rstrip("市")] = city_name
        for alias in info.get("aliases", []):
            lookup[alias] = city_name
    # 区县名及别名 → parent（市）
    for dist_name, info in districts.items():
        parent = info.get("parent", "")
        for suffix in ("区", "县", "市"):
            if dist_name.endswith(suffix):
                lookup[dist_name[: -len(suffix)]] = parent
                break
        lookup[dist_name] = parent
        for alias in info.get("aliases", []):
            lookup[alias] = parent
    return lookup


def _guess_encoding(raw_bytes: bytes, content_type: str) -> str:
    match = re.search(r"charset=([A-Za-z0-9_-]+)", content_type or "", re.IGNORECASE)
    if match:
        return match.group(1)

    head = raw_bytes[:1000].decode("ascii", errors="ignore")
    meta_match = re.search(r"charset=([A-Za-z0-9_-]+)", head, re.IGNORECASE)
    if meta_match:
        return meta_match.group(1)
    return "utf-8"


def _fetch_html(url: str, timeout: int) -> Dict[str, object]:
    request = Request(url, headers={"User-Agent": "RAGSystem-FloodData/1.0"})
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            content_type = response.headers.get("Content-Type", "")
            encoding = _guess_encoding(raw, content_type)
            html = raw.decode(encoding, errors="replace")
            return {"ok": True, "html": html, "encoding": encoding, "status_code": getattr(response, "status", 200)}
    except HTTPError as exc:
        return {"ok": False, "error": f"HTTP {exc.code}: {exc.reason}"}
    except URLError as exc:
        return {"ok": False, "error": f"网络不可达: {exc.reason}"}
    except Exception as exc:
        return {"ok": False, "error": f"请求失败: {exc}"}


def _header_match_score(header: str, source_kind: str) -> int:
    normalized = _normalize_header(header)
    score = 0
    for field, aliases in HEADER_ALIASES.items():
        for alias in aliases:
            if alias in normalized:
                score += 3
    if source_kind == "river" and "河流" in normalized:
        score += 2
    if source_kind == "reservoir" and "水库" in normalized:
        score += 2
    if source_kind == "river" and "河名" in normalized:
        score += 2
    if source_kind == "reservoir" and "县名" in normalized:
        score += 2
    return score


def _select_table(tables: List[List[List[str]]], source_kind: str) -> Tuple[Optional[int], Optional[int], List[str], List[List[str]]]:
    best = (-1, None, None, [], [])
    for table_index, rows in enumerate(tables):
        if len(rows) < 2:
            continue
        for header_index, row in enumerate(rows):
            non_empty = [cell for cell in row if _clean_text(cell)]
            if len(non_empty) < 2:
                continue
            score = sum(_header_match_score(cell, source_kind) for cell in non_empty)
            score += len(non_empty)
            normalized_headers = [_normalize_header(cell) for cell in non_empty]
            if source_kind == "river":
                if any("站名" in item for item in normalized_headers):
                    score += 8
                if any("河名" in item or "河流" in item for item in normalized_headers):
                    score += 6
                if any("流量" in item for item in normalized_headers):
                    score += 4
            if source_kind == "reservoir":
                if any("站名" in item or "水库" in item for item in normalized_headers):
                    score += 8
                if any("县名" in item for item in normalized_headers):
                    score += 6
                if any("蓄水量" in item for item in normalized_headers):
                    score += 4
            data_rows = rows[header_index + 1 :]
            if data_rows:
                avg_width = sum(len(r) for r in data_rows[:5]) / min(len(data_rows), 5)
                score += int(avg_width)
            if score > best[0]:
                best = (score, table_index, header_index, row, data_rows)

    _, table_index, header_index, headers, data_rows = best
    if table_index is None or header_index is None:
        return None, None, [], []
    return table_index, header_index, _dedupe_headers(headers), data_rows


def _dedupe_headers(headers: List[str]) -> List[str]:
    seen: Dict[str, int] = {}
    result = []
    for index, header in enumerate(headers, start=1):
        candidate = _clean_text(header) or f"col_{index}"
        count = seen.get(candidate, 0) + 1
        seen[candidate] = count
        if count > 1:
            candidate = f"{candidate}_{count}"
        result.append(candidate)
    return result


def _canonical_field(header: str, source_kind: str) -> Optional[str]:
    normalized = _normalize_header(header)
    if not normalized:
        return None

    priority = [
        "warning_level",
        "guarantee_level",
        "water_level",
        "warning_delta",
        "water_level_change",
        "flow_rate",
        "storage_capacity",
        "timestamp",
        "river_name",
        "reservoir_name",
        "station_name",
        "county_name",
        "inflow",
        "outflow",
        "trend",
    ]
    for field in priority:
        for alias in HEADER_ALIASES[field]:
            if alias in normalized:
                return field

    if "名称" in normalized:
        if source_kind == "reservoir":
            return "reservoir_name"
        if source_kind == "river":
            return "station_name"
    if source_kind == "river" and "站名" in normalized:
        return "station_name"
    if source_kind == "reservoir" and "站名" in normalized:
        return "reservoir_name"
    return None


def _row_to_record(headers: List[str], row: List[str], source_kind: str, warning_lookup: Dict[str, Dict[str, object]], city_lookup: Dict[str, str] = None) -> Dict[str, object]:
    values = list(row[: len(headers)]) + [""] * max(0, len(headers) - len(row))
    raw = {headers[index]: _clean_text(values[index]) for index in range(len(headers))}
    record: Dict[str, object] = {
        "site_name": None,
        "station_name": None,
        "reservoir_name": None,
        "river_name": None,
        "county_name": None,
        "city": None,
        "water_level": None,
        "warning_level": None,
        "guarantee_level": None,
        "warning_delta": None,
        "water_level_change": None,
        "flow_rate": None,
        "storage_capacity": None,
        "timestamp": None,
        "trend": None,
        "inflow": None,
        "outflow": None,
        "warning_level_source": None,
        "source_kind": source_kind,
        "raw": raw,
    }

    for header, value in raw.items():
        field = _canonical_field(header, source_kind)
        if field is None or record.get(field) not in (None, ""):
            continue
        record[field] = _coerce_value(field, value)

    record["site_name"] = (
        record.get("station_name")
        or record.get("reservoir_name")
        or raw.get("名称")
        or raw.get("站名")
        or raw.get("水库名称")
    )
    if source_kind == "reservoir" and record.get("reservoir_name") is None and record.get("site_name"):
        record["reservoir_name"] = record["site_name"]
    if source_kind == "river" and record.get("station_name") is None and record.get("site_name"):
        record["station_name"] = record["site_name"]

    if record.get("warning_level") is not None:
        record["warning_level_source"] = "page"

    site_key = _normalize_site_key(str(record.get("site_name") or ""))
    fallback = warning_lookup.get(site_key)
    if fallback:
        if record.get("warning_level") is None and fallback.get("warning_level") is not None:
            record["warning_level"] = fallback.get("warning_level")
            record["warning_level_source"] = "static_fallback"
        if not record.get("river_name") and fallback.get("river"):
            record["river_name"] = fallback.get("river")
        if not record.get("station_name") and fallback.get("name"):
            record["station_name"] = fallback.get("name")
        if not record.get("city") and fallback.get("city"):
            record["city"] = fallback.get("city")

    # 二级回填：通过县名或站名查 _geodata 区县→市映射
    if not record.get("city") and city_lookup:
        for candidate in (record.get("county_name"), record.get("site_name"), record.get("station_name")):
            if not candidate:
                continue
            candidate = str(candidate).strip()
            city = city_lookup.get(candidate)
            if not city:
                # 去掉常见后缀再试
                for suffix in ("县", "区", "市", "水文站", "水库", "站", "镇"):
                    if candidate.endswith(suffix):
                        city = city_lookup.get(candidate[: -len(suffix)])
                        if city:
                            break
            if city:
                record["city"] = city
                break

    water_level = record.get("water_level")
    warning_level = record.get("warning_level")
    if isinstance(water_level, (float, int)) and isinstance(warning_level, (float, int)):
        record["exceed_warning_level"] = round(water_level - warning_level, 3)
    else:
        record["exceed_warning_level"] = None

    return record


def _is_valid_record(record: Dict[str, object]) -> bool:
    site_name = str(record.get("site_name") or "")
    if not any(record.get(key) not in (None, "") for key in ("site_name", "water_level", "timestamp")):
        return False
    if site_name in {"站名", "水库名称", "名称"}:
        return False
    if site_name.startswith("第") and "页" in site_name:
        return False
    return True


def _filter_records(records: List[Dict[str, object]], keyword: Optional[str], limit: int) -> List[Dict[str, object]]:
    records = [record for record in records if _is_valid_record(record)]
    if keyword:
        keyword = keyword.strip()
        filtered = []
        for record in records:
            haystacks = [
                str(record.get("site_name") or ""),
                str(record.get("station_name") or ""),
                str(record.get("river_name") or ""),
                str(record.get("reservoir_name") or ""),
                str(record.get("county_name") or ""),
            ]
            if any(keyword in value for value in haystacks):
                filtered.append(record)
        records = filtered
    return records[:limit] if limit > 0 else records


def _parse_source(
    source: Dict[str, str],
    html: str,
    base_url: str,
    encoding: str,
    keyword: Optional[str],
    limit: int,
    warning_lookup: Dict[str, Dict[str, object]],
    city_lookup: Dict[str, str] = None,
) -> Dict[str, object]:
    parser = TableLinkParser()
    parser.feed(html)

    table_index, _, headers, rows = _select_table(parser.tables, source["source_kind"])
    records: List[Dict[str, object]] = []
    if table_index is not None:
        for row in rows:
            if len([cell for cell in row if _clean_text(cell)]) < 2:
                continue
            records.append(_row_to_record(headers, row, source["source_kind"], warning_lookup, city_lookup))

    records = _filter_records(records, keyword, limit)
    links = []
    for item in parser.links:
        href = item.get("href", "")
        if not href:
            continue
        links.append({"text": item.get("text", ""), "href": href, "absolute_url": urljoin(base_url, href)})

    iframe_links = [urljoin(base_url, item) for item in parser.iframes]
    return {
        "source_key": source["key"],
        "source_name": source["name"],
        "source_kind": source["source_kind"],
        "source_url": base_url,
        "encoding": encoding,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "tables_found": len(parser.tables),
        "selected_table_index": table_index,
        "columns": headers,
        "record_count": len(records),
        "records": records,
        "links": links,
        "iframe_links": iframe_links,
    }


def _build_source_override(source_key: str, url: str) -> Dict[str, str]:
    return {
        "key": source_key,
        "name": f"自定义来源({source_key})",
        "source_kind": source_key if source_key in {"portal", "river", "reservoir"} else "custom",
        "url": url,
        "description": "由 --url 覆盖的自定义来源",
    }


def _resolve_sources(source_catalog: Dict[str, Dict[str, str]], source_arg: str) -> List[Dict[str, str]]:
    if source_arg == "all":
        return [source_catalog[key] for key in ("portal", "river", "reservoir")]
    if source_arg not in source_catalog:
        raise ValueError(f"未知来源: {source_arg}")
    return [source_catalog[source_arg]]


def _build_compact_output(
    requested_source: str,
    results: List[Dict[str, object]],
    errors: List[Dict[str, object]],
) -> Dict[str, object]:
    output: Dict[str, object] = {}

    for result in results:
        source_kind = str(result.get("source_kind") or "")
        records = result.get("records") or []
        if source_kind in {"river", "reservoir"}:
            if records:
                output[source_kind] = records
            continue

        if source_kind == "portal" and requested_source == "portal":
            portal_payload = {}
            links = result.get("links") or []
            iframe_links = result.get("iframe_links") or []
            if links:
                portal_payload["links"] = links
            if iframe_links:
                portal_payload["iframe_links"] = iframe_links
            if portal_payload:
                output["portal"] = portal_payload

    if not output and requested_source != "all":
        for result in results:
            source_kind = str(result.get("source_kind") or "")
            if source_kind != requested_source:
                continue
            if source_kind in {"river", "reservoir"}:
                output[source_kind] = result.get("records") or []
            elif source_kind == "portal":
                output["portal"] = {
                    "links": result.get("links") or [],
                    "iframe_links": result.get("iframe_links") or [],
                }
            break

    if errors:
        output["errors"] = errors
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description="抓取并解析广西水情网页")
    parser.add_argument("--source", choices=["all", "portal", "river", "reservoir"], default="all")
    parser.add_argument("--url", help="覆盖内置来源 URL")
    parser.add_argument("--html-file", help="读取本地 HTML 文件用于离线调试")
    parser.add_argument("--keyword", help="按站名、河流名或水库名过滤")
    parser.add_argument("--limit", type=int, default=50, help="最多返回记录数，默认 50")
    parser.add_argument("--timeout", type=int, default=15, help="请求超时秒数，默认 15")
    parser.add_argument("--list-sources", action="store_true", help="输出内置来源配置并退出")
    args = parser.parse_args()

    source_catalog = _load_source_catalog()
    if args.list_sources:
        print(json.dumps({"sources": list(source_catalog.values())}, ensure_ascii=False, indent=2))
        return 0

    warning_lookup = _load_warning_fallbacks()
    city_lookup = _load_geodata_city_lookup()
    sources = _resolve_sources(source_catalog, args.source)

    if args.url:
        if len(sources) != 1:
            print(json.dumps({"error": "--url 仅支持与单一 --source 搭配使用"}, ensure_ascii=False, indent=2))
            return 0
        sources = [_build_source_override(sources[0]["key"], args.url)]

    if args.html_file and len(sources) != 1:
        print(json.dumps({"error": "--html-file 仅支持与单一 --source 搭配使用"}, ensure_ascii=False, indent=2))
        return 0

    results = []
    errors = []
    for source in sources:
        if args.html_file:
            html_path = Path(args.html_file).resolve()
            try:
                html = html_path.read_text(encoding="utf-8")
                result = _parse_source(source, html, source["url"], "utf-8", args.keyword, args.limit, warning_lookup, city_lookup)
                result["html_file"] = str(html_path)
                results.append(result)
            except Exception as exc:
                errors.append({"source_key": source["key"], "error": f"读取 HTML 文件失败: {exc}"})
            continue

        fetch_result = _fetch_html(source["url"], timeout=args.timeout)
        if not fetch_result.get("ok"):
            errors.append({"source_key": source["key"], "error": fetch_result.get("error"), "url": source["url"]})
            results.append(
                {
                    "source_key": source["key"],
                    "source_name": source["name"],
                    "source_kind": source["source_kind"],
                    "source_url": source["url"],
                    "record_count": 0,
                    "records": [],
                    "links": [],
                    "iframe_links": [],
                    "tables_found": 0,
                    "selected_table_index": None,
                    "columns": [],
                    "degraded": True,
                    "error": fetch_result.get("error"),
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            continue

        results.append(
            _parse_source(
                source,
                str(fetch_result["html"]),
                source["url"],
                str(fetch_result["encoding"]),
                args.keyword,
                args.limit,
                warning_lookup,
                city_lookup,
            )
        )

    output = _build_compact_output(args.source, results, errors)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
