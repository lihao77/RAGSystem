---
name: gis-bindmap
description: GIS 空间分析能力，支持缓冲区、最近邻、应急资源、距离矩阵和流域上下游关联。用户查询广西水文站、医院、避难所的邻近关系或流域关联，并需要结构化结果或地图图层时使用。
---

# GIS 空间分析

空间脚本返回分析摘要和 Artifact V2 GeoJSON Asset，空间范围位于 `metadata.spatial`。Artifact 不包含 presentation 或地图配置。

## 依赖

- 零第三方依赖，纯 Python 标准库
- 引用 `guangxi-geodata` Skill 的数据文件（水文站/医院/避难所）

## 脚本列表

### 1. `proximity_analysis.py` — 邻近分析

通过 `--operation` 子命令分发：

**buffer — 缓冲区分析**
给定中心点+半径，查找区域内所有指定类型要素。

```bash
python scripts/proximity_analysis.py --operation buffer --location "南宁市" --radius 50 --types hospital,shelter
python scripts/proximity_analysis.py --operation buffer --lat 22.82 --lng 108.37 --radius 50 --types hydrological_station,hospital,shelter
```

**nearest — 最近邻查询**
给定位置，查找 N 个最近的指定类型要素。

```bash
python scripts/proximity_analysis.py --operation nearest --location "桂林市" --type hospital --top-k 5
python scripts/proximity_analysis.py --operation nearest --lat 25.27 --lng 110.29 --type hospital --top-k 3
```

**resources — 多类型应急资源查询**
一次查出多种要素，并在 GeoJSON 属性中写入 `layer` 和 `category` 供前端分层或分类着色。

```bash
python scripts/proximity_analysis.py --operation resources --location "南宁市" --radius 80 --types hydrological_station,hospital,shelter
```

### 2. `distance_matrix.py` — 距离矩阵

计算源点到目标点的距离矩阵。

```bash
# 手动指定源点，按类型查目标
python scripts/distance_matrix.py --sources '[{"name":"南宁市","lat":22.82,"lng":108.37}]' --targets-type shelter

# 从数据文件加载源点
python scripts/distance_matrix.py --sources-type hydrological_station --sources-city "桂林市" --targets-type hospital
```

### 3. `basin_analysis.py` — 流域关联分析

**downstream — 下游影响分析**
```bash
python scripts/basin_analysis.py --operation downstream --station "柳州水文站"
```

**upstream — 上游溯源**
```bash
python scripts/basin_analysis.py --operation upstream --station "梧州水文站"
```

**river — 整条河流水文站数据**
```bash
python scripts/basin_analysis.py --operation river --river "柳江"
```

## 地图展示

脚本成功后读取工具真实返回的 `artifact_id`，调用 `map_add_artifact_layer`。多个分析结果逐个添加，不组装中间地图配置，也不使用 `[artifact:...]` 触发地图渲染。
