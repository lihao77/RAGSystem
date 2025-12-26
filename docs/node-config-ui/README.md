# 节点配置UI升级文档

## 📚 文档导航

### 快速开始
- **[快速启动指南](QUICK_START_CONFIG_UI.md)** - 5分钟快速上手，查看效果
- **[升级总结](NODE_CONFIG_SUMMARY.md)** - 了解升级全貌和成果

### 用户指南
- **[升级前后对比](NODE_CONFIG_COMPARISON.md)** - 详细对比升级前后的差异
- **[更新日志](NODE_CONFIG_CHANGELOG.md)** - 查看所有更新内容

### 开发指南
- **[完整升级说明](NODE_CONFIG_UI_UPGRADE.md)** - 技术实现细节和架构说明
- **[检查清单](NODE_CONFIG_CHECKLIST.md)** - 完整的任务检查清单

### 后端开发
- **[配置UI使用指南](../../backend/nodes/CONFIG_UI_GUIDE.md)** - 详细的使用指南
- **[UI元数据快速参考](../../backend/nodes/UI_METADATA_REFERENCE.md)** - 快速参考卡片

## 🎯 这是什么？

这是一个将节点系统配置界面从简陋的JSON文本框升级为专业智能表单系统的完整解决方案。

## ✨ 主要特性

- **智能表单生成** - 根据配置类型自动选择合适的UI控件
- **字段分组** - 配置项按功能自动分组展示
- **实时验证** - 输入时立即验证，提供友好的错误提示
- **双视图模式** - 表单视图 + JSON视图，满足不同需求
- **自动推断** - 即使不配置UI元数据，系统也能自动推断
- **向后兼容** - 100%向后兼容，平滑升级

## 📊 升级成果

- ✅ **4个节点**完成适配
- ✅ **40+个配置字段**获得友好UI
- ✅ **6种智能控件**覆盖各种需求
- ✅ **9个功能分组**结构清晰
- ✅ **100%向后兼容**平滑升级

## 🚀 快速开始

### 1. 查看效果（5分钟）

```bash
# 启动后端
cd backend
python app.py

# 启动前端（新终端）
cd frontend
npm run dev

# 访问浏览器
# 打开 http://localhost:5173
# 点击"节点系统"菜单
# 选择任意节点类型（推荐 llmjson_v2）
```

### 2. 为新节点添加UI元数据

```python
from pydantic import Field
from nodes.base import NodeConfigBase

class MyNodeConfig(NodeConfigBase):
    api_key: str = Field(
        default="",
        description="API密钥",
        json_schema_extra={
            'group': 'api',
            'format': 'password'
        }
    )
```

## 📦 已适配的节点

| 节点 | 字段数 | 分组数 | 特色功能 |
|------|--------|--------|----------|
| **LLMJson V2** | 11 | 5 | 模板选择、模型下拉 |
| **LLMJson** | 15 | 5 | 并行处理、输出配置 |
| **Json2Graph** | 6 | 3 | Neo4j连接、存储模式 |
| **VectorIndexer** | 8 | 4 | 文档类型、语言选择 |

## 🎨 支持的控件类型

1. **文本输入框** - 普通字符串
2. **密码输入框** - API密钥等敏感信息
3. **多行文本框** - 长文本内容
4. **数字输入器** - 数值参数（支持范围和步长）
5. **开关按钮** - 布尔值
6. **下拉选择框** - 有限选项
7. **JSON编辑器** - 复杂对象/数组

## 📁 文档结构

```
docs/node-config-ui/
├── README.md                      # 本文件 - 文档导航
├── QUICK_START_CONFIG_UI.md       # 快速启动指南
├── NODE_CONFIG_SUMMARY.md         # 升级总结
├── NODE_CONFIG_UI_UPGRADE.md      # 完整升级说明
├── NODE_CONFIG_COMPARISON.md      # 升级前后对比
├── NODE_CONFIG_CHANGELOG.md       # 更新日志
└── NODE_CONFIG_CHECKLIST.md       # 检查清单

backend/nodes/
├── CONFIG_UI_GUIDE.md             # 详细使用指南
└── UI_METADATA_REFERENCE.md       # 快速参考卡片
```

## 🔧 核心文件

### 后端
- `backend/nodes/schema_generator.py` - Schema生成器
- `backend/nodes/base.py` - 节点基类（添加了get_config_schema方法）
- `backend/routes/nodes.py` - API路由（添加了config-schema端点）

### 前端
- `frontend/src/components/workflow/NodeConfigEditor.vue` - 配置编辑器组件
- `frontend/src/views/NodesView.vue` - 节点视图（集成了新编辑器）
- `frontend/src/api/nodeService.js` - API服务（添加了getConfigSchema方法）

### 配置示例
- `backend/nodes/llmjson_v2/config.py` - LLMJson V2配置
- `backend/nodes/llmjson/config.py` - LLMJson配置
- `backend/nodes/json2graph/config.py` - Json2Graph配置
- `backend/nodes/vector_indexer/config.py` - VectorIndexer配置

## 🧪 测试

```bash
cd backend

# 测试单个节点
python test_schema_simple.py

# 测试所有节点
python test_all_node_configs.py
```

## 💡 使用建议

### 对于用户
1. 新手使用表单视图，直观易用
2. 专家可切换到JSON视图精确控制
3. 注意必填字段的标记
4. 鼠标悬停在❓图标查看字段说明

### 对于开发者
1. 在Field中添加`json_schema_extra`配置UI
2. 使用预定义的分组名称
3. 为数字字段设置合理的范围
4. 为选项字段提供options列表
5. 参考已适配节点的配置

## 🐛 故障排除

### 问题：节点还是显示JSON编辑器
**解决：**
1. 检查后端日志
2. 检查浏览器控制台
3. 运行测试脚本验证

### 问题：字段显示不正确
**解决：**
1. 检查json_schema_extra配置
2. 参考UI_METADATA_REFERENCE.md
3. 查看示例节点配置

## 📞 获取帮助

1. **查看文档** - 先查看相关文档
2. **运行测试** - 运行测试脚本验证
3. **检查日志** - 查看后端日志和浏览器控制台
4. **参考示例** - 查看已适配节点的配置

## 🎉 开始使用

现在就开始体验新的节点配置界面吧！

```bash
# 启动服务
cd backend && python app.py

# 访问浏览器
# http://localhost:5173
# 点击"节点系统"
# 选择节点类型
# 享受全新的配置体验！
```

---

**版本**: v1.0  
**更新时间**: 2025-12-26  
**兼容性**: 100%向后兼容  
**文档完整度**: 100%  

🚀 **开始使用新的节点配置UI吧！**
