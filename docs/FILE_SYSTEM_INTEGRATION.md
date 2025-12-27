# 节点系统和工作流系统接入文件系统 - 实现逻辑

## 概述

本文档描述了节点系统和工作流系统如何接入文件系统，实现文件选择、传递和处理的完整流程。

## 核心实现文件

### 后端核心文件
1. **`backend/routes/files.py`** - 文件管理API（上传、列表、删除、下载）
2. **`backend/routes/nodes.py`** - 节点API，包含数据类型定义（file_id, file_ids）
3. **`backend/nodes/schema_generator.py`** - Schema生成器，支持file_selector元数据
4. **`backend/file_index.py`** - 文件索引管理（YAML存储）

### 前端核心文件
1. **`frontend/src/components/FileSelector.vue`** - 文件选择器组件
2. **`frontend/src/components/workflow/NodeConfigEditor.vue`** - 节点配置编辑器（集成文件选择器）
3. **`frontend/src/views/NodesView.vue`** - 节点测试界面（执行输入支持文件选择）
4. **`frontend/src/views/WorkflowBuilderView.vue`** - 工作流编辑器（变量支持文件类型）
5. **`frontend/src/api/fileService.js`** - 文件API服务

## 三大集成场景

### 场景1: 节点配置编辑器中的文件选择

**实现方式**：通过配置字段的 `json_schema_extra` 元数据指定 `format: 'file_selector'`

**示例代码**：
```python
# backend/nodes/example/config.py
class ExampleNodeConfig(NodeConfigBase):
    input_file: str = Field(
        default="",
        description="输入文件",
        json_schema_extra={
            'format': 'file_selector',
            'file_extensions': ['.pdf', '.txt'],
            'mime_types': ['application/pdf'],
            'multiple': False
        }
    )
```

**关键代码位置**：
- Schema生成: `backend/nodes/schema_generator.py` (第156-162行)
- 前端渲染: `frontend/src/components/workflow/NodeConfigEditor.vue` (第44-51行)

---

### 场景2: 节点测试界面的执行输入

**实现方式**：前端智能识别输入字段名称，自动渲染文件选择器

**识别规则**：
- 名称为 `file_id` 或以 `_file_id` 结尾 → 单文件选择器
- 名称为 `file_ids` 或以 `_file_ids` 结尾 → 多文件选择器
- `array` 类型且名称/描述包含 "file" → 多文件选择器

**关键代码位置**：
- 前端识别逻辑: `frontend/src/views/NodesView.vue` (第119-135行)
- 后端执行: `backend/routes/nodes.py` (第234-270行)

---

### 场景3: 工作流全局变量

**实现方式**：后端提供 `file_id` 和 `file_ids` 数据类型，前端根据类型渲染文件选择器

**关键代码位置**：
- 后端类型定义: `backend/routes/nodes.py` (第116行)
- 前端变量表格: `frontend/src/views/WorkflowBuilderView.vue` (第88-108行)

---

## 数据流转

### 文件上传流程
```
用户选择文件 → POST /api/files/upload → 
保存到 uploads/ → 生成UUID → 
写入 file_index.yaml → 返回文件ID
```

### 文件选择流程
```
打开FileSelector → GET /api/files → 
前端过滤（扩展名/MIME/搜索） → 
用户选择 → 返回文件ID
```

### 文件使用流程
```
节点接收 file_id → FileIndex.get(file_id) → 
获取 stored_path → 读取文件 → 处理
```

## 配置示例

### 单文件输入
```python
input_file: str = Field(
    default="",
    json_schema_extra={
        'format': 'file_selector',
        'file_extensions': ['.pdf', '.txt'],
        'multiple': False
    }
)
```

### 多文件输入
```python
input_files: List[str] = Field(
    default_factory=list,
    json_schema_extra={
        'format': 'file_selector',
        'file_extensions': ['.csv', '.xlsx'],
        'multiple': True
    }
)
```

### 工作流变量
```javascript
{
  "vars": [
    {
      "name": "source_files",
      "type": "file_ids",
      "value": ["uuid-1", "uuid-2"]
    }
  ]
}
```

## 核心设计原则

1. **统一文件标识**：使用UUID作为文件ID
2. **解耦存储**：文件物理存储与业务逻辑分离
3. **灵活过滤**：支持扩展名和MIME类型过滤
4. **类型安全**：通过Pydantic验证配置
5. **用户友好**：可视化文件选择界面
