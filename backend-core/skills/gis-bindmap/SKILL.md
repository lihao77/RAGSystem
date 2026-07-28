---
name: GIS BindMap
description: GIS 空间分析能力，支持缓冲区分析、最近邻查询、多要素叠加、距离矩阵和流域上下游关联。所有分析结果可直接对接 create_bindmap 系统工具生成地图。
---

# GIS 空间分析 Skill（gis-bindmap）

GIS 空间分析能力，支持缓冲区分析、最近邻查询、多要素叠加、距离矩阵和流域上下游关联。所有分析结果可直接对接 `create_bindmap` 系统工具生成地图。

## 依赖

- 零第三方依赖，纯 Python 标准库
- 引用 `guangxi-geodata` Skill 的数据文件（水文站/医院/避难所）

## 脚本列表

### 1. `spatial_bindmap.py` — 空间分析

通过 `--operation` 子命令分发：

**buffer — 缓冲区分析**
给定中心点+半径，查找区域内所有指定类型要素。

```bash
python scripts/spatial_bindmap.py --operation buffer --location "南宁市" --radius 50 --types hospital,shelter
python scripts/spatial_bindmap.py --operation buffer --lat 22.82 --lng 108.37 --radius 50 --types hydrological_station,hospital,shelter
```

**nearest — 最近邻查询**
给定位置，查找 N 个最近的指定类型要素。

```bash
python scripts/spatial_bindmap.py --operation nearest --location "桂林市" --type hospital --top-k 5
python scripts/spatial_bindmap.py --operation nearest --lat 25.27 --lng 110.29 --type hospital --top-k 3
```

**bindmap — 多要素叠加查询**
一次查出所有类型要素，输出 `bindmap_ready` 字段可直接传 `create_bindmap` 工具。

```bash
python scripts/spatial_bindmap.py --operation bindmap --location "南宁市" --radius 80 --types hydrological_station,hospital,shelter
```

### 2. `distance_matrix.py` — 距离矩阵

计算源点到目标点的距离矩阵。

```bash
# 手动指定源点，按类型查目标
python scripts/distance_matrix.py --sources '[{"name":"南宁市","lat":22.82,"lng":108.37}]' --targets-type shelter

# 从数据文件加载源点
python scripts/distance_matrix.py --sources-type hydrological_station --sources-city "桂林市" --targets-type hospital
```

### 3. `basin_bindmap.py` — 流域关联分析

**downstream — 下游影响分析**
```bash
python scripts/basin_bindmap.py --operation downstream --station "柳州水文站"
```

**upstream — 上游溯源**
```bash
python scripts/basin_bindmap.py --operation upstream --station "梧州水文站"
```

**river-bindmap — 整条河流可视化**
```bash
python scripts/basin_bindmap.py --operation river-bindmap --river "柳江"
```

## 输出格式

所有 bindmap 操作输出包含 `bindmap_ready` 字段：
```json
{
  "bindmap_ready": {
    "layers": [...],
    "title": "..."
  }
}
```
`layers` 数组可直接作为 `create_bindmap` 工具的 `layers` 参数使用。
