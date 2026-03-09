# UI 元数据参考

## 最小示例

```python
name: str = Field(
    default="",
    description="名称",
    json_schema_extra={
        "group": "default",
        "order": 1,
        "placeholder": "请输入名称",
    },
)
```

## 常用键

| 键 | 用途 |
|---|---|
| `group` | 分组名 |
| `groupLabel` | 分组显示名 |
| `order` | 排序 |
| `format` | 控件类型 |
| `placeholder` | 占位文本 |
| `options` | 下拉选项 |
| `rows` | 多行文本行数 |
| `minimum` / `maximum` / `multipleOf` | 数值约束 |
| `minLength` / `maxLength` / `pattern` | 字符串约束 |
| `file_extensions` | 文件选择器允许的扩展名 |
| `mime_types` | 文件选择器允许的 MIME |
| `multiple` | 文件选择器多选 |

## 常用 `format`

| format | 说明 |
|---|---|
| `password` | 密码输入 |
| `textarea` | 多行文本 |
| `json` | JSON 编辑 |
| `file_selector` | 文件选择 |
| `string` / `number` / `integer` / `boolean` | 默认基础控件 |
| `llm_config` | 当前节点系统中用于 LLM 选择器的自定义格式 |

## 常用分组

| group | 典型用途 |
|---|---|
| `default` | 基础字段 |
| `api` | 密钥、URL |
| `database` | 数据库连接 |
| `model` | 模型参数 |
| `template` | 模板或提示词 |
| `processing` | 处理参数 |
| `metadata` | 元数据 |
| `output` | 输出行为 |
| `advanced` | 高级项 |

## 推断规则

`schema_generator.py` 当前会：

- 根据字段名里的 `api`、`key`、`url` 推断 `api`
- 根据 `database`、`db`、`neo4j` 推断 `database`
- 根据 `model`、`temperature`、`token` 推断 `model`
- 根据 `password`、`secret`、`key` 推断 `password`
- 对 `dict` / `list` 推断 `json`
- 对带 `file`、`document`、`upload` 的字段推断 `file_selector`

## 注意

- 最终校验以后端 Pydantic 模型为准
- Schema 负责前端渲染，不替代业务校验
