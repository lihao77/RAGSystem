---
name: guangxi-hydrology-web
description: 调用广西水利厅实时 API 获取雨情和水情数据（JSON 接口），返回结构化降雨量、水位、流量等字段，可直接用于风险评估和地图可视化。
---

# Guangxi Hydrology Web

## Overview

通过广西水利厅公开 API 获取实时雨情和水情数据，返回结构化 JSON。

适用场景：
- 需要实时雨量站降雨数据（按时段、按区域）。
- 需要实时江河水位、流量、超警信息。
- 需要单站水位过程线（历史趋势）。
- 为 `assess_flood_risk` 或 `create_risk_map` 提供实时水文数据。

与 `guangxi-flood-data` 的区别：本 Skill 直接调用水利厅 JSON API，数据更精确、字段更丰富；`guangxi-flood-data` 通过 HTML 解析获取水情。

## fetch_rain.py

功能：
- 查询广西实时雨情（指定时段内各站累计降雨量）。
- 支持按站名、行政区划代码过滤。
- 支持自定义降雨量分级阈值。

参数：
- `--hours`: 查询最近 N 小时的降雨，默认 24
- `--start-time`: 自定义起始时间 (YYYY-MM-DD HH:MM:SS)
- `--end-time`: 自定义结束时间，默认当前时间
- `--stnm`: 按站名过滤（模糊匹配）
- `--adcd`: 按行政区划代码过滤
- `--min-rain`: 最小降雨量过滤（mm），默认 0
- `--limit`: 最多返回记录数，默认 100
- `--sort`: 排序方式 desc(降序)/asc(升序)，默认 desc

示例 - 查最近24小时降雨超50mm的站点：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-hydrology-web",
    "script_name": "fetch_rain.py",
    "arguments": ["--hours", "24", "--min-rain", "50"]
  }
}
```

示例 - 按站名查询：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-hydrology-web",
    "script_name": "fetch_rain.py",
    "arguments": ["--stnm", "水榕树"]
  }
}
```

关键输出字段：
- `station_name`: 站名
- `station_code`: 站码 (STCD)
- `accumulated_rain_mm`: 累计降雨量 (mm)
- `longitude` / `latitude`: 站点坐标
- `location`: 站点位置描述

## fetch_river.py

功能：
- 查询广西江河实时水情（水位、流量、超警信息）。
- 支持按站名、河流名、流域名过滤。
- 支持查询单站水位过程线（历史趋势）。

参数：
- `--keyword`: 按站名/河流名/流域名过滤（模糊匹配）
- `--warn-only`: 只返回超警站点
- `--limit`: 最多返回记录数，默认 100
- `--history`: 查询指定站码(STCD)的水位过程线
- `--sort`: 排序方式 warn_delta(超警排序)/name(站名)，默认 warn_delta

示例 - 查所有超警站点：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-hydrology-web",
    "script_name": "fetch_river.py",
    "arguments": ["--warn-only"]
  }
}
```

示例 - 按河流名查询：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-hydrology-web",
    "script_name": "fetch_river.py",
    "arguments": ["--keyword", "郁江"]
  }
}
```

示例 - 查单站水位过程线：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-hydrology-web",
    "script_name": "fetch_river.py",
    "arguments": ["--history", "80700300"]
  }
}
```

关键输出字段：
- `station_name`: 站名
- `station_code`: 站码 (STCD)
- `river_name`: 河流名
- `basin_name`: 流域名
- `water_level`: 当前水位 (m)
- `warning_level`: 警戒水位 (m)
- `exceed_warning`: 超警值 (m)，负值表示未超警
- `flow_rate`: 流量 (m³/s)
- `longitude` / `latitude`: 站点坐标
- `is_warning`: 是否超警 (boolean)
- `timestamp`: 数据时间

过程线输出字段：
- `water_level`: 水位 (m)
- `flow_rate`: 流量 (m³/s)
- `timestamp`: 时间点
