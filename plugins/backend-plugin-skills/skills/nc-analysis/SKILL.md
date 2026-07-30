---
name: nc-analysis
description: 检查本地 NetCDF 文件的格式、维度、变量、属性、坐标范围和时间范围。用户上传或提及 .nc、.nc4、.cdf 文件，并询问文件结构、变量含义、时间范围、经纬度范围或海洋数据概况时使用。
---

# NC 文件分析

仅依据工具返回的文件元数据回答，不猜测文件内容。

## 执行流程

1. 从最新 user 上下文的 `<attachments>` 中选择 NC 附件，读取 `file_path_space="absolute"` 对应的 `file_path`。一次只检查一个明确附件；没有结构化附件时要求用户先选择文件。
2. 调用 `activate_skill` 激活 `nc-analysis`。
3. 调用 `execute_skill_script`：

```json
{
  "skill_name": "nc-analysis",
  "script_name": "inspect_nc.py",
  "arguments": ["--file", "D:\\data\\ocean.nc"]
}
```

4. 根据返回 JSON 的 `data` 或大结果引用中的 `样本` 回答。必须读取并列出返回的变量名称、维度和单位，不要仅根据变量数量推断坐标变量或声称工具未返回变量。
5. 工具返回 `artifact_id` 时，在最终回答中原样保留 `[viz:artifact_id]` 引用，让客户端加载数据覆盖范围图层。

## 变量数值地图

用户明确要求展示、绘制或查看某个变量的空间分布时，先通过 `inspect_nc.py` 确认变量及维度，再执行：

```json
{
  "skill_name": "nc-analysis",
  "script_name": "render_nc.py",
  "arguments": ["--file", "D:\\data\\ocean.nc", "--variable", "sea_surface_temperature", "--time-index", "0"]
}
```

含深度维时可增加 `--depth-index`。没有明确时间或深度选择时使用索引 0，并在回答中清楚说明。根据返回的 `statistics` 报告最小值、最大值、平均值和单位；最终回答必须原样包含返回的 `[viz:artifact_id]`。

## 约束

- 仅使用服务端 `<attachments>` 授权的绝对路径；保持路径不变，并将它作为独立 argv 参数传递。
- 不把路径拼入命令字符串，不调用任意用户命令。
- 工具失败时准确转述错误，不声称已经读取文件。
- `inspect_nc.py` 只检查元数据和大小受限的坐标变量；`render_nc.py` 的统计覆盖完整所选切片，输出网格超限时按块均值聚合为有界 GeoJSON，不把单一采样点当作整块。
- `render_nc.py` 当前只支持单调的一维规则经纬度坐标；不支持时准确说明限制。
- 若提示缺少 `netCDF4`，告知用户需要为当前 Python 环境安装本 Skill 的依赖；不要声称已经自动安装。
