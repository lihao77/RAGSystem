# 配置保存问题修复说明

## 问题描述
前端 ModelAdapter 配置界面中，新增的 `max_completion_tokens` 和 `max_context_tokens` 字段无法保存。

## 根本原因
后端 API 路由 `backend/routes/model_adapter.py` 中的 `update_provider` 函数，在 `allowed_fields` 列表中缺少新字段。

## 修复内容

### 1. 后端 API 路由修复

**文件**: `backend/routes/model_adapter.py`

**修改位置**: 第 164-169 行

**修改前**:
```python
allowed_fields = [
    'models', 'temperature', 'max_tokens', 'timeout',
    'retry_attempts', 'retry_delay', 'supports_function_calling',
    'model_map', 'api_endpoint'
]
```

**修改后**:
```python
allowed_fields = [
    'models', 'temperature', 'max_tokens', 'max_completion_tokens', 'max_context_tokens',
    'timeout', 'retry_attempts', 'retry_delay', 'supports_function_calling',
    'model_map', 'api_endpoint'
]
```

### 2. 前端自动同步逻辑

**文件**: `frontend/src/views/ModelAdapterView.vue`

**新增**: 添加 `watch` 监听器，自动同步 `max_completion_tokens` 到 `max_tokens`（向后兼容）

```javascript
// 监听 max_completion_tokens 变化，自动同步到 max_tokens（向后兼容）
watch(() => formData.value.max_completion_tokens, (newValue) => {
  if (newValue) {
    formData.value.max_tokens = newValue
  }
})
```

## 验证步骤

### 1. 重启后端
```bash
cd backend
python app.py
```

### 2. 测试 ModelAdapter 配置保存

1. 访问前端：`http://localhost:5173/model-adapter`
2. 编辑任意 Provider
3. 修改以下字段：
   - **输出Token限制**: 设置为 `8192`
   - **上下文窗口**: 设置为 `200000`
4. 点击"确定"保存
5. 刷新页面，检查配置是否保存成功

### 3. 验证配置文件

检查 `backend/model_adapter/configs/providers.yaml`：

```yaml
test_deepseek:
  name: test
  provider_type: deepseek
  max_completion_tokens: 8192    # ✓ 应该保存成功
  max_context_tokens: 200000     # ✓ 应该保存成功
  max_tokens: 8192               # ✓ 自动同步
```

### 4. 测试 Agent 配置保存

1. 访问：`http://localhost:5173/agent-config`
2. 编辑任意 Agent
3. 在 LLM 配置中修改：
   - **输出Token限制**: `4096`
   - **上下文窗口**: `128000`
4. 保存并刷新，验证配置是否保存

### 5. 运行自动化测试

```bash
cd backend
python test_provider_save.py
```

预期输出：
```
✓ max_completion_tokens 正确
✓ max_context_tokens 正确
✓ null 值保存正确
✅ 测试完成
```

## 常见问题

### Q1: 保存后刷新页面，配置丢失？

**A**: 检查浏览器控制台是否有错误。可能是：
1. 后端未重启
2. YAML 文件权限问题
3. 配置文件格式错误

### Q2: 上下文窗口显示"未配置"？

**A**: 这是正常的。如果 `max_context_tokens` 为 `null`，会显示"未配置"。Agent 会使用兜底逻辑计算上下文预算。

### Q3: 旧的 max_tokens 字段还能用吗？

**A**: 可以。系统完全向后兼容：
- 前端会自动将 `max_completion_tokens` 同步到 `max_tokens`
- 后端会优先使用 `max_completion_tokens`，如果没有则使用 `max_tokens`

### Q4: 如何验证 Agent 是否使用了新配置？

**A**: 查看 Agent 启动日志：
```
ReActAgent 'qa_agent' 初始化完成，
模型输出限制: 4096 tokens,
上下文窗口: 128000,
上下文预算: 109104 tokens
```

## 技术细节

### 配置保存流程

```
前端表单
  ↓ (formData.max_completion_tokens, max_context_tokens)
前端 API 调用 (modelAdapterService.updateProvider)
  ↓ (PUT /api/model-adapter/providers/<key>)
后端路由 (model_adapter.py:update_provider)
  ↓ (检查 allowed_fields)
ConfigStore (config_store.py:save_provider)
  ↓ (YAML 序列化)
providers.yaml 文件
```

### 配置加载流程

```
providers.yaml 文件
  ↓ (YAML 反序列化)
ConfigStore (config_store.py:load_all)
  ↓
ModelAdapter (adapter.py:_load_saved_configs)
  ↓
AIProvider (base.py:__init__)
  ↓ (self.max_completion_tokens, self.max_context_tokens)
Agent (通过 get_llm_config 获取)
```

## 相关文件

- `backend/routes/model_adapter.py` - API 路由（已修复）
- `backend/model_adapter/base.py` - Provider 基类
- `backend/model_adapter/config_store.py` - 配置存储
- `frontend/src/views/ModelAdapterView.vue` - 前端配置界面
- `frontend/src/components/LLMConfigSelector.vue` - LLM 配置选择器

## 更新日志

- **2026-02-24 18:00**: 修复 `allowed_fields` 缺少新字段的问题
- **2026-02-24 18:10**: 添加前端自动同步逻辑
- **2026-02-24 18:15**: 创建测试脚本验证保存功能
