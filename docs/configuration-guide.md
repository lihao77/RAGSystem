# 配置系统指南

## 📋 配置文件总览

本系统采用**多文件分层配置**，每个模块管理自己的配置。配置文件按用途分为：

### 🔒 敏感配置（需手动创建，已加入 .gitignore）

| 文件 | 用途 | 必需性 | 示例文件 |
|------|------|--------|----------|
| `backend/model_adapter/configs/providers.yaml` | LLM/Embedding API 密钥 | ✅ 必需 | `providers.yaml.example` |
| `backend/config/yaml/config.yaml` | 数据库连接、系统默认值 | 可选 | `config.yaml.example` |
| `backend/agents/configs/agent_configs.yaml` | 智能体配置 | 可选 | `agent_configs.yaml.example` |

### 📄 自动生成配置（运行时创建）

| 文件 | 用途 | 说明 |
|------|------|------|
| `backend/vector_store/config/vectorizers.yaml` | 向量化器列表 | 首次使用向量库时生成 |
| `backend/file_index/files.yaml` | 已上传文件索引 | 运行时数据 |
| `backend/workflow_configs/user/*.yaml` | 用户工作流 | 用户保存时创建 |
| `backend/node_configs/instances/*.yaml` | 工作流节点实例 | 工作流执行时创建 |

---

## 🚀 首次部署

### 方式一：使用配置文件（推荐开发环境）

```bash
cd backend

# 1. 复制示例配置
cp model_adapter/configs/providers.yaml.example model_adapter/configs/providers.yaml

# 2. 编辑配置文件，填入真实密钥
# 编辑 model_adapter/configs/providers.yaml

# 3. （可选）配置数据库连接
cp config/yaml/config.yaml.example config/yaml/config.yaml
# 编辑 config/yaml/config.yaml

# 4. 启动应用
python app.py
```

### 方式二：使用环境变量（推荐生产环境）

```bash
# 设置环境变量（与 providers.yaml 中 ${VAR} 对应）
export DEEPSEEK_API_KEY="sk-your-deepseek-key"
export OPENROUTER_API_KEY="sk-or-v1-..."
export NEO4J__PASSWORD="your-neo4j-password"

# 从 backend 目录启动
cd backend
python app.py
```

### 方式三：混合方式

```yaml
# providers.yaml 中可引用环境变量，顶层键为复合键 {name}_{provider_type}
my_deepseek:
  name: my
  provider_type: deepseek
  api_key: "${DEEPSEEK_API_KEY}"
  api_endpoint: ""
  model_map:
    chat: deepseek-chat
```

---

## 🔧 配置详解

### 1. Model Adapter 配置（必需）

**文件**：`backend/model_adapter/configs/providers.yaml`

**作用**：定义所有可用的 LLM 和 Embedding 服务提供商。

**结构**：
```yaml
# 顶层键为复合键：{name}_{provider_type}，如 my_deepseek、my_openrouter
<复合键>:
  name: "名称（用于复合键前半）"
  provider_type: "deepseek" | "openrouter" | "openai" | ...
  api_key: "API密钥或${环境变量}"
  api_endpoint: ""   # 留空用提供商默认，自建时填 URL
  model_map:
    chat: "模型名或 []"
    embedding: ["模型名"]  # 可选
    reasoning: []    # 可选
  models: []
```

**示例**：
```yaml
my_deepseek:
  name: my
  provider_type: deepseek
  api_key: "${DEEPSEEK_API_KEY}"
  api_endpoint: ""
  model_map:
    chat: deepseek-chat
  models: []
```

**校验规则**：
- ✅ `api_key` 不能为空或占位符（如 `sk-xxx`）
- ✅ 支持从环境变量读取（格式：`${VAR_NAME}`）
- ✅ 启动时会验证所有必填字段

---

### 2. 系统配置（可选）

**文件**：`backend/config/yaml/config.yaml`

**作用**：覆盖 `config/models.py` 中的默认值。

**不存在时**：使用代码中的默认值，应用仍可正常启动。

**结构**（与 `config/models.py` 一致）：
```yaml
neo4j:
  uri: "bolt://localhost:7687"
  user: neo4j
  password: "${NEO4J__PASSWORD}"

vector_store:
  backend: sqlite_vec
  sqlite_vec:
    database_path: data/vector_store.db
    vector_dimension: 0
    distance_metric: cosine

llm:
  provider: ""
  provider_type: ""
  model_name: ""

embedding:
  provider: ""
  provider_type: ""
  model_name: ""
  batch_size: 100
```

**校验规则**：
- ✅ Neo4j URI 必须以 `bolt://` 或 `neo4j://` 开头
- ✅ 支持从环境变量读取密码（格式：`SECTION__KEY`，如 `NEO4J__PASSWORD`）

---

### 3. 向量化器配置（自动生成）

**文件**：`backend/vector_store/config/vectorizers.yaml`

**作用**：管理多个向量化器及当前激活的向量化器。

**生成时机**：首次使用向量库功能时自动创建。

