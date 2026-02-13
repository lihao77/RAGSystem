# LLMAdapter 集成总结

> 最后更新：2025-01-03
> 版本：v2.0

## 概述

系统已成功集成 LLMAdapter，替换了原有的 LLMService，提供了更灵活、统一的 LLM 管理方式。

## 主要变更

### 1. 架构变更

**旧架构：**
```
GraphRAGService → LLMService → 直接 API 调用
```

**新架构：**
```
GraphRAGService → LLMAdapter → Provider → 统一 API 调用
```

### 2. 核心变动

#### 移除的组件
- ❌ `LLMService` - 已被 LLMAdapter 替代
- ❌ `get_llm_service()` - 不再使用
- ❌ 负载均衡功能 - 简化架构
- ❌ 默认 Provider 机制 - 必须显式指定

#### 新增的组件
- ✅ `LLMAdapter` - 统一的 LLM 管理接口
- ✅ `get_default_adapter()` - 获取全局 adapter 实例
- ✅ 模型列表支持 - 可配置多个模型
- ✅ Provider 编辑功能 - 支持修改配置
- ✅ 成本追踪 - 自动计算调用成本

### 3. 配置变更

#### 配置文件路径
- **默认配置**：`backend/config/yaml/config.default.yaml`
- **用户配置**：`backend/config/yaml/config.yaml`
- **旧版配置**：`backend/config.json`（不再使用）

#### 配置格式变更

**旧版配置：**
```yaml
llm:
  api_endpoint: https://api.deepseek.com/v1
  api_key: sk-...
  model_name: deepseek-chat
```

**新版配置：**
```yaml
llm:
  provider: deepseek           # 提供商名称
  model_name: deepseek-chat    # 模型名称
  temperature: 0.7            # 默认温度
  max_tokens: 4096            # 默认最大 token
  timeout: 30                 # 超时时间
  retry_attempts: 3          # 重试次数
```

### 4. API 变更

#### 后端 API 变更

**新增 API：**
```
GET  /api/llm-adapter/providers           - 获取 Provider 列表
POST /api/llm-adapter/providers           - 创建 Provider
PUT  /api/llm-adapter/providers/{name}    - 更新 Provider
DELETE /api/llm-adapter/providers/{name}  - 删除 Provider
POST /api/llm-adapter/test                - 测试 Provider
```

**修改的 API：**
```
GET  /api/config/services/status  - 现在检查 config.llm.provider
```

**移除的 API：**
```
# LLMService 相关的内部 API
```

#### 前端组件变更

**新增组件：**
- `LLMConfigSelector.vue` - 可复用的 LLM 配置选择器
- `LLMAdapterView.vue` - 完整的 LLMAdapter 管理界面

**修改的组件：**
- `SettingsView.vue` - 集成 LLMConfigSelector

## 使用指南

### 1. 配置 LLM

**方式一：通过 LLMAdapter 页面（推荐）**

1. 访问 `/llm-adapter`
2. 点击"添加 Provider"
3. 选择提供商类型（OpenAI/DeepSeek/OpenRouter）
4. 填写配置信息（API 密钥、支持的模型等）
5. 保存配置

**方式二：通过系统设置**

1. 访问 `/settings`
2. 在 LLM 配置部分选择提供商
3. 选择模型（从列表或手动输入）
4. 调整参数（温度、最大 token 等）
5. 点击"测试连接"验证配置
6. 保存配置

**方式三：直接编辑配置文件**

编辑 `backend/config/yaml/config.yaml`：
```yaml
llm:
  provider: deepseek
  model_name: deepseek-chat
  api_key: your-api-key
```

然后重启后端服务。

### 2. 在代码中使用

**后端代码：**

```python
from llm_adapter import get_default_adapter

adapter = get_default_adapter()

# 发送请求（必须指定 provider 和 model）
response = adapter.chat_completion(
    messages=[{"role": "user", "content": "你好"}],
    provider=config.llm.provider,        # 必需
    model=config.llm.model_name          # 必需
)

if response.error:
    logger.error(f"调用失败: {response.error}")
else:
    print(f"回复: {response.content}")
    print(f"Token: {response.usage}")
    print(f"成本: ${response.cost}")
```

