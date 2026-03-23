---
name: guangxi-geodata
description: 广西静态地理信息服务技能，提供地名坐标解析、水文站/医院/避难所查询等本地数据能力。用于需要 geometry、地理底座、静态警戒水位或空间分析输入，但不需要联网抓取实时天气和网页水情时。
---

# Guangxi Geodata

## Overview

这个 Skill 只负责广西本地静态地理数据，不负责联网实时采集。

适用场景：
- 需要将地名解析成坐标和 WKT。
- 需要查询静态水文站、医院、避难所。
- 需要给 `gis-bindmap`、`create_risk_map` 或 `assess_flood_risk` 提供基础地理字段。

如果要获取实时降雨量或网页水情，改用 `guangxi-flood-data`。

## geocode.py

功能：
- 将广西地名解析为 WGS84 坐标。
- 输出 `wkt`，可直接用于地图工具。

参数：
- `--location`: 单地名
- `--batch`: 多地名，逗号分隔

示例：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-geodata",
    "script_name": "geocode.py",
    "arguments": ["--location", "桂林市"]
  }
}
```

## query_features.py

功能：
- 查询广西水文站、医院、应急避难所等静态要素。
- 水文站输出中包含 `warning_level`，适合补齐警戒水位。

参数：
- `--type`: `hydrological_station` / `hospital` / `shelter`
- `--city`: 按城市过滤
- `--lat` + `--lng` + `--radius`: 按坐标和半径过滤

按城市查询水文站：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-geodata",
    "script_name": "query_features.py",
    "arguments": ["--type", "hydrological_station", "--city", "桂林市"]
  }
}
```

按坐标查询医院：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-geodata",
    "script_name": "query_features.py",
    "arguments": ["--type", "hospital", "--lat", "25.27", "--lng", "110.29", "--radius", "80"]
  }
}
```

## Data

内置静态数据：
- `data/hydrological_stations.json`
- `data/hospitals.json`
- `data/shelters.json`

这些数据也会被 `gis-bindmap` 和 `guangxi-flood-data` 复用。
