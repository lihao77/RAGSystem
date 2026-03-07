# Backend 配置调查报告

> **使用与部署**：首次部署、示例文件、健康检查与常见问题见 **[配置系统指南](configuration-guide.md)**。

## 一、配置体系总览

后端存在**多套独立配置**，分别由不同模块加载，**没有**统一的“一处配置、全局生效”机制。下表为按用途与路径整理的清单。

| 类别 | 路径 | 加载方式 | 校验/模型 | 说明 |
|------|------|----------|------------|------|
| **系统配置** | `config/yaml/config.yaml` | ConfigManager + 深度合并 | Pydantic（models.py） | 全局默认：Neo4j、向量库、LLM/Embedding 默认、系统参数 |
| **Model Adapter** | `model_adapter/configs/providers.yaml` | ModelAdapterConfigStore | 无（纯 dict） | LLM/Embedding 的 Provider 列表（API Key、端点、模型映射等） |
| **向量化器** | `vector_store/config/vectorizers.yaml` | VectorizerConfigStore | 无（约定结构） | 当前激活的向量化器、多向量化器列表 |
| **智能体** | `agents/configs/agent_configs.yaml` | AgentConfigManager | Pydantic（agent_config.py） | 各 Agent 的 LLM、工具、Skills、custom_params |
| **文件索引** | `file_index/files.yaml` | FileIndex 类 | 无 | 已上传文件元数据索引（id、路径、时间等） |
| **工作流** | `workflow_configs/user/*.yaml` | WorkflowStore | Pydantic（workflows/models） | 用户保存的工作流定义（按文件存储） |
| **节点配置** | `node_configs/instances/*.yaml`、`node_configs/presets/*.yaml` | NodeConfigStore | 各节点 NodeConfigBase | 节点实例与预设配置（按文件存储） |

旧版 `llm_adapter` 配置与兼容入口已移除，当前仅保留 **model_adapter** 一套实现。

---

## 二、各配置详情

### 2.1 系统配置（config）

- **路径**：`backend/config/yaml/config.yaml`（可选）；默认值来自 `backend/config/models.py`。
- **加载**：ConfigManager 先读默认 YAML（已精简删除）、再合并用户 config.yaml、再合并环境变量，最后用 `AppConfig(**config_dict)` 构造。
- **校验**：完整 Pydantic 模型（AppConfig、Neo4jConfig、VectorStoreConfig、LLMConfig、EmbeddingConfig 等）。
- **作用**：Neo4j 连接、vector_store 后端与路径、系统默认 LLM/Embedding 的 provider/provider_type/model_name、max_content_length、external_libs 占位等。
- **现状**：已精简，无 config.default.yaml / config.yaml.example，以 models.py 为唯一真相源；README 已更新。

### 2.2 Model Adapter（model_adapter/configs/providers.yaml）

- **路径**：`backend/model_adapter/configs/providers.yaml`。
- **加载**：ModelAdapterConfigStore 单文件 YAML，`load_all()` 返回 `{provider_key: config_dict}`。
- **校验**：无 Pydantic，结构由代码约定（name、provider_type、api_key、model_map、models 等）。
- **作用**：所有 LLM/Embedding Provider 的注册信息；应用启动时 ModelAdapter 从此文件加载并注册到内存。
- **敏感信息**：含 api_key，应加入 .gitignore 或仅提交示例；当前仓库若已提交需注意脱敏。
- **与系统 config 关系**：系统 config 的 llm/embedding 只指定“用哪个 provider + 默认模型名”；真实 API Key 与端点仅在此处（或管理界面写入此文件）。

### 2.3 向量化器（vector_store/config/vectorizers.yaml）

- **路径**：`backend/vector_store/config/vectorizers.yaml`。
- **加载**：VectorizerConfigStore，结构为 `active_vectorizer_key` + `vectorizers: { key: { provider_key, model_name, distance_metric, ... } }`。
- **校验**：无 Pydantic，依赖约定字段。
- **作用**：向量库管理中的“当前激活向量化器”及多向量化器列表；init_vector_store 是否执行由“是否有激活向量化器”决定。
- **与系统 config 关系**：与 config.embedding 解耦，向量库维度/距离等以此处为准；config.vector_store 仅提供数据库路径与后端类型。

### 2.4 智能体（agents/configs/agent_configs.yaml）

- **路径**：`backend/agents/configs/agent_configs.yaml`。
- **加载**：AgentConfigManager 启动时加载，解析 `agents: { agent_name: AgentConfig }`。
- **校验**：有 Pydantic（AgentConfig、AgentLLMConfig、AgentToolConfig 等），解析失败会打日志并回退默认。
- **作用**：每个智能体的 display_name、enabled、llm（provider/provider_type/model_name 等）、tools、skills、custom_params；与系统 config 的 llm 做 merge_with_default。
- **现状**：目录内仍有 agent_configs.yaml.example、agent_configs.plugin_example.yaml、agent_configs.backup.yaml；README 称 agent_configs.yaml 不提交，由 .gitignore 忽略。与系统配置类似，若 AgentConfig 默认值完整，可考虑示例仅保留一份最小示例或仅文档说明。

