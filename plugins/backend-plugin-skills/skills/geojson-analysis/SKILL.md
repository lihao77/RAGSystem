---
name: geojson-analysis
description: 对 GeoJSON 数据进行属性过滤、几何类型过滤、范围查询、缓冲查询和统计分析。用户提供 GeoJSON 文件或数据并要求筛选、空间查询或统计时使用。
---

# GeoJSON 空间分析

激活 `geojson-analysis` 后，只通过 `execute_skill_script` 调用下列脚本。`arguments` 是 argv token 数组；输入路径使用附件或工具返回的真实路径，不拼接命令字符串。脚本零第三方依赖。

## 脚本

### `geojson_filter.py`

按属性条件和/或几何类型筛选 FeatureCollection。

- 必填：`--data PATH_OR_JSON`
- 可选：`--where "field op value"`，可重复；操作符为 `eq`、`ne`、`gt`、`gte`、`lt`、`lte`、`in`、`contains`、`not_null`
- 可选：`--geometry-types Point,MultiPoint`

```json
{"skill_name":"geojson-analysis","script_name":"geojson_filter.py","arguments":["--data","data.geojson","--where","population gt 1000000","--geometry-types","Polygon"]}
```

### `geojson_spatial.py`

按中心点缓冲范围或矩形范围筛选要素。

- 缓冲：`--data PATH --query-type buffer --center-lat LAT --center-lng LNG --radius-km KM`
- 矩形：`--data PATH --query-type bbox --bbox west,south,east,north`

```json
{"skill_name":"geojson-analysis","script_name":"geojson_spatial.py","arguments":["--data","data.geojson","--query-type","bbox","--bbox","107.0,22.0,109.0,24.0"]}
```

### `geojson_stats.py`

统计数值字段、分组结果、近似面积或线长。

- `--data PATH`
- `--stats-fields field1,field2 [--group-by FIELD]`
- `--compute-area` 或 `--compute-length`

## 输出

- 过滤和空间查询把 GeoJSON 写入 Agent 选择的 cwd，并返回直接的 `file` 对象：`path`、`media_type`、`size`、`metadata`。
- 统计脚本只返回结构化 JSON，不生成文件。
- 用户要求交互地图且当前工具 schema 明确提供 `map_add_file_layer` 时，可以传入真实 `file.path`；不要假设该工具存在。
- 需要在最终回答中交付文件时，选择 workspace cwd 或先复制到 workspace，再使用规范的 `<file_ref path="workspace-relative-path" presentation="inline|attachment|preview" caption="optional"/>`。
