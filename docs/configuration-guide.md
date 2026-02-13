# 配置系统指南

## 📋 配置文件总览

本系统采用**多文件分层配置**，每个模块管理自己的配置。配置文件按用途分为：

### 🔒 敏感配置（需手动创建，已加入 .gitignore）

| 文件 | 用途 | 必需性 | 示例文件 |
|------|------|--------|----------|
| `backend/model_adapter/configs/providers.yaml` | LLM/Embedding API 密钥 | 可选（缺时仅警告，可从前端添加后自动创建） | `providers.yaml.example` |
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

## 📐 配置结构总览

所有配置的**数据来源**与**结构**关系如下（路径均相对于 `backend/`）：

```
配置层级与默认值来源
────────────────────────────────────────────────────────────────────
1. providers.yaml（可选，缺时仅警告，可从前端添加 Provider 后自动创建）
   路径: model_adapter/configs/providers.yaml
   默认: 无；缺失时健康检查仅警告并允许启动，用户可在「模型适配器」中添加并保存以创建该文件
   结构: 顶层键 = 复合键 {name}_{provider_type}
         ├── name, provider_type, api_key, api_endpoint
         ├── model_map: { chat?, embedding?, reasoning? }
         └── models: []

2. config.yaml（可选，系统配置）
   路径: config/yaml/config.yaml
   默认: config/models.py 中各 Pydantic 模型默认值（无 config.default.yaml）
   结构: 合并进 AppConfig
         ├── neo4j: { uri, user, password }
         ├── vector_store: { backend, sqlite_vec: { database_path, vector_dimension, distance_metric } }
         ├── llm: { provider, provider_type, model_name, ... }
         ├── embedding: { provider, provider_type, model_name, batch_size }
         ├── system: { max_content_length }
         └── external_libs: { llmjson, json2graph }

3. agent_configs.yaml（可选，智能体配置）
   路径: agents/configs/agent_configs.yaml
   默认: 文件不存在时 AgentConfigManager 会 _create_default_configs() 并写回空 agents
   结构: agents: { <agent_name>: AgentConfig }
         └── 每项: agent_name, display_name, llm{ provider, provider_type, model_name, ... }
                   tools.enabled_tools, skills.enabled_skills, custom_params

4. vectorizers.yaml（可选，向量化器）
   路径: vector_store/config/vectorizers.yaml
   默认: 文件不存在时 VectorizerConfigStore 返回 active_vectorizer_key=None, vectorizers={}
   结构: active_vectorizer_key: str?
         vectorizers: { <key>: { provider_key, model_name, distance_metric, created_at } }
```

**配置优先级**（同一项多处存在时）：环境变量 > 用户配置文件（YAML）> 代码默认值（models.py / 各 Store 内置默认）。

---

## 🔄 新用户首次启动逻辑

新用户在本机第一次执行 `python app.py`（在 `backend` 目录下）时，实际执行顺序如下。

### 步骤 1：健康检查（在创建 Flask 应用之前）

1. **check_gitignore**  
   检查仓库根目录 `.gitignore` 是否包含敏感配置路径；未包含则仅**警告**，不阻止启动。

2. **check_required_configs**  
   - 若 **不存在** `model_adapter/configs/providers.yaml`：  
     - 仅向 **warnings** 追加提示（建议复制示例或启动后在前端「模型适配器」添加 Provider），**不**加入 errors。  
     - 健康检查仍返回 `True`，**允许启动**；用户可在前端添加首个 Provider，保存时后端会自动创建该文件。
   - 若 **存在** `providers.yaml`：继续做格式与一致性校验。

3. **check_config_validity**（仅当 errors 为空时执行）  
   - 使用 `config.schemas.ProvidersConfig.load(providers.yaml)` 做格式与 api_key 校验（占位符、环境变量等）。  
   - 再加载 `vector_store/config/vectorizers.yaml`（不存在则当作空配置）、以及通过 `AgentConfigManager` 间接用到的 agents 配置，做**跨配置一致性**校验（如智能体引用的 provider 是否存在）。  
   - 校验失败会加入 errors（阻止启动）；仅不一致或建议则加入 warnings（**不阻止启动**）。

4. **汇总结果**  
   - 若有 **errors**：打印错误，`run_health_check()` 返回 `False` → 进程退出。  
   - 仅有 **warnings**：打印建议，返回 `True` → 继续启动。  
   - 无 errors 无 warnings：打印“配置检查通过”，返回 `True` → 继续启动。

### 步骤 2：通过健康检查后的加载顺序

1. **config 系统配置**  
   `get_config()` → `ConfigManager.load()`：  
   - 若存在 `config/yaml/config.default.yaml` 则加载（当前项目已无此文件）；  
   - 若存在 `config/yaml/config.yaml` 则深度合并；  
   - 再合并环境变量（如 NEO4J_*、LLM_* 等）；  
   - 最后用 `AppConfig(**config_dict)` 得到系统配置。  
   **新用户未创建 config.yaml 时**：仅用环境变量 + `config/models.py` 中 Pydantic 默认值。

2. **创建 Flask 应用**  
   使用上一步的 `config` 设置 `MAX_CONTENT_LENGTH`、上传目录等。

3. **各模块按需读自己的配置**  
   - **ModelAdapter**：使用 `ModelAdapterConfigStore` 读 `model_adapter/configs/providers.yaml`；文件存在则返回 `{ 复合键: config_dict }`，不存在则返回 `{}`（健康检查已保证首次启动时该文件存在）。  
   - **AgentConfigManager**：读 `agents/configs/agent_configs.yaml`；**若文件不存在**则调用 `_create_default_configs()`，向磁盘写入一个空的 `agents: {}` 结构（及 metadata），之后内存中为空的智能体列表。  
   - **VectorizerConfigStore**：读 `vector_store/config/vectorizers.yaml`；**若文件不存在**则内存中为 `active_vectorizer_key=None, vectorizers={}`，不写文件；文件会在用户在前端“向量库管理”中添加并激活向量化器时由逻辑创建/更新。

### 步骤 3：新用户最小可用路径总结

| 步骤 | 新用户操作 | 结果 |
|------|------------|------|
| 1 | 直接运行 `python app.py` | 无 providers.yaml 时仅打印警告，进程仍启动；可进入前端 |
| 2 | 在前端「模型适配器」中添加 Provider 并保存 | 后端自动创建 `providers.yaml`，此后对话/向量等能力可用 |
| 或 | 先复制 `providers.yaml.example` → `providers.yaml` 并填入 api_key 再启动 | 无警告，启动即具备 LLM/Embedding 能力 |
| 3 | （可选）复制 `config.yaml.example` / `agent_configs.yaml.example` 并修改 | 自定义系统配置或智能体；否则使用默认或自动生成空 agents |

因此：**新用户可以不准备任何配置文件直接 `python app.py`**。无 `providers.yaml` 时会有警告，但可启动；在前端「模型适配器」添加并保存首个 Provider 后会自动创建 `providers.yaml`。若希望首次启动即具备对话能力，可先复制 `providers.yaml.example` 并填入密钥。

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
