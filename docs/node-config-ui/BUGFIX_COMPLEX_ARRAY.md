# 复杂数组字段显示问题修复

## 问题描述

Json2Graph节点的`processors`字段是一个复杂对象数组（`List[ProcessorConfig]`），在前端显示时出现异常。

### 问题原因

1. **后端问题**: `default_factory`返回的Pydantic模型实例无法直接JSON序列化
2. **前端问题**: 数组类型默认使用简单的标签编辑器，无法处理复杂对象数组

## 修复方案

### 后端修复 (backend/nodes/schema_generator.py)

#### 1. 处理default_factory
```python
# 获取默认值
if field_info.default_factory is not None:
    try:
        default_value = field_info.default_factory()
    except Exception:
        default_value = base_field_schema.get('default', None)
```

#### 2. 转换Pydantic模型为字典
```python
# 如果默认值是Pydantic模型或包含Pydantic模型的列表，转换为字典
if default_value is not None:
    if isinstance(default_value, BaseModel):
        default_value = default_value.model_dump()
    elif isinstance(default_value, list):
        default_value = [
            item.model_dump() if isinstance(item, BaseModel) else item
            for item in default_value
        ]
```

### 前端修复 (frontend/src/components/workflow/NodeConfigEditor.vue)

#### 1. 使用JSON编辑器处理复杂数组
```vue
<!-- JSON编辑器（包括对象和复杂数组） -->
<div v-else-if="field.type === 'json' || field.type === 'array' || 
                 field.type === 'object' || field.format === 'json'" 
     class="json-field">
  <el-input
    v-model="formData[field.name]"
    type="textarea"
    :rows="field.rows || 4"
  />
  <el-button @click="formatJsonField(field.name)">格式化</el-button>
</div>
```

#### 2. 初始化时转换为JSON字符串
```javascript
function initFormData() {
  // JSON/对象/数组类型需要转换为字符串
  if (schema.format === 'json' || schema.type === 'object' || 
      (schema.type === 'array' && schema.format === 'json')) {
    if (typeof data[key] !== 'string') {
      data[key] = JSON.stringify(data[key], null, 2);
    }
  }
}
```

#### 3. 保存时转换回对象
```javascript
function getFormData() {
  // 将JSON字符串字段转换回对象
  if (schema.format === 'json' || schema.type === 'object' || 
      (schema.type === 'array' && schema.format === 'json')) {
    if (typeof data[key] === 'string' && data[key]) {
      data[key] = JSON.parse(data[key]);
    }
  }
}
```

## 配置方式

在节点配置中，对于复杂数组字段，使用`format: 'json'`：

```python
processors: List[ProcessorConfig] = Field(
    default_factory=lambda: [
        ProcessorConfig(
            name="SpatialProcessor",
            class_path="json2graph.processor.SpatialProcessor",
            enabled=True,
            params={}
        )
    ],
    description="处理器配置列表（JSON格式）",
    json_schema_extra={
        'group': 'processing',
        'order': 2,
        'format': 'json',  # 关键：使用JSON编辑器
        'rows': 8
    }
)
```

## 测试

### 后端测试
```bash
cd backend
python test_json2graph_schema.py
```

### 前端测试
1. 启动服务
2. 访问节点系统页面
3. 选择Json2Graph节点
4. 查看processors字段是否正确显示为JSON编辑器
5. 编辑并保存配置

## 预期效果

### 显示效果
```
━━━ 处理配置 ━━━━━━━━━━━━━━━━━━━━

处理器配置列表（JSON格式）
┌─────────────────────────────────┐
│ [                               │
│   {                             │
│     "name": "SpatialProcessor", │
│     "class_path": "...",        │
│     "enabled": true,            │
│     "params": {}                │
│   }                             │
│ ]                               │
└─────────────────────────────────┘
[格式化]
```

### 保存数据
```json
{
  "processors": [
    {
      "name": "SpatialProcessor",
      "class_path": "json2graph.processor.SpatialProcessor",
      "enabled": true,
      "params": {}
    }
  ]
}
```

## 适用场景

这个修复适用于以下类型的字段：

1. **复杂对象数组** - `List[SomeModel]`
2. **嵌套对象** - `Dict[str, Any]`
3. **任意JSON数据** - 需要灵活编辑的JSON字段

## 注意事项

1. **JSON格式验证** - 用户输入的JSON必须格式正确
2. **格式化按钮** - 提供格式化功能帮助用户
3. **错误处理** - 解析失败时保持原值并提示用户

## 相关文件

- `backend/nodes/schema_generator.py` - Schema生成器
- `frontend/src/components/workflow/NodeConfigEditor.vue` - 配置编辑器
- `backend/nodes/json2graph/config.py` - Json2Graph配置
- `backend/test_json2graph_schema.py` - 测试脚本

---

**修复时间**: 2025-12-26  
**影响节点**: Json2Graph  
**状态**: ✅ 已修复  