### 2.5 文件索引（file_index/files.yaml）

- **路径**：`backend/file_index/files.yaml`。
- **加载**：FileIndex 类，按需读写，结构为 `{ file_id: { id, original_name, stored_name, stored_path, size, mime, uploaded_at } }`。
- **校验**：无模型，纯运行时数据。
- **作用**：上传文件的元数据索引，供列表/删除等使用；与“系统配置”无直接关系，属业务数据。

### 2.6 工作流（workflow_configs/user/）

- **路径**：`backend/workflow_configs/user/*.yaml`（按工作流 ID 或名称单文件存储）。
- **加载**：WorkflowStore 按需读单个 YAML，并做 schema 迁移。
- **校验**：有 Pydantic（WorkflowDefinition 等）。
- **作用**：用户保存的工作流定义，与系统配置独立。

### 2.7 节点配置（node_configs/）

- **路径**：`backend/node_configs/instances/*.yaml`、`backend/node_configs/presets/*.yaml`。
- **加载**：NodeConfigStore 按节点类型与名称读写单文件。
- **校验**：各节点自己的 NodeConfigBase 子类。
- **作用**：工作流中节点实例与预设配置，与系统配置独立。

---

## 三、发现与问题

1. **配置分散、入口不统一**  
   系统配置、Model Adapter、向量化器、智能体、文件索引、工作流、节点等各自读自己的 YAML，没有统一入口或配置中心，新人理解成本高。

2. **部分配置无 Pydantic**  
   providers.yaml、vectorizers.yaml、files.yaml 均为“约定结构”，无运行时校验，错误格式易导致难以排查的运行时异常。

3. **敏感信息位置**  
   providers.yaml 含 api_key，若被提交到仓库存在泄露风险；建议明确加入 .gitignore 或仅提交无密钥示例，并在文档中说明。

4. **与系统 config 的重复语义**  
   config.llm / config.embedding 与 agents 的 llm、以及 Model Adapter 的 providers，在“谁决定用哪个模型”上存在多层：系统默认 → 智能体覆盖 → Provider 实际能力。逻辑清晰但文档若未写清容易混淆。

5. **ModelAdapter 单一实现**  
   当前应用已删除旧 `llm_adapter` 兼容层，仅保留 `model_adapter` 与 `/api/model-adapter` 入口，避免双轨并存。

6. **agents 示例文件**  
   agent_configs 存在 .example 与 .plugin_example；若智能体配置也有“无文件则用代码默认生成”的机制，可像系统 config 一样精简为“以 Pydantic 默认 + 文档为主”，或只保留一份最小示例。

---

## 四、建议

### 4.1 短期（可立即做）

- **providers.yaml 安全**：将 `model_adapter/configs/providers.yaml` 加入 .gitignore（或保留 providers.yaml.example 无密钥示例并忽略真实文件）；在 README 或部署文档中说明“API Key 仅在此文件或管理界面配置”。
- **文档集中说明**：在 `docs/` 或 `backend/README` 中增加一页“配置总览”，列出本报告中各配置路径、用途、谁加载、与系统 config 的关系（可引用本报告）。
- **agents 示例**：若希望与系统 config 风格一致，可只保留一个 agent_configs.yaml.example（或仅文档描述结构），并在 agents/configs/README 中说明“以 AgentConfig 模型为准，示例可选”。

### 4.2 中期（可选）

- **Model Adapter / 向量化器结构校验**：为 providers.yaml、vectorizers.yaml 的顶层或关键字段增加 Pydantic 模型（或 JSON Schema），在 load 时校验，失败时给出明确错误信息。
- **ModelAdapter 文档统一**：继续将剩余文档、截图和示例中的旧名称统一为 ModelAdapter，避免历史术语造成误解。

### 4.3 长期（可选）

- **配置中心化**：仍保持“多文件、多用途”的现状，但提供一份“配置索引”文档或脚本，列出所有 YAML 路径、环境变量、以及读取它们的模块，便于运维与排错。
- **敏感配置统一**：考虑将 api_key 等统一从环境变量或密钥服务读取，providers.yaml 只存非敏感项（如 name、provider_type、model_map），与当前“管理界面写 providers.yaml”的方式二选一或做兼容。

---

## 五、配置与代码对照速查

| 配置路径 | 读取/存储类 | 入口位置 |
|----------|--------------|----------|
| config/yaml/config.yaml | ConfigManager | config/base.py |
| config/models.py | AppConfig 等 | 默认值来源 |
| model_adapter/configs/providers.yaml | ModelAdapterConfigStore | model_adapter/config_store.py |
| vector_store/config/vectorizers.yaml | VectorizerConfigStore | vector_store/vectorizer_config.py |
| agents/configs/agent_configs.yaml | AgentConfigManager | agents/config_manager.py |
| file_index/files.yaml | FileIndex | file_index/store.py |
| workflow_configs/user/*.yaml | WorkflowStore | workflows/store.py |
| node_configs/instances、presets | NodeConfigStore | nodes/config_store.py |

以上为本次 Backend 配置调查的结论与建议，可根据优先级分步落地。
