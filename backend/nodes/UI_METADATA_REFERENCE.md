# UI元数据快速参考

## 基本用法

```python
from pydantic import Field
from nodes.base import NodeConfigBase

class MyNodeConfig(NodeConfigBase):
    field_name: str = Field(
        default="default_value",
        description="字段说明",
        json_schema_extra={
            # UI元数据配置
        }
    )
```

## 通用选项

| 选项 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `group` | str | 分组名称 | `'api'`, `'model'`, `'processing'` |
| `groupLabel` | str | 分组显示名称 | `'API配置'`, `'模型配置'` |
| `order` | int | 字段排序（越小越靠前） | `1`, `2`, `3` |
| `format` | str | UI格式 | `'password'`, `'textarea'`, `'json'` |
| `placeholder` | str | 占位符文本 | `'请输入API密钥'` |

## 预定义分组

| 分组名 | 标签 | 用途 | 排序 |
|--------|------|------|------|
| `default` | 基础配置 | 默认分组 | 0 |
| `api` | API配置 | API相关配置 | 1 |
| `database` | 数据库配置 | 数据库连接 | 1 |
| `model` | 模型配置 | LLM模型参数 | 2 |
| `template` | 模板配置 | 模板选择 | 3 |
| `processing` | 处理配置 | 数据处理参数 | 4 |
| `metadata` | 元数据配置 | 文档元数据 | 5 |
| `output` | 输出设置 | 输出相关配置 | 6 |
| `advanced` | 高级配置 | 高级选项 | 7 |

## 控件类型

### 1. 文本输入框（默认）
```python
name: str = Field(
    default="",
    description="名称",
    json_schema_extra={
        'placeholder': '请输入名称'
    }
)
```

### 2. 密码输入框
```python
api_key: str = Field(
    default="",
    description="API密钥",
    json_schema_extra={
        'format': 'password'
    }
)
```

### 3. 多行文本框
```python
content: str = Field(
    default="",
    description="内容",
    json_schema_extra={
        'format': 'textarea',
        'rows': 5
    }
)
```

### 4. 数字输入器
```python
temperature: float = Field(
    default=0.7,
    description="温度",
    json_schema_extra={
        'minimum': 0.0,
        'maximum': 1.0,
        'multipleOf': 0.1
    }
)
```

### 5. 开关按钮
```python
enabled: bool = Field(
    default=True,
    description="启用"
)
```

### 6. 下拉选择框
```python
model: str = Field(
    default="gpt-4o-mini",
    description="模型",
    json_schema_extra={
        'options': [
            {'label': 'GPT-4o Mini', 'value': 'gpt-4o-mini'},
            {'label': 'GPT-4o', 'value': 'gpt-4o'}
        ]
    }
)
```

### 7. JSON编辑器
```python
config: dict = Field(
    default_factory=dict,
    description="配置",
    json_schema_extra={
        'format': 'json',
        'rows': 8
    }
)
```

### 8. 文件选择器
```python
# 单文件选择
input_file: str = Field(
    default="",
    description="输入文件",
    json_schema_extra={
        'format': 'file_selector',
        'file_extensions': ['.pdf', '.docx', '.txt'],
        'mime_types': ['application/pdf'],
        'placeholder': '选择文件'
    }
)

# 多文件选择
reference_files: list = Field(
    default_factory=list,
    description="参考文件",
    json_schema_extra={
        'format': 'file_selector',
        'multiple': True,
        'file_extensions': ['.pdf'],
        'placeholder': '选择多个文件'
    }
)

# 自动推断（字段名包含'file'、'document'、'upload'、'attachment'）
document_file: str = Field(
    default="",
    description="文档文件",
    json_schema_extra={
        'placeholder': '选择文档'
    }
)
```

**文件选择器选项：**
- `format`: 设置为 `'file_selector'` 启用文件选择器（或通过字段名自动推断）
- `file_extensions`: 允许的文件扩展名列表，如 `['.pdf', '.docx']`
- `mime_types`: 允许的MIME类型列表，如 `['application/pdf']`
- `multiple`: 设置为 `True` 允许选择多个文件
- `placeholder`: 占位符文本

**自动推断规则：**
如果字段名包含以下关键词，会自动推断为文件选择器：
- `file`
- `document`
- `upload`
- `attachment`

## 验证选项

