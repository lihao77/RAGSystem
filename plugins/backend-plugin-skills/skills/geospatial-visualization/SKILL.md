---
name: geospatial-visualization
description: 为 MapLibre 地图准备 GeoJSON 矢量图层和带地理范围的 PNG 栅格图层，并可生成 ECharts 图表。用户要求地图展示、专题制图、栅格预览或空间数据图表时使用。
---

# 地理空间可视化

本 Skill 只准备可视化数据，不替代空间分析。先使用 `vector-spatial-analysis` 或 `raster-spatial-analysis` 完成清洗、投影和计算，再调用这里的图层准备脚本。

## 脚本

### `prepare_vector_layer.py`

把 GeoJSON、GeoPackage 或 Shapefile 转成 EPSG:4326 GeoJSON 文件。使用 `--value-field FIELD` 校验专题字段并记录数值范围；不生成地图配置或样式。

### `prepare_raster_layer.py`

把 Rasterio 可读栅格的指定波段重投影到 EPSG:4326 并生成有界 PNG 图层。支持 `viridis`、`terrain`、`gray`、`bluered` 色带，自动忽略 nodata，并在 `metadata.spatial` 中保留 `crs`、`bounds`，另保留源 CRS 和数值范围。

### `render_chart.py`

从 JSON/CSV 记录生成 ECharts `line`、`bar`、`pie` 或 `scatter` 配置。图表配置是结构化 JSON，不把原始数据文件塞进消息上下文。

所有脚本成功时都返回 `file.path`、媒体类型、大小和空间元数据。

地图工作流：

1. 执行图层准备脚本并读取工具真实返回的 `file.path`。
2. 立即调用 `map_add_file_layer`，传入该路径；专题图样式、字段、颜色和透明度作为地图工具参数传递。
3. 多个文件逐个调用 `map_add_file_layer`，不要构造组合地图配置。
4. 不使用 `[file:...]` 触发地图渲染，不创建任何地图 presentation 或 renderer 配置。

分类专题图在 `map_add_file_layer.style.thematic` 中传 `field`、`method: categorical` 和 `stops`；数值分级或连续色带使用 `method: step` 或 `interpolate`。每个 stop 传 `value`、`color`，需要图例文字时传 `label`。添加后改变样式时调用 `map_set_layer_style`。

ECharts 图表通过 `render_chart.py` 写入 cwd 下的配置文件，并在最终回答中保留工具返回的文件路径。

## 约束

- 地图图层坐标必须是 WGS84 经度/纬度；脚本会转换可识别 CRS，缺少 CRS 时拒绝处理。
- 栅格 PNG 是预览图，不能替代 GeoTIFF 数据文件；需要下载或继续分析时保留原始栅格。
- 完整矢量数据通过文件路径传递，不内联到地图配置或模型上下文。

