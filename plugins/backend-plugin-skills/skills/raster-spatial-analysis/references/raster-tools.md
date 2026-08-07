# 栅格工具参数

所有参数均写入 `execute_skill_script.arguments` 数组；路径和值不能合并成一个字符串。输出工具支持 `--output-name` 和 `--title`，不传时使用工具名。

## 检查

`describe_raster.py`

- 必选：`--input RASTER`
- 仅返回元数据，不生成 File。

## 投影、裁剪和网格

`project_raster.py`

- 必选：`--input RASTER --target-crs CRS`
- 输出所有波段的 GeoTIFF，使用最近邻重采样并保留 NoData。

`clip_raster.py`、`extract_by_mask.py`

- 必选：`--input RASTER --mask VECTOR`
- 可选：`--all-touched`
- `--overlay` 是 `--mask` 的兼容别名；输出为裁剪后的所有波段。

`resample_raster.py`

- 必选：`--input RASTER --scale FACTOR`
- 可选：`--resampling nearest|bilinear|cubic|average`
- `scale` 必须大于 0；小于 1 表示降采样。

`aggregate_raster.py`

- 必选：`--input RASTER --factor INTEGER`
- 可选：`--statistic mean|sum|min|max|median`
- 按完整像元块聚合，边缘不足一个块的像元被丢弃，输出分辨率放大同一因子。

## 像元计算和 NoData

`raster_calculator.py`

- 必选：`--input RASTER --expression EXPR`
- 可选：`--overlay RASTER --band N --overlay-band N`
- 表达式仅允许数组 `A`、`B`、数值常量、算术/比较/布尔运算和 `sqrt`、`log`、`abs`、`where`、`minimum`、`maximum`、`clip`。脚本使用 AST 白名单，不执行任意 Python 代码。

`reclassify.py`

- 必选：`--input RASTER --breaks N1,N2,...`
- 可选：`--band N`
- 断点必须严格递增，输出类别从 1 开始，输入 NoData 输出为 0。

`set_nodata.py`

- 必选：`--input RASTER --nodata VALUE`
- 将有效数据之外的掩膜像元写成新 NoData，并更新 GeoTIFF 元数据。

`fill_nodata.py`

- 必选：`--input RASTER`
- 可选：`--max-distance PIXELS`（默认 100）
- 对每个波段使用邻近有效像元插值填充 NoData，输出 float32 栅格。

## 统计和多栅格

`focal_statistics.py`

- 必选：`--input RASTER`
- 可选：`--window ODD`、`--statistic mean|sum|min|max`、`--band N`
- `window` 必须为正奇数；边缘使用边界像元延拓。

`raster_statistics.py`

- 必选：`--input RASTER`
- 可选：`--band N`
- 不传 `--band` 时统计全部波段，输出 count、min、max、mean、sum、std 的 JSON File。

`zonal_statistics.py`

- 必选：`--input RASTER --overlay ZONES`
- 可选：`--zone-field FIELD`、`--band N`、`--all-touched`
- 每个分区输出 count、min、max、mean、sum；`zone-field` 的值写入 `zone_value`。

`cell_statistics.py`

- 必选：`--input RASTER1 RASTER2 ...`（至少两个）
- 可选：`--statistic mean|sum|min|max|median`、`--band N`
- 所有输入必须具有相同尺寸、CRS 和仿射变换；NoData 像元不参与统计。

`mosaic.py`

- 必选：`--input RASTER1 RASTER2 ...`
- 使用 Rasterio merge 生成多波段镶嵌 GeoTIFF。

