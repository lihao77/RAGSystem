---
name: guangxi-flood-data
description: 获取广西洪涝相关实时联网数据，包含城市降雨天气请求、江河/水库/入口页水情网页抓取与 HTML 表格解析，返回结构化 JSON。用于需要自动补齐 rainfall、water_level、warning_level、timestamp 等实时字段，或为洪涝风险评估和态势研判提供外部数据时。
---

# Guangxi Flood Data

## Overview

使用这个 Skill 统一获取广西洪涝场景下的实时联网数据。

这个 Skill 负责两类能力：
- 天气与降雨请求：按城市获取 24 小时降雨量和预报降雨量。
- 水情网页抓取：解析广西江河、水库、入口页的 HTML 表格与链接。

优先在这些场景使用：
- 需要自动获取某市实时降雨量。
- 需要从广西水情网页提取水位、警戒水位、时间。
- 需要把外部实时数据继续传给 `assess_flood_risk` 或 `create_risk_map`。

## Quick Start

先激活 Skill，再按任务选择脚本。

获取城市降雨量：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-flood-data",
    "script_name": "fetch_weather.py",
    "arguments": ["--batch", "南宁市,桂林市,柳州市"]
  }
}
```

抓江河实时水情：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-flood-data",
    "script_name": "fetch_hydrology.py",
    "arguments": ["--source", "river"]
  }
}
```

同时抓入口页、江河页、水库页：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "guangxi-flood-data",
    "script_name": "fetch_hydrology.py",
    "arguments": ["--source", "all"]
  }
}
```

## Capabilities

### 1. fetch_weather.py

功能：
- 通过 `wttr.in` 请求广西城市实时天气。
- 重点提取 `rainfall_24h_mm` 与可选的 `forecast_rainfall_mm`。
- 网络失败时返回降级提示，而不是直接报错中断。

参数：
- `--location`: 单城市查询
- `--batch`: 多城市批量查询，逗号分隔
- `--include-forecast`: 同时返回次日预报降雨量

关键输出：
- `rainfall_24h_mm`
- `forecast_rainfall_mm`
- `temp_c`
- `humidity_pct`

这些字段可直接继续传入风险评估：
- `rainfall_24h_mm` -> `assess_flood_risk.rainfall_24h`
- `forecast_rainfall_mm` -> `assess_flood_risk.forecast_rainfall`

### 2. fetch_hydrology.py

功能：
- 请求网页或读取本地 HTML 文件。
- 解析 HTML 表格、链接和 iframe。
- 统一输出 `water_level`、`warning_level`、`timestamp` 等字段。
- 对缺失的警戒水位尝试使用 `guangxi-geodata` 中的静态水文站数据回填。

参数：
- `--source`: `portal` / `river` / `reservoir` / `all`
- `--url`: 覆盖内置 URL
- `--html-file`: 本地 HTML 文件路径，用于离线调试
- `--keyword`: 按站名、河流名、水库名过滤
- `--limit`: 限制返回记录数
- `--timeout`: 请求超时秒数
- `--list-sources`: 输出内置来源配置

关键输出：
- `site_name`
- `station_name`
- `river_name`
- `reservoir_name`
- `water_level`
- `warning_level`
- `exceed_warning_level`
- `timestamp`
- `links`
- `iframe_links`

### 3. fetch_warning.py

功能：
- 从中央气象台公开接口获取实时气象预警信息。
- 从预警标题中正则解析城市、预警类型（暴雨/大风/雷电/冰雹等）、预警级别（红/橙/黄/蓝）。
- 支持按省份、城市、预警类型、预警级别过滤。
- 网络失败时返回 `degraded: true`，不中断流程。
- 输出的 warnings 数组可直接传入 `situation_assess.py --warnings` 参数。

参数：
- `--province`: 省份名称，默认广西
- `--city`: 城市过滤，如 南宁市
- `--type`: 预警类型过滤，如 暴雨、大风、雷电
- `--level`: 预警级别过滤：红色/橙色/黄色/蓝色
- `--page-size`: 每页条数，默认50

关键输出：
- `warnings[]`: 预警列表
  - `warning_type`: 预警类型（暴雨/大风/雷电等）
  - `warning_level`: 预警级别（红色/橙色/黄色/蓝色）
  - `warning_color`: 颜色编码（red/orange/yellow/blue）
  - `city`: 发布城市
  - `issued_at`: 发布时间
  - `title`: 原始标题
  - `url`: 详情链接
- `stat`: 各级预警数量统计（r/b/y/o 对应红/蓝/黄/橙）
- `total`: 匹配预警总数

## Workflow

1. 缺降雨量时，先用 `fetch_weather.py`。
2. 缺水位或警戒水位时，再用 `fetch_hydrology.py`。
3. 需要气象预警信息时，用 `fetch_warning.py`。
4. 需要空间字段时，继续调用 `guangxi-geodata/geocode.py`。
5. 数据齐备后，再调用 `assess_flood_risk` 或 `create_risk_map`。

## References

按需加载这些文件：
- `references/source-pages.md`: 来源页说明与调试建议
- `references/weather-source.md`: 天气数据源与字段说明
- `references/fixtures/river_sample.html`: 江河页离线样例
- `references/fixtures/reservoir_sample.html`: 水库页离线样例
- `references/fixtures/portal_sample.html`: 入口页离线样例
