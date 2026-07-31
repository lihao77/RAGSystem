# Artifact Plugin

Artifact V2 将一个 Artifact 定义为有语义的产物 Manifest。Manifest 可以引用多个二进制 Asset，并声明一个或多个受控 Presentation。`kind`、`surface` 和 `renderer` 使用开放的命名空间字符串，新类型不需要修改存储层。

## Skill 输出协议

`execute_skill_script` 成功结果中的 `artifact` 字段使用以下结构：

```json
{
  "schema_version": 2,
  "kind": "map.raster",
  "subtype": "nc.aggregate",
  "title": "Sea temperature",
  "assets": [
    {
      "asset_id": "data",
      "role": "data",
      "filename": "temperature.tif",
      "media_type": "image/tiff",
      "staged_file": "temperature.tif"
    },
    {
      "asset_id": "preview",
      "role": "preview",
      "filename": "temperature.png",
      "media_type": "image/png",
      "staged_file": "temperature.png"
    }
  ],
  "presentations": [
    {
      "presentation_id": "map",
      "surface": "map",
      "renderer": "map.raster-tile",
      "assets": { "source": "data", "preview": "preview" },
      "config": {}
    }
  ],
  "metadata": {},
  "provenance": {},
  "relations": []
}
```

只有小文件才直接把 `staged_file` 换成 `data_base64`；两种字段不能同时出现。

每个内联 Asset 最大 32 MiB，一个 Artifact 的内联 Asset 总量最大 128 MiB。内联方式适合小型 JSON 或配置；PNG、GeoTIFF、CSV、PDF 等文件应使用 staging，不会经过模型文本上下文。

### Staging 文件协议

Skills 插件会为每次有 Session 的脚本调用创建私有输出目录，并通过环境变量提供给脚本：

```text
RAGSYSTEM_ARTIFACT_OUTPUT_DIR=<private-run-output-directory>
```

脚本只能把文件写到该目录，并在 Artifact Asset 中返回相对路径：

```python
import json
import os
from pathlib import Path

output_dir = Path(os.environ["RAGSYSTEM_ARTIFACT_OUTPUT_DIR"])
(output_dir / "temperature.tif").write_bytes(b"...")

print(json.dumps({
    "success": True,
    "data": {"title": "Sea temperature"},
    "artifact": {
        "schema_version": 2,
        "kind": "map.raster",
        "assets": [{
            "asset_id": "data",
            "role": "data",
            "filename": "temperature.tif",
            "media_type": "image/tiff",
            "staged_file": "temperature.tif"
        }],
        "presentations": [{
            "presentation_id": "map",
            "surface": "map",
            "renderer": "map.raster",
            "assets": {"source": "data"},
            "config": {}
        }]
    }
}))
```

Skills 插件在工具结果返回前完成以下工作：

1. 校验相对路径、普通文件、大小、数量和目录边界。
2. 计算 SHA-256，并将 `staged_file` 替换为不透明的 `staged_file_id`。
3. 删除未被结构化结果引用的本次输出目录。

Artifact Hook 随后按 `tenant_id + session_id + run_id + tool_call_id` 校验归属并 claim 文件。Artifact 创建成功后 staging 文件被消费；创建失败则 claim 回滚为 ready，由一小时 TTL 负责最终清理。脚本不能直接提供 `staged_file_id`，也不能同时提供 `staged_file` 与 `data_base64`。

默认配额为单文件 512 MiB、单次运行 1 GiB、最多 64 个文件。staging 目录位于 `<data-root>/staging/artifacts`，不属于聊天消息或模型上下文。

### 其他工具接入

Artifact 插件注册 `ragsystem.artifact-staging` 资源。其他后端插件可在自己的 runtime 中按 `tenantId` 和 `dataRoot` 获取同一个 provider，创建 run、登记输出，并返回 `staged_file_id`；Artifact Hook 的接管协议不区分文件来自 Skill 还是其他插件工具。

目前 Skills 插件已经完成这一适配。直接定义在 `backend-core` 内且没有插件 runtime 的工具若要写 staging，需要在其所属插件增加适配器，或扩展核心工具依赖注入；本次实现没有修改 `backend-core` 或 `backend-local`。

## 修订协议

Asset 内容不可变。修订只更新标题、状态、元数据、关系和 Presentation，并递增 `revision`：

```json
{
  "schema_version": 2,
  "action": "revise",
  "artifact_id": "art_example",
  "presentation_patches": [
    {
      "presentation_id": "map",
      "config": { "opacity": 0.6 },
      "replace": false
    }
  ]
}
```

Hook 只允许修改当前 Session 的 Artifact。

## HTTP API

- `GET /api/artifacts?session_id=<session>`：按创建顺序列出 V2 Artifact 摘要。
- `GET /api/artifacts/:artifactId`：获取完整 Manifest。
- `GET /api/artifacts/:artifactId/assets/:assetId/content`：读取 Asset 原始二进制。
- `GET .../content?download=1`：使用附件方式下载。
- `DELETE /api/artifacts/:artifactId`：删除 Manifest 及其全部 Asset。
- `DELETE /api/artifacts?session_id=<session>`：删除 Session 的全部 Artifact。

Asset 响应包含正确的 `Content-Type`、文件名、长期私有缓存头和以 SHA-256 生成的 `ETag`。

## 存储

Local 模式采用以下目录：

```text
sessions/<session>/artifacts/<artifact_id>/
  manifest.json
  assets/
    data.tif
    preview.png
```

SaaS 模式使用 `artifact_metadata_v2` 保存索引，Manifest 和 Asset 保存到对象存储。旧的 V1 表和文件不会自动导入 V2，也不会在迁移时删除。

Local 模式从 staging 文件复制到 Artifact 临时目录，复核大小和 SHA-256 后再原子发布 Artifact。SaaS 模式同样复核文件后写入对象存储；当前宿主对象存储契约只接受 `Uint8Array`，因此上传阶段仍会在服务端读取整个文件，但文件内容不会进入工具结果或模型上下文。对象存储契约以后支持 stream 时，可只替换该存储分支。
