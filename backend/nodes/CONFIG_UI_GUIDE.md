# 节点配置 UI 指南

节点系统通过 Pydantic 配置模型生成前端表单 Schema。管理端节点页面消费这个 Schema 渲染配置表单。

## 工作方式

1. 节点在 `config.py` 中定义配置模型
2. 模型继承 `NodeConfigBase`
3. `schema_generator.py` 读取字段定义和 `json_schema_extra`
4. 前端通过 `GET /api/nodes/types/<node_type>/config-schema` 获取增强 Schema

## 推荐写法

```python
from pydantic import Field
from nodes.base import NodeConfigBase


class ExampleConfig(NodeConfigBase):
    api_key: str = Field(
        default="",
        description="API 密钥",
        json_schema_extra={
            "group": "api",
            "order": 1,
            "format": "password",
            "placeholder": "请输入 API 密钥",
        },
    )

    model: str = Field(
        default="deepseek-chat",
        description="模型名称",
        json_schema_extra={
            "group": "model",
            "order": 1,
            "options": [
                {"label": "DeepSeek Chat", "value": "deepseek-chat"},
            ],
        },
    )
```

## 常用元数据

- `group`：字段分组
- `groupLabel`：分组显示名称
- `order`：组内排序
- `format`：控件类型，如 `password`、`textarea`、`json`、`file_selector`
- `placeholder`：占位文本
- `options`：下拉项
- `minimum` / `maximum` / `multipleOf`
- `minLength` / `maxLength` / `pattern`

## 自动推断

如果没有显式元数据，`schema_generator.py` 会根据字段名和类型推断：

- 分组：`api`、`database`、`model`、`processing`、`advanced`
- 控件：`password`、`textarea`、`json`、`file_selector`

建议：

- 核心字段显式声明 `group` 和 `order`
- 有限枚举值优先使用 `options`
- 数字字段补充范围

## 验证

页面验证：

1. 启动后端和 `frontend/`
2. 打开 `http://localhost:8080/nodes`
3. 选择节点类型

接口验证：

```text
GET /api/nodes/types/<node_type>/config-schema
```

测试验证：

```powershell
cd backend
python -m pytest tests\config_schema_test.py
```

## 参考节点

- `llmjson/config.py`
- `llmjson_v2/config.py`
- `json2graph/config.py`
- `vector_indexer/config.py`
