# RAGSystem 快速参考

## 🚀 快速启动

```bash
# 启动后端
cd backend && python app.py

# 启动前端（新终端）
cd frontend && npm run dev

# 访问系统
http://localhost:5173
```

## 📚 文档快速链接

| 需求 | 文档 | 时间 |
|------|------|------|
| 了解项目 | [README.md](README.md) | 5分钟 |
| 查看结构 | [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) | 10分钟 |
| 快速上手节点配置 | [QUICK_START](docs/node-config-ui/QUICK_START_CONFIG_UI.md) | 5分钟 |
| 开发节点 | [CONFIG_UI_GUIDE](backend/nodes/CONFIG_UI_GUIDE.md) | 30分钟 |
| 查阅配置选项 | [UI_METADATA_REFERENCE](backend/nodes/UI_METADATA_REFERENCE.md) | 随时 |
| 浏览所有文档 | [文档中心](docs/README.md) | - |

## 🎯 常见任务

### 查看节点配置UI
1. 启动服务
2. 访问 http://localhost:5173
3. 点击"节点系统"
4. 选择节点类型

### 为节点添加UI元数据
```python
from pydantic import Field
from nodes.base import NodeConfigBase

class MyConfig(NodeConfigBase):
    field: str = Field(
        default="",
        description="说明",
        json_schema_extra={
            'group': 'api',
            'format': 'password'
        }
    )
```

### 测试节点配置
```bash
cd backend
python test_all_node_configs.py
```

## 📁 重要文件位置

### 后端
- 节点基类: `backend/nodes/base.py`
- Schema生成器: `backend/nodes/schema_generator.py`
- 节点API: `backend/routes/nodes.py`
- 配置示例: `backend/nodes/llmjson_v2/config.py`

### 前端
- 配置编辑器: `frontend/src/components/workflow/NodeConfigEditor.vue`
- 节点视图: `frontend/src/views/NodesView.vue`
- API服务: `frontend/src/api/nodeService.js`

### 文档
- 文档中心: `docs/README.md`
- 节点配置UI: `docs/node-config-ui/README.md`
- 开发指南: `backend/nodes/CONFIG_UI_GUIDE.md`

## 🔧 配置选项速查

### 通用选项
```python
json_schema_extra={
    'group': 'api',              # 分组
    'order': 1,                  # 排序
    'format': 'password',        # 格式
    'placeholder': '提示文本'     # 占位符
}
```

### 下拉选择
```python
json_schema_extra={
    'options': [
        {'label': '显示名', 'value': '值'}
    ]
}
```

### 数字范围
```python
json_schema_extra={
    'minimum': 0,
    'maximum': 100,
    'multipleOf': 10
}
```

## 🎨 预定义分组

| 分组 | 用途 | 排序 |
|------|------|------|
| `default` | 基础配置 | 0 |
| `api` | API配置 | 1 |
| `database` | 数据库配置 | 1 |
| `model` | 模型配置 | 2 |
| `template` | 模板配置 | 3 |
| `processing` | 处理配置 | 4 |
| `metadata` | 元数据配置 | 5 |
| `output` | 输出设置 | 6 |
| `advanced` | 高级配置 | 7 |

## 🐛 故障排除

### 节点显示JSON编辑器
- 检查后端日志
- 运行测试脚本
- 查看浏览器控制台

### 字段显示不正确
- 检查 `json_schema_extra` 配置
- 参考 UI_METADATA_REFERENCE.md
- 查看示例配置

### 验证失败
- 查看错误提示
- 检查必填字段
- 确认数值范围

## 📞 获取帮助

1. **查看文档** - [文档中心](docs/README.md)
2. **运行测试** - `python test_all_node_configs.py`
3. **查看示例** - `backend/nodes/llmjson_v2/config.py`

## 🎉 已适配节点

- ✅ LLMJson V2 (11字段, 5分组)
- ✅ LLMJson (15字段, 5分组)
- ✅ Json2Graph (6字段, 3分组)
- ✅ VectorIndexer (8字段, 4分组)

---

**版本**: v1.0  
**更新**: 2025-12-26  

💡 **保存此页面，快速查阅常用信息！**
