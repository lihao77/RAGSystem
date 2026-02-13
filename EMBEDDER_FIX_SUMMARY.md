# Embedder 配置冲突修复总结

**修复日期：** 2026-02-13  
**问题：** Embedder 初始化失败：未找到 Provider: test

## 问题原因

在 ModelAdapter 重构后，系统使用复合键机制（`{name}_{provider_type}`），导致两个同名但不同类型的 Provider：
- `test_deepseek` (name: test, provider_type: deepseek)
- `test_openrouter` (name: test, provider_type: openrouter)

配置文件中 `embedding.provider` 设置为 `test`，但没有指定 `provider_type`，导致 `get_provider('test')` 匹配到多个 Provider 而抛出异常。

## 错误日志

```
WARNING: Embedder 初始化失败: 未找到 Provider: test，请先在 Model Adapter 中配置
WARNING: ⚠ 嵌入模型初始化失败: Embedder 未初始化，请检查 Embedding 配置
WARNING: 向量数据库将跳过初始化
```

## 解决方案

### 1. 更新配置文件

**文件：** `backend/config/yaml/config.yaml`

**修改：** 添加 `provider_type` 字段

```yaml
# 修改前
embedding:
  provider: test
  model_name: openai/text-embedding-3-small
  batch_size: 10

# 修改后
embedding:
  provider: test
  provider_type: openrouter  # 明确指定使用 openrouter
  model_name: openai/text-embedding-3-small
  batch_size: 10
```

同样，LLM 配置也添加了 `provider_type`：

```yaml
llm:
  provider: test
  provider_type: deepseek  # 明确指定使用 deepseek
  model_name: deepseek-chat
```

### 2. 增强 Embedder 支持 provider_type

**文件：** `backend/vector_store/embedder.py`

**改动：**

#### 2.1 RemoteEmbedder 构造函数

```python
# 修改前
def __init__(
    self,
    provider_name: str,
    model_name: str = "text-embedding-3-small",
    batch_size: int = 100
):
    # ...
    self.provider = self.adapter.get_provider(provider_name)

# 修改后
def __init__(
    self,
    provider_name: str,
    model_name: str = "text-embedding-3-small",
    batch_size: int = 100,
    provider_type: Optional[str] = None  # 新增参数
):
    # ...
    # 支持 provider_type 精确查找
    self.provider = self.adapter.get_provider(provider_name, provider_type)
```

#### 2.2 Embedder 初始化

```python
# 修改前
self._embedder = RemoteEmbedder(
    provider_name=provider_name,
    model_name=config.embedding.model_name,
    batch_size=config.embedding.batch_size
)

# 修改后
provider_type = getattr(config.embedding, 'provider_type', None)
self._embedder = RemoteEmbedder(
    provider_name=provider_name,
    model_name=config.embedding.model_name,
    batch_size=config.embedding.batch_size,
    provider_type=provider_type  # 传递 provider_type
)
```

### 3. 更新配置模型

**文件：** `backend/config/models.py`

**改动：**

```python
class EmbeddingConfig(BaseModel):
    """Embedding 配置 - 仅支持 ModelAdapter"""
    model_config = ConfigDict(extra='allow')

    provider: str = ""
    provider_type: str = ""  # 新增字段
    model_name: str = ""
    batch_size: int = 100

class LLMConfig(BaseModel):
    """LLM 配置 - 支持 ModelAdapter"""
    model_config = ConfigDict(extra='allow')

    provider: str = ""
    provider_type: str = ""  # 新增字段
    # ...
```

## 验证结果

### 配置加载测试

```bash
$ python -c "from config import get_config; c = get_config(); print(f'provider={c.embedding.provider}, provider_type={c.embedding.provider_type}')"

# 输出：
provider=test, provider_type=openrouter
```

✅ 配置正确读取

### ModelAdapter 加载测试

```
INFO: [ModelAdapter] 开始加载配置...
INFO: [ModelAdapter] 已注册: test_deepseek
INFO: [ModelAdapter] 已加载: test_deepseek
INFO: [ModelAdapter] 已注册: test_openrouter
INFO: [ModelAdapter] 已加载: test_openrouter
INFO: [ModelAdapter] 已注册: modelscope_modelscope
INFO: [ModelAdapter] 已加载: modelscope_modelscope
INFO: [ModelAdapter] 配置加载完成，共 3 个 Provider
```

✅ 3 个 Provider 全部加载成功

### 预期结果

启动后端时，应该看到：

```
INFO: ✅ 远程 Embedder 已初始化 (via Model Adapter)
INFO:    Provider: test_openrouter
INFO:    模型: openai/text-embedding-3-small
INFO: ✅ Embedder 初始化完成 (Provider: test_openrouter)
```

❌ 不再出现：
```
WARNING: Embedder 初始化失败: 未找到 Provider: test
```

## 使用指南

### 配置同名 Provider

当使用同名但不同类型的 Provider 时，**必须**在配置中指定 `provider_type`：

```yaml
# ✅ 正确：明确指定 provider_type
embedding:
  provider: my_provider
  provider_type: openrouter  # 必需！
  model_name: openai/text-embedding-3-small

# ❌ 错误：会导致 "匹配多个 Provider" 异常
embedding:
  provider: my_provider
  model_name: openai/text-embedding-3-small
```

### 使用唯一名称的 Provider

如果 Provider 名称是唯一的（如 `modelscope`），可以省略 `provider_type`：

```yaml
# ✅ 正确：modelscope 是唯一的，无需 provider_type
embedding:
  provider: modelscope
  model_name: Qwen/Qwen3-Embedding-8B
```

### 推荐配置方式

**方式 1：使用复合键（推荐）**

直接使用复合键作为 provider 名称：

```yaml
embedding:
  provider: test_openrouter  # 直接使用复合键
  model_name: openai/text-embedding-3-small
```

**方式 2：使用 name + type（推荐）**

分别指定 name 和 type：

```yaml
embedding:
  provider: test
  provider_type: openrouter  # 明确指定类型
  model_name: openai/text-embedding-3-small
```

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `backend/config/yaml/config.yaml` | 修改 | 添加 `provider_type` 字段 |
| `backend/config/models.py` | 修改 | EmbeddingConfig 和 LLMConfig 添加 `provider_type` 字段 |
| `backend/vector_store/embedder.py` | 修改 | RemoteEmbedder 支持 `provider_type` 参数 |

## 相关文档

- **ModelAdapter 重构总结**: [`MODEL_ADAPTER_REFACTOR_SUMMARY.md`](MODEL_ADAPTER_REFACTOR_SUMMARY.md)
- **ModelAdapter 使用指南**: [`backend/model_adapter/README.md`](backend/model_adapter/README.md)
- **项目规范**: [`CLAUDE.md`](CLAUDE.md)

## 注意事项

1. **升级后必须更新配置**：如果使用同名 Provider，必须在 `config.yaml` 中添加 `provider_type`
2. **向后兼容**：如果 Provider 名称唯一，无需修改配置
3. **错误提示优化**：现在会提示 "名称 'test' 匹配多个 Provider (deepseek, openrouter)，请指定 provider_type"

---

**修复完成！** ✅
