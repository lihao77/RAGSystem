---
name: GeoJSON Analysis
description: 对 GeoJSON 数据进行过滤、空间查询和统计分析。所有脚本接受文件路径输入，输出 JSON 结果。分析结果可直接对接 create_map / create_bindmap 系统工具生成地图。
---

# GeoJSON 空间分析 Skill（geojson-analysis）

对 GeoJSON 数据进行过滤、空间查询和统计分析。所有脚本接受文件路径输入，输出 JSON 结果。
分析结果可直接对接 create_map / create_bindmap 系统工具生成地图。

## 依赖
- 零第三方依赖，纯 Python 标准库

## 脚本列表

### 1. geojson_filter.py — 按属性/几何类型过滤

从 GeoJSON FeatureCollection 中按属性条件和/或几何类型筛选 Feature。

```bash
# 按属性过滤：人口大于 100 万
python scripts/geojson_filter.py --data path/to/data.geojson --where "population gt 1000000"

# 多条件（AND）
python scripts/geojson_filter.py --data path/to/data.geojson --where "level eq 红色" "rainfall_24h gte 200"

# 按几何类型过滤
python scripts/geojson_filter.py --data path/to/data.geojson --geometry-types Point,MultiPoint

# 组合
python scripts/geojson_filter.py --data path/to/data.geojson --where "risk_level eq 高" --geometry-types Polygon
```

**--where 语法**: `"字段名 操作符 值"`
- 操作符: eq, ne, gt, gte, lt, lte, in, contains, not_null
- in 操作符值用逗号分隔: `"city in 南宁市,桂林市,柳州市"`

### 2. geojson_spatial.py — 空间查询

对 GeoJSON 数据进行空间范围筛选。

```bash
# 缓冲区查询：中心点 50km 范围内的 Feature
python scripts/geojson_spatial.py --data path/to/data.geojson --query-type buffer --center-lat 22.82 --center-lng 108.37 --radius-km 50

# BBox 查询：矩形范围内的 Feature
python scripts/geojson_spatial.py --data path/to/data.geojson --query-type bbox --bbox "107.0,22.0,109.0,24.0"
```

### 3. geojson_stats.py — 统计分析

对 GeoJSON Feature 的属性进行统计。

```bash
# 数值字段统计（min/max/mean/sum/count）
python scripts/geojson_stats.py --data path/to/data.geojson --stats-fields rainfall_24h,population

# 分组统计
python scripts/geojson_stats.py --data path/to/data.geojson --stats-fields rainfall_24h --group-by city

# 计算面积（Polygon/MultiPolygon，近似平方公里）
python scripts/geojson_stats.py --data path/to/data.geojson --compute-area

# 计算线长（LineString/MultiLineString，近似公里）
python scripts/geojson_stats.py --data path/to/data.geojson --compute-length
```