**GraphRAG 自动使用：**

GraphRAGService 已自动集成 LLMAdapter，无需修改代码。

### 3. 测试配置

**后端测试：**
```bash
# 测试 Provider
curl -X POST http://localhost:5000/api/llm-adapter/test \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "MyDeepSeek",
    "model": "deepseek-chat",
    "prompt": "测试"
  }'

# 查看服务状态
curl http://localhost:5000/api/config/services/status
```

**前端测试：**
1. 在 LLMAdapter 页面点击"测试"
2. 或在系统设置页面点击"测试连接"

## 重要提醒

### 1. 必须重启后端

配置文件在**后端启动时加载**，修改配置后需要重启后端服务才能生效。

重启方式：
```bash
# 停止当前服务（Ctrl+C）
# 重新启动
python app.py
```

### 2. 必须使用 provider 和 model

调用 `adapter.chat_completion()` 时，必须显式指定 `provider` 和 `model` 参数：

```python
# ❌ 错误 - 缺少必需参数
response = adapter.chat_completion(messages=messages)

# ✅ 正确 - 指定 provider 和 model
response = adapter.chat_completion(
    messages=messages,
    provider="deepseek",
    model="deepseek-chat"
)
```

### 3. 配置保存位置

- **LLMAdapter 配置**：保存在 `backend/llm_adapter/configs/` 目录
- **系统配置**：保存在 `backend/config/yaml/config.yaml`

### 4. 调试日志

在 `backend/services/config_service.py` 中添加了调试日志，可以查看：
- 实际加载的配置值
- 布尔转换结果

日志级别：INFO

## 相关文件

### 后端文件

```
backend/
├── llm_adapter/
│   ├── adapter.py          # 主适配器
│   ├── base.py             # 抽象基类
│   ├── providers.py        # Provider 实现
│   ├── config_store.py     # 配置存储
│   └── config_store/       # 配置文件（自动生成）
├── config/
│   ├── models.py           # 配置模型（LLMConfig）
│   └── yaml/
│       ├── config.yaml     # 用户配置
│       └── config.default.yaml  # 默认配置
├── services/
│   ├── graphrag_service.py # 已迁移使用 adapter
│   └── config_service.py   # 服务状态检测
├── routes/
│   ├── llm_adapter.py      # LLMAdapter API
│   ├── config_refactored.py # 配置 API
│   └── graphrag_refactored.py # GraphRAG API
└── app.py                  # 路由注册
```

### 前端文件

```
frontend/src/
├── components/
│   └── LLMConfigSelector.vue  # 配置选择器
├── views/
│   ├── LLMAdapterView.vue     # 完整管理界面
│   └── SettingsView.vue       # 系统集成
└── api/
    └── llm-adapter.js         # API 调用
```

## 迁移检查清单

- [x] 创建 LLMAdapter 系统
- [x] 更新后端模型（LLMConfig）
- [x] 更新配置文件格式
- [x] 迁移 GraphRAGService
- [x] 迁移路由配置
- [x] 创建前端组件
- [x] 更新系统设置
- [x] 移除 LLMService
- [x] 测试完整流程

## 版本历史

- **v1.0** (2025-01-01) - 初始版本
  - 支持 OpenAI、DeepSeek、OpenRouter
  - 基础配置管理

- **v2.0** (2025-01-03) - 全面集成
  - 移除 LLMService
  - 集成 GraphRAG
  - 添加前端界面
  - 增强配置管理

## 技术支持

如有问题，请检查：
1. 后端日志（查看错误信息）
2. 配置文件（格式和内容）
3. API 响应（使用浏览器开发者工具）

常见日志标签：
- `llm_adapter` - LLMAdapter 相关日志
- `graphrag` - GraphRAG 服务日志
- `config` - 配置管理日志
