---
name: raster-spatial-analysis
description: 对 GeoTIFF、Cloud Optimized GeoTIFF 及其他 Rasterio 可读栅格执行检查、投影、掩膜提取、重采样、像元计算、重分类、邻域统计、分区统计、NoData 处理、聚合、镶嵌和逐像元多栅格统计。用户需要栅格数据管理、栅格分析或栅格与矢量掩膜叠加时使用。
---

# 栅格空间分析

使用 Rasterio、NumPy、GeoPandas 和 PyProj 处理栅格。每个工具由一个同名脚本提供固定入口，Agent 不需要传递操作选择参数。输入路径只使用当前请求授权的附件或工作区路径。

## 调用流程

1. 激活 `raster-spatial-analysis`。
2. 先用 `describe_raster.py` 检查 CRS、范围、尺寸、波段和 NoData。
3. 调用对应的独立脚本。`execute_skill_script` 的 `arguments` 必须是 argv token 数组，每个参数和值分别占一个元素。
4. 数据脚本把结果写入 Agent 选择的 cwd，stdout 只输出一份 JSON。脚本返回的 `file` 包含真实相对路径、媒体类型和大小。
5. 需要地图时，先将 GeoTIFF 交给 `geospatial-visualization/prepare_raster_layer.py` 生成 WGS84 PNG，再用真实文件路径调用 `map_add_file_layer`。分析脚本不生成地图配置。

调用示例：

```json
{
  "skill_name": "raster-spatial-analysis",
  "script_name": "aggregate_raster.py",
  "arguments": ["--input", "D:\\data\\elevation.tif", "--factor", "4", "--statistic", "mean", "--output-name", "elevation-aggregate"]
}
```

## 工具路由

| 类别 | 独立入口 |
| --- | --- |
| 检查 | `describe_raster.py` |
| 投影与网格 | `project_raster.py`、`resample_raster.py`、`aggregate_raster.py` |
| 掩膜与范围 | `clip_raster.py`、`extract_by_mask.py` |
| 像元运算 | `raster_calculator.py`、`reclassify.py`、`set_nodata.py`、`fill_nodata.py` |
| 邻域与分区 | `focal_statistics.py`、`zonal_statistics.py` |
| 多栅格运算 | `cell_statistics.py`、`mosaic.py` |
| 统计摘要 | `raster_statistics.py` |

每个脚本的精确参数、输入约束和输出字段见 [raster-tools.md](references/raster-tools.md)。

## 输出约定

- 栅格结果返回 `file.path`，媒体类型为 `image/tiff`，并提供 `metadata.spatial.crs` 与 `metadata.spatial.bounds`。
- `raster_statistics.py` 和 `zonal_statistics.py` 返回 JSON 文件；统计记录同时放在返回 JSON 的 `result` 中。
- 不在脚本中生成文件 ID，不把文件转成 Base64，不直接调用地图工具。

## 约束

- 栅格与掩膜图层必须声明 CRS；掩膜会自动转换到栅格 CRS。
- 逐像元运算要求输入栅格具有相同的尺寸、CRS 和仿射变换。
- 距离和面积不在本 Skill 中解释；栅格单位由输入 CRS 和像元分辨率决定。
- 大栅格应先裁剪、重采样或分区处理，避免超过运行时和内存限制。

