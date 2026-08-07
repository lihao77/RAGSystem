---
name: spatial-conversion
description: 矢量与栅格之间以及常用空间文件格式之间的转换。执行栅格化、栅格矢量化、矢量转 GeoJSON 和 Cloud Optimized GeoTIFF 输出。用户要求格式转换或建立矢量栅格桥接时使用。
---

# 空间格式转换

每个入口脚本只负责一个转换，输出写入 Agent 选择的 cwd 并返回通用 `file.path`。参数使用独立 argv token，不传统一操作开关。转换结果不生成地图配置；需要展示时把真实文件路径交给 `map_add_file_layer`。

入口：

- `rasterize.py --input VECTOR --resolution N [--attribute FIELD] [--value N] [--all-touched]`
- `polygonize.py --input RASTER [--band N] [--mask]`
- `vector_to_geojson.py --input VECTOR [--layer LAYER]`
- `raster_to_cog.py --input RASTER [--overview-levels 2,4,8,16]`

栅格化需要输入矢量 CRS，`--resolution` 使用该 CRS 的单位；未提供字段时所有要素使用 `--value`。栅格矢量化保留像元值为 `value` 字段。COG 输出使用 tiled、压缩和 overviews，并在 Asset 中声明合法 GeoTIFF MIME 类型。

