# 节点配置UI升级说明

## 概述

已完成节点系统配置界面的全面升级，从简陋的JSON文本框升级为智能的动态表单系统。

## 升级内容

### 1. 后端增强

#### 新增文件
- `backend/nodes/schema_generator.py` - Schema生成器，从Pydantic模型生成UI友好的JSON Schema
- `backend/nodes/CONFIG_UI_GUIDE.md` - 配置UI使用指南

#### 修改文件
- `backend/nodes/base.py` - 添加 `get_config_schema()` 方法
- `backend/routes/nodes.py` - 添加 `/api/nodes/types/<node_type>/config-schema` 端点
- `backend/nodes/llmjson_v2/config.py` - 为所有字段添加UI元数据

### 2. 前端增强

#### 新增组件
- `frontend/src/components/workflow/NodeConfigEditor.vue` - 智能配置编辑器组件

#### 修改文件
- `frontend/src/views/NodesView.vue` - 集成新的配置编辑器
- `frontend/src/api/nodeService.js` - 添加 `getConfigSchema()` API方法

## 主要特性

### 1. 智能表单生成
根据配置类型自动选择合适的UI控件：
- 字符串 → 单行输入框
- 文本 → 多行文本框
- 数字 → 数字输入器（支持范围和步长）
- 布尔 → 开关按钮
- 枚举 → 下拉选择框
- 数组 → 标签列表编辑器
- JSON → JSON编辑器
- 密码 → 密码输入框（自动识别）

### 2. 字段分组
配置项按功能自动分组：
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
- **表单视图** - 友好的可视化编辑（默认）
- **JSON视图** - 高级用户直接编辑JSON

### 5. 智能推断
如果不提供UI元数据，系统会根据字段名和类型自动推断：
- 分组归属
- UI控件类型
- 格式要求

## 使用方法

### 为新节点添加UI元数据

在Pydantic配置类中使用 `json_schema_extra`：

```python
from pydantic import Field
from nodes.base import NodeConfigBase

class MyNodeConfig(NodeConfigBase):
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
    
    model: str = Field(
        default="gpt-4o-mini",
        description="模型选择",
        json_schema_extra={
            'group': 'model',
            'options': [
                {'label': 'GPT-4o Mini', 'value': 'gpt-4o-mini'},
                {'label': 'GPT-4o', 'value': 'gpt-4o'}
            ]
        }
    )
    
    temperature: float = Field(
        default=0.7,
        description="温度参数",
        json_schema_extra={
            'group': 'model',
            'minimum': 0.0,
            'maximum': 1.0,
            'multipleOf': 0.1
        }
    )
```

### 支持的UI元数据选项

#### 通用
- `group`: 分组名称
- `order`: 排序（数字越小越靠前）
- `format`: UI格式
- `placeholder`: 占位符

#### 下拉选择
- `options`: `[{'label': '显示名', 'value': '值'}]`

#### 数字
- `minimum`: 最小值
- `maximum`: 最大值
- `multipleOf`: 步长

#### 字符串
- `minLength`: 最小长度
- `maxLength`: 最大长度
- `pattern`: 正则表达式
- `patternMessage`: 验证失败提示

#### 文本框
- `rows`: 行数

## API端点

### 获取配置Schema
```
GET /api/nodes/types/{node_type}/config-schema
```

返回示例：
```json
{
  "success": true,
  "schema": {
    "type": "object",
    "title": "LLMJsonV2NodeConfig",
    "properties": {
      "api_key": {
        "type": "string",
        "title": "Api Key",
        "description": "OpenAI API密钥",
        "group": "api",
        "groupLabel": "API配置",
        "order": 1,
        "format": "password",
        "placeholder": "请输入API密钥"
      },
      "template": {
        "type": "string",
        "title": "Template",
        "description": "模板选择",
        "group": "template",
        "options": [
          {"label": "通用模板", "value": "universal"},
          {"label": "洪涝灾害", "value": "flood"}
        ]
      }
    }
  }
}
```

## 测试

### 后端测试
```bash
cd backend
python test_schema_simple.py
```

### 前端测试
1. 启动后端服务
2. 启动前端服务
3. 访问节点系统页面
4. 选择任意节点类型
5. 查看配置编辑器是否正确显示表单

## 示例节点

参考 `backend/nodes/llmjson_v2/config.py` 查看完整的UI元数据配置示例。

## 兼容性

- 向后兼容：未添加UI元数据的节点会自动降级到JSON编辑器
- 自动推断：系统会根据字段名和类型自动推断合理的UI配置
- 双视图：用户可以随时切换到JSON视图进行高级编辑

## 优势

### 用户体验
- ✓ 直观的表单界面，无需手写JSON
- ✓ 实时验证和错误提示
- ✓ 智能的字段分组和排序
- ✓ 适合不同类型的输入控件

### 开发体验
- ✓ 声明式配置，易于维护
- ✓ 自动推断，减少配置工作
- ✓ 类型安全，利用Pydantic验证
- ✓ 可扩展，支持自定义UI元数据

### 系统架构
- ✓ 前后端分离，职责清晰
- ✓ Schema驱动，单一数据源
- ✓ 向后兼容，平滑升级
- ✓ 可测试，易于调试

## 后续优化

1. **条件显示** - 根据其他字段值动态显示/隐藏字段
2. **字段联动** - 字段之间的依赖关系
3. **自定义验证器** - 更复杂的验证逻辑
4. **配置模板** - 预设配置模板
5. **配置对比** - 对比不同配置的差异
6. **配置导入导出** - 支持配置的导入导出

## 相关文档

- `backend/nodes/CONFIG_UI_GUIDE.md` - 详细的使用指南
- `backend/nodes/schema_generator.py` - Schema生成器源码
- `frontend/src/components/workflow/NodeConfigEditor.vue` - 配置编辑器组件
