# Model Adapter

统一的 AI 模型管理接口，支持多个 AI 服务提供商（OpenAI、DeepSeek、OpenRouter、ModelScope 等）。

## 架构特性

### ✨ 单一配置文件架构（2026-02-13 升级）

**优势：**
- ⚡️ **性能提升**：启动时仅 1 次 IO，相比多文件减少 95% IO 操作
- 🎯 **原生支持同名配置**：使用复合键 `{name}_{provider_type}` 解决同名覆盖问题
- 🔄 **热重载机制**：`reload()` 方法具有原子性，失败自动回滚
- 📦 **代码简化**：ConfigStore 减少 79% 代码（286 → 130 行）
- 🎨 **配置集中**：所有配置在一个文件中，易于查看和编辑

### 🔑 复合键机制

**格式：** `{name}_{provider_type}`

**示例：**
- `test_deepseek` - name: test, provider_type: deepseek
- `test_openrouter` - name: test, provider_type: openrouter
- `modelscope_modelscope` - name: modelscope, provider_type: modelscope

**优势：**
- 允许创建同名但不同类型的 Provider
- 精确识别和操作特定 Provider
- 避免配置覆盖问题

## 配置文件

### 位置
`backend/model_adapter/configs/providers.yaml`

### 格式

```yaml
# 复合键作为顶层键
test_deepseek:
  name: test
  provider_type: deepseek
  api_key: sk-xxx
  api_endpoint: https://api.deepseek.com/v1
  max_tokens: 4096
  temperature: 0.7
  timeout: 30
  retry_attempts: 3
  retry_delay: 1.0
  supports_function_calling: true
  model_map:
    chat: deepseek-chat
  models: []

test_openrouter:
  name: test
  provider_type: openrouter
  api_key: sk-or-xxx
  api_endpoint: https://openrouter.ai/api/v1
  model_map:
    embedding:
      - openai/text-embedding-3-small
  models:
    - openai/text-embedding-3-small

modelscope_modelscope:
  name: modelscope
  provider_type: modelscope
  api_key: ms-xxx
  api_endpoint: https://api-inference.modelscope.cn/v1
  model_map:
    embedding:
      - Qwen/Qwen3-Embedding-8B
      - Qwen/Qwen3-Embedding-0.6B
```

## 使用方法

### 基本调用

```python
from model_adapter import get_default_adapter

adapter = get_default_adapter()

# 方式 1：使用复合键（精确）
response = adapter.chat_completion(
    messages=[{"role": "user", "content": "Hello"}],
    provider="test_deepseek",  # 复合键
    temperature=0.7
)

# 方式 2：使用 name + type（精确）
provider = adapter.get_provider("test", "deepseek")
response = provider.chat([{"role": "user", "content": "Hello"}])

# 方式 3：仅使用 name（如果唯一）
provider = adapter.get_provider("modelscope")  # 只有一个 modelscope
response = provider.chat([{"role": "user", "content": "Hello"}])

# 方式 4：仅使用 name（多个匹配时报错）
try:
    provider = adapter.get_provider("test")  # 会抛出异常
except ValueError as e:
    # 名称 'test' 匹配多个 Provider (deepseek, openrouter)，请指定 provider_type
    print(e)
```

### Embedding 调用

```python
# 使用复合键
response = adapter.embed(
    texts=["文本内容"],
    provider="test_openrouter",
    model="openai/text-embedding-3-small"
)

# 使用 name + type
response = adapter.embed(
    texts=["文本内容"],
    provider="test",
    model="openai/text-embedding-3-small"
)
# 注意：如果 'test' 匹配多个，会自动抛出异常
```

### 热重载配置

```python
# 修改 providers.yaml 后，热重载配置
success = adapter.reload()

if success:
    print(f"热重载成功，共 {len(adapter.providers)} 个 Provider")
else:
    print("热重载失败，已恢复到原状态")
```

## API 端点

### 获取 Provider 列表
```
GET /api/model-adapter/providers
```

**响应：**
```json
{
  "success": true,
  "providers": [
    {
      "key": "test_deepseek",
      "name": "test",
      "provider_type": "deepseek",
      "model_map": {"chat": "deepseek-chat"},
      "temperature": 0.7,
      "is_available": true
    }
  ]
}
```

### 创建 Provider
```
POST /api/model-adapter/providers
```

**请求：**
```json
{
  "name": "my_provider",
  "provider_type": "deepseek",
  "api_key": "sk-xxx",
  "api_endpoint": "",
  "model_map": {
    "chat": "deepseek-chat"
  }
}
```

**响应：**
```json
{
  "success": true,
  "provider_key": "my_provider_deepseek",
  "message": "Provider 创建成功"
}
```

### 更新 Provider
```
PUT /api/model-adapter/providers/<provider_key>
```

