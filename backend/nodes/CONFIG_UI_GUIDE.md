# 节点配置UI增强指南

## 概述

新的节点配置系统提供了自动表单生成功能，可以根据Pydantic配置类自动生成友好的前端表单界面。

## 功能特性

### 1. 智能表单控件
- **字符串** → 单行输入框
- **文本** → 多行文本框
- **数字** → 数字输入器（支持范围和步长）
- **布尔** → 开关按钮
- **枚举** → 下拉选择框
- **数组** → 标签列表编辑器
- **JSON** → JSON编辑器（带格式化）
- **密码** → 密码输入框（自动识别key/password/secret字段）

### 2. 字段分组
配置项按功能分组展示：
- **API配置** - API密钥、URL等
- **模型配置** - 模型选择、参数等
- **模板配置** - 模板选择
- **处理配置** - 文档处理参数
- **高级配置** - 超时、重试等

### 3. 表单验证
- 必填字段验证
- 数值范围验证
- 正则表达式验证
- 实时错误提示

### 4. 双视图模式
- **表单视图** - 友好的可视化编辑
- **JSON视图** - 高级用户直接编辑JSON

## 使用方法

### 为配置类添加UI元数据

在Pydantic Field中使用`json_schema_extra`添加UI配置：

```python
from pydantic import Field
from nodes.base import NodeConfigBase

class MyNodeConfig(NodeConfigBase):
    # 基础字段
    api_key: str = Field(
        default="",
        description="API密钥",
        json_schema_extra={
            'group': 'api',           # 分组
            'order': 1,               # 排序
            'format': 'password',     # UI格式
            'placeholder': '请输入密钥'
        }
    )
    
    # 下拉选择
    model: str = Field(
        default="gpt-4o-mini",
        description="模型选择",
        json_schema_extra={
            'group': 'model',
            'order': 1,
            'options': [
                {'label': 'GPT-4o Mini', 'value': 'gpt-4o-mini'},
                {'label': 'GPT-4o', 'value': 'gpt-4o'}
            ]
        }
    )
    
    # 数字范围
    temperature: float = Field(
        default=0.7,
        description="温度参数",
        json_schema_extra={
            'group': 'model',
            'order': 2,
            'minimum': 0.0,
            'maximum': 1.0,
            'multipleOf': 0.1
        }
    )
    
    # 布尔开关
    enable_cache: bool = Field(
        default=True,
        description="启用缓存",
        json_schema_extra={
            'group': 'advanced',
            'order': 1
        }
    )
```

### json_schema_extra 支持的选项

#### 通用选项
- `group`: 分组名称（api/model/template/processing/advanced/default）
- `order`: 字段排序（数字越小越靠前）
- `format`: UI格式（string/text/password/json/textarea）
- `placeholder`: 占位符文本

#### 下拉选择
- `options`: 选项列表 `[{'label': '显示名', 'value': '值'}]`

#### 数字类型
- `minimum`: 最小值
- `maximum`: 最大值
- `multipleOf`: 步长

#### 字符串类型
- `minLength`: 最小长度
- `maxLength`: 最大长度
- `pattern`: 正则表达式
- `patternMessage`: 验证失败提示

#### 文本框
- `rows`: 行数（用于textarea）

## 自动推断规则

如果不提供`json_schema_extra`，系统会自动推断：

### 分组推断
- 包含 api/key/url/endpoint → `api`组
- 包含 model/temperature/token → `model`组
- 包含 template/prompt → `template`组
- 包含 chunk/process/parse → `processing`组
- 包含 timeout/retry/encoding → `advanced`组

### 格式推断
- 字段名包含 password/secret/key → `password`格式
- 字段名包含 text/content/prompt → `textarea`格式
- 类型为 object → `json`格式

## API端点

### 获取配置Schema
```
GET /api/nodes/types/{node_type}/config-schema
```

返回增强的JSON Schema，包含所有UI渲染信息。

## 前端组件

### NodeConfigEditor
```vue
<NodeConfigEditor
  v-model="configData"
  :node-definition="nodeDefinition"
  :config-schema="configSchema"
  @validate="onValidate"
/>
```

#### Props
- `modelValue`: 配置对象（双向绑定）
- `nodeDefinition`: 节点定义
- `configSchema`: 配置Schema

#### Events
- `update:modelValue`: 配置更新
- `validate`: 验证结果

#### Methods
- `validate()`: 验证表单
- `getFormData()`: 获取表单数据
- `resetForm()`: 重置表单

## 示例

参考 `backend/nodes/llmjson_v2/config.py` 查看完整示例。

## 最佳实践

1. **合理分组** - 将相关配置放在同一组
2. **清晰描述** - 提供详细的description
3. **设置范围** - 为数字字段设置合理的min/max
4. **提供选项** - 对于有限选择的字段使用options
5. **排序优化** - 重要字段放在前面（order值小）
