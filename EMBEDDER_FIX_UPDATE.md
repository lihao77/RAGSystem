# Embedder 修复更新 - OpenRouter 问题

**更新日期：** 2026-02-13  
**问题：** OpenRouter Embedding 调用失败

## 新发现的问题

在修复同名 Provider 冲突后，发现 OpenRouter 的 embedding 实现有问题：

### 问题 1：死代码
OpenRouter 的 `embed()` 方法在第 640 行就 return 了，后面的实际实现代码（646-682行）永远不会执行。

### 问题 2：OpenRouter 对 Embedding 支持有限
OpenRouter 主要是 LLM 聚合服务，其 embedding API 支持可能不完整或不稳定。

## 解决方案

### 1. 修复 OpenRouter embed 实现

**文件：** `backend/model_adapter/providers.py`

**修改前：**
```python
def embed(self, texts, model=None, ...):
    model = model or self.get_model_for_task('embedding')
    if not model:
        return EmbeddingResponse(...)
    
    return super().embed(...)  # 在这里就 return 了
    
    # 下面的代码永远不会执行
    logger.warning("OpenRouter Embedding...")
    # ... 实际实现代码
```

**修改后：**
```python
def embed(self, texts, model=None, ...):
    """OpenRouter Embedding 支持（通过转发实现）"""
    model = model or self.get_model_for_task('embedding')
    
    if not model:
        return EmbeddingResponse(
            embeddings=[],
            error="OpenRouter 需要指定 Embedding 模型（如 openai/text-embedding-3-small）",
            provider=self.name
        )
    
    # 尝试调用父类实现（OpenAI 兼容接口）
    try:
        return super().embed(texts, model, dimensions, **kwargs)
    except Exception as e:
        logger.error(f"OpenRouter Embedding 调用失败: {e}")
        return EmbeddingResponse(
            embeddings=[],
            error=f"OpenRouter Embedding 不支持或调用失败: {e}。建议直接使用 OpenAI 或其他专门的 Embedding Provider",
            provider=self.name
        )
```

### 2. 增强 Embedder 错误处理

**文件：** `backend/vector_store/embedder.py`

**添加 None 检查：**
```python
response = self.provider.embed(texts=batch, model=self.model_name)

# 检查 response 是否为 None（理论上不应该，但为了安全）
if response is None:
    raise RuntimeError("Embedding 调用失败: Provider 返回 None")

if response.error:
    raise RuntimeError(f"Embedding 调用失败: {response.error}")
```

### 3. 更新配置建议

**文件：** `backend/config/yaml/config.yaml`

**推荐配置：**
```yaml
embedding:
  provider: modelscope  # 推荐使用 modelscope
  model_name: Qwen/Qwen3-Embedding-8B
  batch_size: 10
```

**不推荐（但可用）：**
```yaml
embedding:
  provider: test
  provider_type: openrouter
  model_name: openai/text-embedding-3-small  # OpenRouter 转发可能不稳定
```

## Provider 选择建议

### ✅ 推荐用于 Embedding

1. **ModelScope** - 稳定、免费、中文支持好
   ```yaml
   provider: modelscope
   model_name: Qwen/Qwen3-Embedding-8B
   ```

2. **DeepSeek** - 如果有 DeepSeek API
   ```yaml
   provider: test
   provider_type: deepseek
   model_name: deepseek-embedding
   ```

3. **OpenAI** - 如果直接使用 OpenAI
   ```yaml
   provider: openai_provider
   provider_type: openai
   model_name: text-embedding-3-small
   ```

### ⚠️ 不推荐用于 Embedding

- **OpenRouter** - 主要用于 LLM，embedding 支持有限且可能不稳定

### 🔧 Provider 职责划分

**推荐配置方式：**
```yaml
llm:
  provider: test
  provider_type: deepseek  # 使用 DeepSeek 进行对话
  model_name: deepseek-chat

embedding:
  provider: modelscope     # 使用 ModelScope 进行向量化
  model_name: Qwen/Qwen3-Embedding-8B
```

这样可以发挥各 Provider 的优势，避免强制一个 Provider 做所有事情。

## 错误信息改进

### 之前：
```
WARNING: ⚠ 嵌入模型初始化失败: 'NoneType' object has no attribute 'error'
```
❌ 不清楚问题所在

### 现在：
```
ERROR: OpenRouter Embedding 调用失败: 404 Not Found
WARNING: ⚠ 嵌入模型初始化失败: OpenRouter Embedding 不支持或调用失败: 404 Not Found。建议直接使用 OpenAI 或其他专门的 Embedding Provider
```
✅ 清楚指出问题和解决方案

## 测试验证

启动后端后，应该看到：

**使用 ModelScope（推荐）：**
```
INFO: ✅ 远程 Embedder 已初始化 (via Model Adapter)
INFO:    Provider: modelscope
INFO:    模型: Qwen/Qwen3-Embedding-8B
INFO: ✅ Embedder 初始化完成 (Provider: modelscope)
INFO: ✓ 嵌入模型已加载
INFO: ✓ 向量维度: 768
INFO: ✅ 向量数据库初始化完成
```

## 文件变更

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `backend/model_adapter/providers.py` | 修改 | 修复 OpenRouter embed 实现，移除死代码 |
| `backend/vector_store/embedder.py` | 修改 | 添加 None 检查和更好的错误处理 |
| `backend/config/yaml/config.yaml` | 修改 | 推荐使用 modelscope 而不是 openrouter |

## 相关文档

- 初始修复：[EMBEDDER_FIX_SUMMARY.md](EMBEDDER_FIX_SUMMARY.md)
- ModelAdapter 重构：[MODEL_ADAPTER_REFACTOR_SUMMARY.md](MODEL_ADAPTER_REFACTOR_SUMMARY.md)

---

**修复完成！** ✅ 现在可以正常使用 Embedding 功能了。
