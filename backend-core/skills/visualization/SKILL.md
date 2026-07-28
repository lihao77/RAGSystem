---
name: visualization
description: 数据可视化技能，支持 ECharts 图表和 Leaflet 地图的创建、修改和多图层叠加。
---

## 可视化工具

本 Skill 提供完整的数据可视化能力，所有脚本输出 artifact 协议格式，系统自动完成持久化。
在 `<final_answer>` 中使用 `[viz:artifact_id]` 展示可视化结果。

## 可用脚本

### create_chart.py - ECharts 图表生成
**功能**：从数据生成 ECharts 图表配置，自动持久化为 artifact。

**参数**：
- `--data`（必填）：数据源，JSON 字符串或文件路径（.json/.csv）
- `--chart-type`（可选）：图表类型 line/bar/pie/scatter，默认 bar
- `--x-field`（必填）：X 轴字段名
- `--y-field`（必填）：Y 轴字段名
- `--series-field`（可选）：系列分组字段，用于多系列图表
- `--title`（可选）：图表标题

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "visualization",
    "script_name": "create_chart.py",
    "arguments": ["--data", "[{\"年份\":2020,\"人口\":100},{\"年份\":2021,\"人口\":120}]", "--chart-type", "line", "--x-field", "年份", "--y-field", "人口", "--title", "人口趋势"]
  }
}
```

---

### create_map.py - Leaflet 地图生成
**功能**：从含地理坐标的数据生成地图，自动持久化为 artifact。

**参数**：
- `--data`（必填）：数据源，JSON 字符串或文件路径
- `--map-type`（可选）：heatmap/marker/circle/choropleth/geojson，默认 heatmap
- `--value-field`（必填）：数值字段名
- `--name-field`（可选）：名称字段
- `--geometry-field`（可选）：几何字段名，默认 geometry（支持 WKT 和 GeoJSON）
- `--title`（可选）：地图标题
- `--marker-style`（可选）：点样式 JSON，如 `{"icon":"star","color":"#ef4444"}`

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "visualization",
    "script_name": "create_map.py",
    "arguments": ["--data", "[{\"name\":\"南宁\",\"value\":12,\"geometry\":\"POINT (108.32 22.82)\"}]", "--map-type", "marker", "--value-field", "value", "--name-field", "name"]
  }
}
```

---

### create_bindmap.py - 多图层叠加地图
**功能**：将多个数据源/类型叠加在一张地图上，支持图层切换控件。

**参数**：
- `--layers`（必填）：图层列表 JSON，每项含 data/map_type/value_field/label 等
- `--title`（可选）：地图标题

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "visualization",
    "script_name": "create_bindmap.py",
    "arguments": ["--layers", "[{\"data\":\"[{\\\"name\\\":\\\"南宁\\\",\\\"value\\\":120,\\\"geometry\\\":\\\"POINT (108.32 22.82)\\\"}]\",\"map_type\":\"heatmap\",\"label\":\"降雨量\",\"value_field\":\"value\"}]", "--title", "防汛态势图"]
  }
}
```

---

### revise.py - 修改已有 artifact
**功能**：修改已生成的可视化 artifact 配置，默认深度合并，可选完全替换。

**参数**：
- `--artifact-id`（必填）：要修改的 artifact ID
- `--config-patch`（必填）：配置补丁 JSON
- `--replace`（可选）：加此标志则完全替换而非合并

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "visualization",
    "script_name": "revise.py",
    "arguments": ["--artifact-id", "viz_abc123", "--config-patch", "{\"title\":{\"text\":\"新标题\"}}"]
  }
}
```

## 支持的地图类型
- heatmap：热力图
- marker：标记点地图（支持自定义图标）
- circle：圆圈标记地图（半径按数值缩放）
- choropleth：区域填色图（需要面数据）
- geojson：GeoJSON 通用渲染
- bindmap：多图层叠加（通过 create_bindmap.py）

## 支持的图标
pin, dot, ring, square, diamond, triangle, star, flag, badge, hospital, shelter, station, warning, rescue, supply, school, bridge, dam, reservoir, pump, cross, hexagon, arrow, shield, drop