**结构**（与当前实现一致，键为 `provider_key` + `model_name` 的复合形式）：
```yaml
active_vectorizer_key: "my_openrouter_openai_text-embedding-3-small"
vectorizers:
  my_openrouter_openai_text-embedding-3-small:
    provider_key: my_openrouter
    model_name: openai/text-embedding-3-small
    distance_metric: cosine
    created_at: "2026-02-13T07:15:03.106903Z"
```

**校验规则**：
- ✅ `active_vectorizer_key` 必须存在于 `vectorizers` 中
- ⚠️ `provider_key` 须在 `providers.yaml` 中有对应复合键

---

### 4. 智能体配置（可选）

**文件**：`backend/agents/configs/agent_configs.yaml`

**作用**：自定义各智能体的行为。

**不存在时**：使用 `AgentConfig` 中的默认值。

**结构**（与 AgentConfig 一致，llm 使用 provider + provider_type 对应 providers 复合键）：
```yaml
agents:
  <agent_name>:
    agent_name: <agent_name>
    display_name: "显示名称"
    description: ""
    enabled: true
    llm:
      provider: my
      provider_type: deepseek
      model_name: deepseek-chat
      temperature: 0.7
      max_tokens: 4096
      timeout: 30
      retry_attempts: 3
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
    skills:
      enabled_skills: []
      auto_inject: true
    custom_params:
      type: react
      behavior:
        system_prompt: ""
        max_rounds: 10
        auto_execute_tools: true
```

**校验规则**：
- ✅ 有完整的 Pydantic 模型校验
- ⚠️ `llm.provider` + `llm.provider_type` 对应的复合键应在 `providers.yaml` 中定义

---

## 🔍 配置一致性检查

启动时会自动执行以下检查（见 `backend/config/health_check.py`）：

### ✅ 通过检查
```
正在检查配置...
配置检查通过。
```

### ⚠️ 警告（不阻止启动）
```
正在检查配置...
配置检查通过，但有以下建议：

向量化器 'xxx' 引用了不存在的 provider: 'yyy'
智能体 'zzz' 引用的 provider 不存在: 'aaa_bbb'
以下 providers 已配置但未被使用: xxx, yyy
```

### ❌ 错误（阻止启动）
```
正在检查配置...
配置检查未通过，请处理以下错误：

缺少必需配置: providers.yaml
  请运行: cp .../providers.yaml.example .../providers.yaml
  然后编辑该文件填入真实 API 密钥
```

---

## 🛠️ 常见问题

### Q1: 如何检查配置是否正常？

在 **backend** 目录下运行：
```bash
cd backend
python -m config.health_check
```

### Q2: 如何修改 LLM 密钥？

**方法一**：编辑配置文件  
编辑 `backend/model_adapter/configs/providers.yaml`，修改对应 provider 的 `api_key`。

**方法二**：使用环境变量  
在 `providers.yaml` 中写 `api_key: "${DEEPSEEK_API_KEY}"`，然后设置 `export DEEPSEEK_API_KEY="新密钥"`，重启应用。

### Q3: 配置文件被提交到 Git 了怎么办？

1. 将敏感路径加入 `.gitignore`（如 `backend/model_adapter/configs/providers.yaml`）。
2. 从 Git 索引移除（保留本地文件）：  
   `git rm --cached backend/model_adapter/configs/providers.yaml`
3. **立即更换已泄露的 API 密钥**。
4. 提交本次修改。

### Q4: 如何重置配置？

```bash
cd backend

# 删除敏感配置（按需）
# rm config/yaml/config.yaml
# rm agents/configs/agent_configs.yaml

# 重新从示例复制 providers（必需）
cp model_adapter/configs/providers.yaml.example model_adapter/configs/providers.yaml
# 编辑 providers.yaml 填入真实密钥
```

---

## 📊 配置优先级

同一配置项的优先级（从高到低）：

1. **环境变量**（如 `NEO4J__PASSWORD`、在 providers 中使用的 `${VAR}`）
2. **用户配置文件**（`config.yaml`、`providers.yaml` 等）
3. **代码默认值**（`config/models.py`、`AgentConfig` 等）

---

## 🔐 安全最佳实践

1. **绝不提交敏感配置**  
   确保 `.gitignore` 包含 `backend/model_adapter/configs/providers.yaml`、`backend/config/yaml/config.yaml`、`backend/agents/configs/agent_configs.yaml`。

2. **生产环境优先使用环境变量**  
   在 `providers.yaml` 中使用 `api_key: "${VAR}"`，在服务器上通过环境变量或密钥管理服务注入。

3. **定期轮换密钥**  
   更新密钥后重启应用。

4. **文件权限**  
   `chmod 600 backend/model_adapter/configs/providers.yaml`，仅应用用户可读。

---

## 📖 相关文档

- **Backend 配置调查报告**：`docs/BACKEND_CONFIG_SURVEY.md`（配置体系与各模块加载方式）
- **CLAUDE.md**：项目根目录，开发与配置速查
