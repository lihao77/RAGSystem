---
name: vector-spatial-analysis
description: 矢量空间分析与地理处理。处理 GeoJSON、GeoPackage、Shapefile 等数据的投影、缓冲、叠加、融合、连接、选择、几何修复、字段计算和统计。用户要求矢量空间运算或生成矢量 Artifact 时使用。
---

# 矢量空间分析

使用 `scripts/` 中的同名入口执行一个明确的矢量操作。先检查输入 CRS；距离、面积和长度计算必须使用投影坐标系。脚本不会修改输入文件，结果通过 `RAGSYSTEM_ARTIFACT_OUTPUT_DIR` staging 生成 Artifact V2。

调用方式：

```json
{"skill_name":"vector-spatial-analysis","script_name":"buffer.py","arguments":["--input","roads.gpkg","--distance","500","--output-name","roads-buffer"]}
```

每个参数都是 `arguments` 数组中的独立 argv token。直接选择对应的同名脚本，不要把多个工具合并到一个脚本调用。成功后使用返回的真实 `artifact_id` 调用 `map_add_artifact_layer` 展示 GeoJSON；脚本不生成地图配置。

## 入口

| 脚本 | 参数 |
| --- | --- |
| `inspect_vector.py` | `--file PATH [--layer LAYER]` |
| `project.py`, `reproject.py`, `define_projection.py` | `--input PATH --target-crs CRS` |
| `buffer.py` | `--input PATH --distance N [--distance-unit meter\|kilometer]` |
| `clip.py`, `intersect.py`, `union.py`, `erase.py`, `identity.py` | `--input PATH --overlay PATH`（可重复 `--overlay`） |
| `dissolve.py` | `--input PATH [--by FIELD1,FIELD2]` |
| `merge.py`, `append.py` | 重复 `--input PATH` |
| `spatial_join.py`, `select_by_location.py` | `--input PATH --overlay PATH [--predicate PREDICATE]` |
| `select.py` | `--input PATH --where EXPR` |
| `near.py` | `--input PATH --overlay PATH` |
| `repair_geometry.py`, `multipart_to_singlepart.py`, `export.py` | `--input PATH` |
| `calculate_field.py` | `--input PATH --field FIELD --expression EXPR` |
| `summary_statistics.py` | `--input PATH --stats field:stat[,field:stat] [--by FIELD1,FIELD2]` |

矢量输出使用 `kind: geospatial.vector`、GeoJSON staging Asset、`metadata.spatial.crs/bounds` 和空 `presentations`。空结果仍生成合法空 GeoJSON。参数或数据错误时输出结构化错误并返回非零状态。
