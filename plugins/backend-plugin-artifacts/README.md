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
      "data_base64": "..."
    },
    {
      "asset_id": "preview",
      "role": "preview",
      "filename": "temperature.png",
      "media_type": "image/png",
      "data_base64": "..."
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

每个内联 Asset 最大 32 MiB，一个 Artifact 的内联 Asset 总量最大 128 MiB。更大的文件应通过后续的服务端暂存或流式写入能力接入，不能经过模型文本上下文。

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
