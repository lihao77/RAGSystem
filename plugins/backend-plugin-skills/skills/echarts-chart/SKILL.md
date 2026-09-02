---
name: visualization
description: 创建和修改 ECharts 折线图、柱状图、饼图和散点图。用户要求把结构化数据制作成统计图表或调整已有图表文件时使用。
---

## 可视化工具

本 Skill 只负责 ECharts 图表。脚本把图表配置写入 execute_skill_script 传入的 cwd，并返回通用 `file.path`。

不要把完整配置或二进制内容编码到 stdout；需要交付的文件必须写入 cwd，并在 `file` 中返回相对路径、媒体类型和大小。

## 可用脚本

### create_chart.py - ECharts 图表生成
**功能**：从数据生成 ECharts 图表配置并写入 JSON 文件。

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

### revise.py - 修改已有图表文件
**功能**：修改已有图表 JSON 配置，默认深度合并，可选完全替换。

**参数**：
- `--file`（必填）：cwd 下已有的图表 JSON 文件
- `--config-patch`（必填）：配置补丁 JSON
- `--replace`（可选）：加此标志则完全替换而非合并

**调用示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "visualization",
    "script_name": "revise.py",
    "arguments": ["--file", "chart-bar.json", "--config-patch", "{\"title\":{\"text\":\"新标题\"}}"]
  }
}
```
