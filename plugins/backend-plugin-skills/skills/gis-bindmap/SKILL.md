---
name: gis-bindmap
description: GIS 空间分析能力，支持缓冲区、最近邻、应急资源、距离矩阵和流域上下游关联。用户查询广西水文站、医院、避难所的邻近关系或流域关联，并需要结构化结果或地图图层时使用。
---

# GIS 空间分析

激活 `gis-bindmap` 后，只通过 `execute_skill_script` 调用脚本。每个参数和值都是 `arguments` 中独立的 argv token。脚本使用 Python 标准库和 `guangxi-geodata` Skill 数据，把 GeoJSON 写入 Agent 选择的 cwd，并返回直接的 `file` 对象。

## 脚本

### `proximity_analysis.py`

- 缓冲：`--operation buffer`，位置使用 `--location NAME` 或 `--lat LAT --lng LNG`，并传 `--radius KM --types TYPE1,TYPE2`
- 最近邻：`--operation nearest`，位置参数同上，并传 `--type TYPE --top-k N`
- 多类资源：`--operation resources`，位置参数同上，并传 `--radius KM --types TYPE1,TYPE2`

```json
{"skill_name":"gis-bindmap","script_name":"proximity_analysis.py","arguments":["--operation","buffer","--location","南宁市","--radius","50","--types","hospital,shelter"]}
```

### `distance_matrix.py`

- 手动源点：`--sources JSON --targets-type TYPE`
- 数据源点：`--sources-type TYPE --sources-city CITY --targets-type TYPE`

### `basin_analysis.py`

- 下游：`--operation downstream --station STATION`
- 上游：`--operation upstream --station STATION`
- 河流：`--operation river --river RIVER`

## 输出

- 使用工具返回的真实 `file.path`；空间范围位于 `file.metadata.spatial`，不要编造路径或地图配置。
- 用户要求交互地图且当前工具 schema 明确提供 `map_add_file_layer` 时，可以逐个传入结果路径；不要假设该工具存在。
- 需要最终交付时，选择 workspace cwd 或先复制到 workspace，再使用规范的 `<file_ref path="workspace-relative-path" presentation="inline|attachment|preview" caption="optional"/>`。