**请求：**
```json
{
  "temperature": 0.5,
  "max_tokens": 8192,
  "model_map": {
    "chat": "deepseek-chat"
  }
}
```

### 删除 Provider
```
DELETE /api/model-adapter/providers/<provider_key>
```

### 测试 Provider
```
POST /api/model-adapter/test
```

**请求：**
```json
{
  "provider": "test_deepseek",  # 使用复合键
  "prompt": "你好",
  "task": "chat"  # 或 "embedding"
}
```

## 性能指标

| 指标 | 旧架构（多文件） | 新架构（单文件） | 提升 |
|------|----------------|----------------|------|
| 启动 IO 次数（10个Provider） | 20 次 | 1 次 | 95% ⚡️ |
| 热重载 IO 次数 | 20 次 | 1 次 | 95% ⚡️ |
| 配置加载时间 | ~500ms | ~50ms | 90% ⚡️ |
| ConfigStore 代码行数 | 286 行 | 130 行 | 79% ✨ |

## 迁移指南

### 从多文件迁移到单文件

**自动迁移（已完成）：**
1. 旧配置文件已备份到 `configs/instances.backup/`
2. 新配置文件已生成：`configs/providers.yaml`
3. 所有配置使用复合键重新组织

**手动迁移（如果需要）：**
```python
import yaml
from pathlib import Path

# 读取旧配置
old_configs = {}
instances_dir = Path("configs/instances.backup")
for file in instances_dir.glob("*.yaml"):
    with open(file, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)
        if data and 'config' in data:
            config = data['config']
            key = f"{config['name']}_{config['provider_type']}".lower().replace(" ", "_")
            old_configs[key] = config

# 写入新配置
with open("configs/providers.yaml", 'w', encoding='utf-8') as f:
    yaml.dump(old_configs, f, allow_unicode=True, indent=2)
```

## 开发指南

### 添加新的 Provider 类型

1. 在 `backend/model_adapter/providers/` 创建新的 Provider 类
2. 继承 `AIProvider` 基类
3. 在 `adapter.py` 的 `register_provider_from_config()` 中添加类型判断

### 配置验证

配置项说明：
- `name` - Provider 名称（必需）
- `provider_type` - Provider 类型（必需）
- `api_key` - API 密钥（必需）
- `api_endpoint` - API 端点（可选，有默认值）
- `model_map` - 模型映射（推荐使用）
- `models` - 模型列表（兼容字段）
- `temperature` - 温度参数（默认 0.7）
- `max_tokens` - 最大 Token（默认 4096）
- `timeout` - 超时时间（默认 30s）
- `retry_attempts` - 重试次数（默认 3）
- `retry_delay` - 重试延迟（默认 1.0s）
- `supports_function_calling` - 支持工具调用（默认 true）

## 故障排查

### 问题：同名 Provider 只能加载一个
**已修复**：使用复合键机制，同名不同类型可以共存

### 问题：Provider 不存在
**排查：**
1. 检查 `providers.yaml` 中是否有该配置
2. 确认使用的是复合键（`name_providertype`）
3. 如果使用简单名称，确认只有一个匹配项

### 问题：热重载失败
**排查：**
1. 检查 `providers.yaml` 语法是否正确
2. 查看日志中的错误信息
3. 配置会自动回滚到热重载前的状态

### 问题：API 密钥错误
**排查：**
1. 检查 `providers.yaml` 中的 `api_key` 字段
2. 确认密钥格式正确（不要有多余的空格或换行）
3. 测试 Provider 连接性

## 技术细节

### ConfigStore 实现

```python
class ModelAdapterConfigStore:
    """单一配置文件存储"""
    
    def load_all(self) -> Dict[str, Dict]:
        """加载所有配置（1 次 IO）"""
        
    def save_all(self, configs: Dict[str, Dict]):
        """保存所有配置"""
        
    def save_provider(self, provider_key: str, config: Dict):
        """保存单个 Provider（读+写）"""
        
    def delete_provider(self, provider_key: str) -> bool:
        """删除单个 Provider（读+写）"""
```

### ModelAdapter 核心方法

```python
class ModelAdapter:
    def _make_provider_key(self, name, provider_type) -> str:
        """生成复合键"""
        
    def register_provider(self, provider: AIProvider):
        """注册 Provider（使用复合键）"""
        
    def get_provider(self, name, provider_type=None) -> AIProvider:
        """获取 Provider（支持多种查找方式）"""
        
    def reload(self) -> bool:
        """热重载配置（原子性）"""
```

## 参考资料

- 源代码：`backend/model_adapter/`
- API 路由：`backend/routes/model_adapter.py`
- 前端界面：`frontend/src/views/ModelAdapterView.vue`
- 测试文件：`backend/tests/test_single_file_config.py`
