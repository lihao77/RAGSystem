---
name: visualization
description: 创建和修改 ECharts 折线图、柱状图、饼图和散点图。用户要求把结构化数据制作成统计图表或调整已有 ECharts Artifact 时使用。
---

## 可视化工具

本 Skill 只负责 ECharts 图表。所有脚本输出 Artifact V2，系统自动完成持久化。
在 `<final_answer>` 中使用 `[artifact:artifact_id]` 展示图表产物。

脚本生成 PNG、GeoTIFF、CSV、JSON、PDF 等文件时，必须写入环境变量 `RAGSYSTEM_ARTIFACT_OUTPUT_DIR` 指向的目录，并在 Asset 中使用相对 `staged_file`。不要读取文件并生成 `data_base64`；系统会登记文件、替换为不透明 ID 并在 Artifact 创建成功后接管。

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

### revise.py - 修改已有 artifact
**功能**：修改已有可视化 Artifact 的 primary Presentation 配置，默认深度合并，可选完全替换。

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
    "arguments": ["--artifact-id", "art_abc123", "--config-patch", "{\"title\":{\"text\":\"新标题\"}}"]
  }
}
```
