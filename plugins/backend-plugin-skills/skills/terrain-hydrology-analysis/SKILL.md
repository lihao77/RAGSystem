---
name: terrain-hydrology-analysis
description: DEM 地形和基础水文分析。计算坡度、坡向、阴影、等高线、洼地填平、D8 流向、汇流累积和给定出水点的分水岭。用户提供 DEM/GeoTIFF 并要求地形或水文派生栅格时使用。
---

# 地形与水文分析

每个入口脚本执行一个操作，输入为带 CRS 的单波段或多波段 DEM，输出为 Artifact V2。地形栅格使用输入 CRS 和像元尺寸；等高线输出 GeoJSON。水文算法采用透明的 NumPy D8 实现，适用于常规分析，不宣称商业 GIS 扩展的全部兼容性。

```json
{"skill_name":"terrain-hydrology-analysis","script_name":"slope.py","arguments":["--input","dem.tif","--output-name","dem-slope"]}
```

入口：

- `slope.py --input PATH [--band N]`
- `aspect.py --input PATH [--band N]`
- `hillshade.py --input PATH [--azimuth DEG] [--altitude DEG]`
- `contour.py --input PATH --interval N [--base N]`
- `fill_sinks.py --input PATH`
- `flow_direction.py --input PATH`
- `flow_accumulation.py --input PATH`
- `watershed.py --input PATH --pour-row ROW --pour-col COL`

所有产物写入 `RAGSYSTEM_ARTIFACT_OUTPUT_DIR`，脚本只输出一份 JSON，不生成地图配置。需要地图时，将返回的真实 `artifact_id` 交给 `map_add_artifact_layer`；栅格可先通过 `geospatial-visualization/prepare_raster_layer.py` 准备为 PNG 图层。
