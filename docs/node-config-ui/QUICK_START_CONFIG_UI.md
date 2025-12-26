# 节点配置UI快速启动

## 查看效果

1. **启动后端**
   ```bash
   cd backend
   python app.py
   ```

2. **启动前端**
   ```bash
   cd frontend
   npm run dev
   ```

3. **访问节点系统**
   - 打开浏览器访问前端地址（通常是 http://localhost:5173）
   - 点击"节点系统"菜单
   - 选择任意节点类型（推荐选择 `llmjson_v2`）
   - 查看配置编辑器

## 对比

### 升级前
- 只有一个大的JSON文本框
- 需要手写JSON
- 容易出错
- 不知道有哪些配置项

### 升级后
- 智能表单，按分组展示
- 每个字段有专门的输入控件
- 实时验证
- 有字段说明和提示
- 支持表单视图和JSON视图切换

## 体验新功能

### 1. 查看分组
配置项按功能分组：
- API配置（api_key, base_url）
- 模板配置（template）
- 模型配置（model, temperature, max_tokens）
- 处理配置（chunk_size, include_tables）
- 高级配置（timeout, max_retries, encoding）

### 2. 使用智能控件
- **API密钥** - 密码输入框，自动隐藏
- **模板选择** - 下拉框，预设选项
- **模型选择** - 下拉框，常用模型
- **温度参数** - 数字输入器，范围0-1，步长0.1
- **处理表格** - 开关按钮
- **编码** - 下拉框，常用编码

### 3. 表单验证
- 必填字段会标记
- 数字范围自动限制
- 实时错误提示

### 4. 切换视图
- 点击右上角切换按钮
- 在表单视图和JSON视图之间切换
- 两个视图数据自动同步

## 为其他节点添加UI元数据

编辑节点的配置类（例如 `backend/nodes/your_node/config.py`）：

```python
from pydantic import Field
from nodes.base import NodeConfigBase

class YourNodeConfig(NodeConfigBase):
    # 添加 json_schema_extra 来配置UI
    your_field: str = Field(
        default="default_value",
        description="字段说明",
        json_schema_extra={
            'group': 'default',      # 分组
            'order': 1,              # 排序
            'placeholder': '提示文本'
        }
    )
```

## 常见问题

### Q: 为什么我的节点还是显示JSON编辑器？
A: 可能是：
1. 节点配置类没有添加UI元数据（会自动降级）
2. Schema生成失败（检查后端日志）
3. 前端API调用失败（检查浏览器控制台）

### Q: 如何自定义字段的UI控件？
A: 在Field的json_schema_extra中设置：
- `format`: 'password' | 'textarea' | 'json'
- `options`: 下拉选项列表
- `minimum/maximum`: 数字范围

### Q: 如何控制字段显示顺序？
A: 使用 `order` 字段，数字越小越靠前

### Q: 如何添加新的分组？
A: 在 `json_schema_extra` 中设置 `group` 为新的分组名

## 下一步

1. 查看 `backend/nodes/CONFIG_UI_GUIDE.md` 了解详细配置选项
2. 查看 `NODE_CONFIG_UI_UPGRADE.md` 了解完整的升级说明
3. 参考 `backend/nodes/llmjson_v2/config.py` 学习最佳实践