### 数字范围
```python
chunk_size: int = Field(
    default=1000,
    description="分块大小",
    json_schema_extra={
        'minimum': 100,
        'maximum': 10000,
        'multipleOf': 100
    }
)
```

### 字符串长度
```python
name: str = Field(
    default="",
    description="名称",
    json_schema_extra={
        'minLength': 1,
        'maxLength': 100
    }
)
```

### 正则表达式
```python
email: str = Field(
    default="",
    description="邮箱",
    json_schema_extra={
        'pattern': r'^[\w\.-]+@[\w\.-]+\.\w+$',
        'patternMessage': '请输入有效的邮箱地址'
    }
)
```

## 完整示例

```python
from pydantic import Field
from nodes.base import NodeConfigBase

class ExampleNodeConfig(NodeConfigBase):
    """示例节点配置"""
    
    # API配置组
    api_key: str = Field(
        default="",
        description="API密钥",
        json_schema_extra={
            'group': 'api',
            'groupLabel': 'API配置',
            'order': 1,
            'format': 'password',
            'placeholder': '请输入API密钥',
            'minLength': 1
        }
    )
    
    base_url: str = Field(
        default="https://api.example.com",
        description="API基础URL",
        json_schema_extra={
            'group': 'api',
            'order': 2,
            'placeholder': 'https://api.example.com'
        }
    )
    
    # 模型配置组
    model: str = Field(
        default="default",
        description="模型选择",
        json_schema_extra={
            'group': 'model',
            'groupLabel': '模型配置',
            'order': 1,
            'options': [
                {'label': '默认模型', 'value': 'default'},
                {'label': '高级模型', 'value': 'advanced'}
            ]
        }
    )
    
    temperature: float = Field(
        default=0.7,
        description="生成温度",
        json_schema_extra={
            'group': 'model',
            'order': 2,
            'minimum': 0.0,
            'maximum': 1.0,
            'multipleOf': 0.1
        }
    )
    
    # 处理配置组
    chunk_size: int = Field(
        default=1000,
        description="分块大小",
        json_schema_extra={
            'group': 'processing',
            'groupLabel': '处理配置',
            'order': 1,
            'minimum': 100,
            'maximum': 10000,
            'multipleOf': 100
        }
    )
    
    enable_cache: bool = Field(
        default=True,
        description="启用缓存",
        json_schema_extra={
            'group': 'processing',
            'order': 2
        }
    )
    
    # 高级配置组
    timeout: int = Field(
        default=60,
        description="超时时间（秒）",
        json_schema_extra={
            'group': 'advanced',
            'groupLabel': '高级配置',
            'order': 1,
            'minimum': 10,
            'maximum': 300
        }
    )
```

## 自动推断规则

如果不提供UI元数据，系统会自动推断：

### 分组推断
- 包含 `api`, `key` → `api`组
- 包含 `neo4j`, `database`, `db` → `database`组
- 包含 `model`, `temperature`, `token` → `model`组
- 包含 `chunk`, `process`, `worker` → `processing`组
- 包含 `document`, `source`, `language` → `metadata`组
- 包含 `output`, `save`, `export` → `output`组
- 包含 `timeout`, `retry`, `clear` → `advanced`组

### 格式推断
- 字段名包含 `password`, `secret`, `key` → `password`格式
- 字段名包含 `text`, `content`, `prompt` → `textarea`格式
- 字段类型为 `dict`, `list` → `json`格式

## 最佳实践

1. **合理分组** - 相关配置放在同一组
2. **清晰描述** - 提供详细的description
3. **设置范围** - 为数字字段设置合理的min/max
4. **提供选项** - 有限选择使用options
5. **排序优化** - 重要字段order值小
6. **占位符** - 提供示例值作为placeholder
7. **验证规则** - 添加必要的验证约束

## 常见问题

### Q: 如何让字段必填？
A: 在配置类的required列表中添加字段名，或不设置default值

### Q: 如何隐藏某个字段？
A: 暂不支持，可以考虑移到高级配置组

### Q: 如何添加字段间的依赖关系？
A: 当前版本暂不支持，计划在后续版本添加

### Q: 如何自定义验证逻辑？
A: 使用Pydantic的validator装饰器

## 相关文档

- `CONFIG_UI_GUIDE.md` - 详细使用指南
- `NODE_CONFIG_COMPARISON.md` - 升级前后对比
- `schema_generator.py` - Schema生成器源码
