# -*- coding: utf-8 -*-

import importlib.util
import shutil
import tempfile
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
FLOOD_DATA_DIR = ROOT_DIR / "agents" / "skills" / "guangxi-flood-data"
GEODATA_DIR = ROOT_DIR / "agents" / "skills" / "guangxi-geodata"


def _load_module(module_name: str, path: Path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_temp_dir() -> str:
    return tempfile.mkdtemp(dir=Path(__file__).resolve().parent)


def test_fetch_hydrology_parses_river_sample_html():
    mod = _load_module(
        "guangxi_flood_data_fetch_hydrology",
        FLOOD_DATA_DIR / "scripts" / "fetch_hydrology.py",
    )

    source_catalog = mod._load_source_catalog()
    warning_lookup = mod._load_warning_fallbacks()
    html = (FLOOD_DATA_DIR / "references" / "fixtures" / "river_sample.html").read_text(encoding="utf-8")

    result = mod._parse_source(
        source=source_catalog["river"],
        html=html,
        base_url=source_catalog["river"]["url"],
        encoding="utf-8",
        keyword=None,
        limit=50,
        warning_lookup=warning_lookup,
    )

    assert result["record_count"] == 2
    first = result["records"][0]
    assert first["site_name"] == "柳州水文站"
    assert first["river_name"] == "柳江"
    assert first["water_level"] == 83.6
    assert first["warning_level"] == 82.5
    assert first["warning_level_source"] == "page"


def test_fetch_hydrology_parses_real_like_river_table_layout():
    mod = _load_module(
        "guangxi_flood_data_fetch_hydrology_real_like",
        FLOOD_DATA_DIR / "scripts" / "fetch_hydrology.py",
    )

    source_catalog = mod._load_source_catalog()
    warning_lookup = mod._load_warning_fallbacks()
    html = (
        "<html><body><table>"
        "<tr><td>广西实时水情</td></tr>"
        "<tr><td>查询条件</td><td>单位：m,m3/s</td></tr>"
        "<tr><td>站名</td><td>河名</td><td>时间</td><td>水位(m)</td><td>流量(m3/s)</td><td>超警(旱)</td><td>涨幅(m)</td><td>涨势</td></tr>"
        "<tr><td>田东</td><td>右江</td><td>2026/3/16 15:00:00</td><td>99.94</td><td>736</td><td>-0.560</td><td>0.050</td><td>涨</td></tr>"
        "<tr><td>第1页</td><td>下一页</td></tr>"
        "</table></body></html>"
    )

    result = mod._parse_source(
        source=source_catalog["river"],
        html=html,
        base_url=source_catalog["river"]["url"],
        encoding="utf-8",
        keyword=None,
        limit=50,
        warning_lookup=warning_lookup,
    )

    assert result["columns"] == ["站名", "河名", "时间", "水位(m)", "流量(m3/s)", "超警(旱)", "涨幅(m)", "涨势"]
    assert result["record_count"] == 1
    first = result["records"][0]
    assert first["station_name"] == "田东"
    assert first["river_name"] == "右江"
    assert first["water_level"] == 99.94
    assert first["flow_rate"] == 736.0
    assert first["warning_delta"] == -0.56
    assert first["water_level_change"] == 0.05
    assert first["trend"] == "涨"


def test_fetch_hydrology_parses_real_like_reservoir_table_layout():
    mod = _load_module(
        "guangxi_flood_data_fetch_hydrology_reservoir_real_like",
        FLOOD_DATA_DIR / "scripts" / "fetch_hydrology.py",
    )

    source_catalog = mod._load_source_catalog()
    warning_lookup = mod._load_warning_fallbacks()
    html = (
        "<html><body><table>"
        "<tr><td>广西水库实时水情</td></tr>"
        "<tr><td>查询时间</td><td>2026/3/16</td></tr>"
        "<tr><td>站名</td><td>县名</td><td>时间</td><td>水位(m)</td><td>蓄水量(百万m³)</td></tr>"
        "<tr><td>大藤峡水利枢纽</td><td>桂平市</td><td>2026/3/16 15:00:00</td><td>59.920</td><td>2623.440000</td></tr>"
        "<tr><td>第1页</td><td>下一页</td></tr>"
        "</table></body></html>"
    )

    result = mod._parse_source(
        source=source_catalog["reservoir"],
        html=html,
        base_url=source_catalog["reservoir"]["url"],
        encoding="utf-8",
        keyword=None,
        limit=50,
        warning_lookup=warning_lookup,
    )

    assert result["columns"] == ["站名", "县名", "时间", "水位(m)", "蓄水量(百万m³)"]
    assert result["record_count"] == 1
    first = result["records"][0]
    assert first["reservoir_name"] == "大藤峡水利枢纽"
    assert first["county_name"] == "桂平市"
    assert first["water_level"] == 59.92
    assert first["storage_capacity"] == 2623.44


def test_fetch_hydrology_backfills_warning_level_from_static_geodata():
    mod = _load_module(
        "guangxi_flood_data_fetch_hydrology_fallback",
        FLOOD_DATA_DIR / "scripts" / "fetch_hydrology.py",
    )

    source_catalog = mod._load_source_catalog()
    warning_lookup = mod._load_warning_fallbacks()
    html = (
        "<html><body><table>"
        "<tr><th>站名</th><th>水位(m)</th><th>时间</th></tr>"
        "<tr><td>柳州水文站</td><td>83.6</td><td>2026-03-16 08:00</td></tr>"
        "</table></body></html>"
    )

    result = mod._parse_source(
        source=source_catalog["river"],
        html=html,
        base_url=source_catalog["river"]["url"],
        encoding="utf-8",
        keyword=None,
        limit=50,
        warning_lookup=warning_lookup,
    )

    assert result["record_count"] == 1
    first = result["records"][0]
    assert first["station_name"] == "柳州水文站"
    assert first["warning_level"] == 82.5
    assert first["warning_level_source"] == "static_fallback"
    assert first["river_name"] == "柳江"
    assert first["exceed_warning_level"] == 1.1


def test_fetch_hydrology_compact_output_keeps_only_data_sources_for_all():
    mod = _load_module(
        "guangxi_flood_data_fetch_hydrology_compact",
        FLOOD_DATA_DIR / "scripts" / "fetch_hydrology.py",
    )

    output = mod._build_compact_output(
        "all",
        [
            {
                "source_kind": "portal",
                "records": [],
                "links": [{"text": "入口页", "absolute_url": "https://example.com"}],
                "iframe_links": ["https://example.com/frame"],
            },
            {
                "source_kind": "river",
                "records": [{"site_name": "柳州水文站", "water_level": 83.6}],
            },
            {
                "source_kind": "reservoir",
                "records": [{"site_name": "大藤峡水利枢纽", "water_level": 59.92}],
            },
        ],
        [],
    )

    assert output == {
        "river": [{"site_name": "柳州水文站", "water_level": 83.6}],
        "reservoir": [{"site_name": "大藤峡水利枢纽", "water_level": 59.92}],
    }


def test_fetch_weather_marks_degraded_when_upstream_request_fails(monkeypatch):
    mod = _load_module(
        "guangxi_flood_data_fetch_weather",
        FLOOD_DATA_DIR / "scripts" / "fetch_weather.py",
    )

    monkeypatch.setattr(
        mod,
        "_fetch_wttr",
        lambda city_en, include_forecast=False: {
            "error": "network denied",
            "source": "wttr.in",
        },
    )

    result = mod.fetch_weather("南宁市", include_forecast=True)

    assert result["location"] == "南宁市"
    assert result["city_en"] == "Nanning"
    assert result["degraded"] is True
    assert result["rainfall_24h_mm"] is None
    assert "degraded_note" in result


def test_guangxi_geodata_static_dataset_still_available():
    path = GEODATA_DIR / "data" / "hydrological_stations.json"
    assert path.exists() is True


def test_guangxi_geodata_no_longer_contains_fetch_weather_script():
    temp_dir = Path(_make_temp_dir())
    try:
        legacy_script = GEODATA_DIR / "scripts" / "fetch_weather.py"
        snapshot = temp_dir / "snapshot.txt"
        snapshot.write_text(str(legacy_script), encoding="utf-8")
        assert legacy_script.exists() is False
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
