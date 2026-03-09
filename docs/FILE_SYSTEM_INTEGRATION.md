# 文件系统接入

本文档只描述仓库当前仍在使用的文件接入方式，不记录历史实现。

## 1. 当前事实

当前文件接入分成两层：

- 文件上传与下载：`backend/routes/files.py`
- 文件元数据索引：`backend/file_index/`

当前后端默认导出的 `FileIndex` 是 `FileIndexSQLite`，数据写入 `backend/data/ragsystem.db`。

兼容情况：

- `backend/file_index/sqlite_store.py`：当前默认实现
- `backend/file_index/store.py`：YAML 兼容实现
- `backend/file_index/__init__.py`：统一导出与兼容工厂

也就是说，当前系统的“文件系统接入”不是单纯的 `uploads + files.yaml`，而是：

1. 物理文件保存到 `backend/uploads/`
2. 元数据默认保存到 SQLite
3. 仅在兼容或迁移场景下才回退到 YAML

## 2. 关键文件

### 后端

- `backend/routes/files.py`
- `backend/file_index/__init__.py`
- `backend/file_index/sqlite_store.py`
- `backend/file_index/store.py`
- `backend/nodes/schema_generator.py`

### 前端管理端

- `frontend/src/api/fileService.js`
- `frontend/src/components/FileSelector.vue`
- `frontend/src/components/workflow/NodeConfigEditor.vue`
- `frontend/src/views/NodesView.vue`
- `frontend/src/views/WorkflowBuilderView.vue`

## 3. HTTP 接口

当前文件接口前缀为 `/api/files`：

- `GET /api/files`
- `GET /api/files/<file_id>`
- `POST /api/files/upload`
- `DELETE /api/files/<file_id>`
- `GET /api/files/<file_id>/download`
- `POST /api/files/validate`

当前 `GET /api/files` 返回文件列表，支持：

- `extensions`
- `mime_types`

当两者同时提供时，后端使用 OR 逻辑过滤。

## 4. 上传与索引流程

当前上传链路：

1. 前端通过 `frontend/src/api/fileService.js` 把文件以 `files` 表单字段提交到 `POST /api/files/upload`
2. `backend/routes/files.py` 把文件保存到 `UPLOAD_FOLDER`，默认是 `backend/uploads/`
3. 后端生成随机 `stored_name`
4. 后端将 `original_name`、`stored_name`、`stored_path`、`size`、`mime`、时间戳等信息写入 `FileIndex`
5. 返回文件记录给前端

当前默认文件记录字段以 `backend/file_index/sqlite_store.py` 为准，常见字段包括：

- `id`
- `original_name`
- `stored_name`
- `stored_path`
- `size`
- `mime`
- `uploaded_at`

说明：

- 当前后端主字段名是 `uploaded_at`
- 如果前端页面需要显示上传时间，应消费这个字段，而不是假设其他命名

## 5. 节点配置中的文件选择

节点配置表单通过 Schema 元数据驱动文件选择器。

当前实现链路：

1. 节点配置类在 `config.py` 中使用 `json_schema_extra`
2. `backend/nodes/schema_generator.py` 读取 `format=file_selector`、`file_extensions`、`mime_types`、`multiple`
3. 前端 `frontend/src/components/workflow/NodeConfigEditor.vue` 将该字段渲染为 `FileSelector`

典型配置方式：

```python
input_file: str = Field(
    default="",
    description="输入文件",
    json_schema_extra={
        "format": "file_selector",
        "file_extensions": [".pdf", ".txt"],
        "mime_types": ["application/pdf", "text/plain"],
        "multiple": False,
    },
)
```

多文件字段同理，只需把 `multiple` 设为 `True`，并让字段类型与默认值匹配数组语义。

## 6. 节点执行页中的文件输入

`frontend/src/views/NodesView.vue` 当前有两种文件输入来源：

- `FileSelector`
  - 用于选择已上传到后端文件库中的文件 ID
- `LocalFileInput`
  - 用于直接选择本地文件列表

当前识别规则以页面实现为准：

- 输入名为 `file_id` 或以 `_file_id` 结尾时，渲染单文件选择器
- 输入类型为 `file_ids`，或输入名为 `file_ids` / 以 `_file_ids` 结尾时，渲染多文件选择器
- 输入名为 `files` 时，渲染本地文件选择组件
- 某些 `array` 输入若描述中明确包含 `file_id`，也会走多文件选择器

这部分属于前端约定，不是后端自动推断。

## 7. 工作流变量中的文件类型

工作流页通过 `GET /api/nodes/data-types` 获取可用数据类型。

当前后端会显式补充这些常用类型：

- `file_id`
- `file_ids`

前端 `frontend/src/views/WorkflowBuilderView.vue` 对应行为：

- `file_id` 渲染单文件选择器
- `file_ids` 渲染多文件选择器

运行工作流时：

- 变量默认值保存在工作流定义里
- 运行弹窗里的值会组装成 `initial_inputs`
- `file_id` 保持字符串
- `file_ids` 保持字符串数组

## 8. 删除与下载

当前删除链路：

1. 前端调用 `DELETE /api/files/<file_id>`
2. 后端先尝试删除物理文件
3. 再从 `FileIndex` 删除元数据记录

当前下载链路：

1. 前端拼接 `/api/files/<file_id>/download`
2. 后端根据索引里的 `stored_name` 从上传目录返回附件

## 9. 当前边界

当前文档只覆盖仓库里已经实现的文件接入事实：

- 只描述本地上传目录 + 本地文件索引
- 不描述对象存储
- 不描述远程文件网关
- 不描述文件内容自动解析链路

如果后续把文件索引彻底统一为 SQLite，或把下载地址改为走前端代理，应同步更新本文档与 `frontend/src/api/fileService.js`。
