# 向量维度智能管理系统

## 概述

RAGSystem 现已支持向量维度的智能管理，无需手动配置向量维度，系统会自动从 Embedding 模型推断。

## 核心特性

### 1. 自动维度推断
系统会自动从 Embedder 获取实际向量维度，无需在配置文件中手动指定。

**工作流程**：
```
Embedding 配置 → 初始化 Embedder → 获取实际维度 → 配置向量存储
```

### 2. 维度不匹配检测
启动时自动检测现有数据库与配置的维度是否匹配：

- ✅ **维度匹配**: 正常启动
- ⚠️ **维度不匹配**: 自动备份数据并重建数据库

### 3. 数据迁移工具
当更换 Embedding 模型导致维度变化时，使用迁移工具保留并重新编码数据。

## 使用指南

### 场景 1: 全新部署（无现有数据）

1. 配置 Embedding API：
   ```yaml
   # backend/config/yaml/config.yaml
   embedding:
     mode: remote
     remote:
       api_endpoint: https://api-inference.modelscope.cn/v1
       api_key: your_api_key
       model_name: Qwen/Qwen3-Embedding-8B  # 4096 维
   ```

2. 启动系统：
   ```bash
   cd backend
   python app.py
   ```

3. 系统会自动：
   - 初始化 Embedder
   - 获取向量维度（4096）
   - 创建对应的向量数据库

**日志输出示例**：
```
INFO:vector_store.embedder:✅ 远程 Embedder 已初始化
INFO:vector_store.embedder:   API: https://api-inference.modelscope.cn/v1
INFO:vector_store.embedder:   模型: Qwen/Qwen3-Embedding-8B
INFO:vector_store.embedder:向量维度: 4096
INFO:vector_store.client:✓ 向量维度匹配: 4096
INFO:vector_store.sqlite_store:✅ SQLite 向量存储已初始化: data/vector_store.db
INFO:vector_store.sqlite_store:   向量维度: 4096, 距离度量: cosine
```

### 场景 2: 更换 Embedding 模型（有现有数据）

假设你想从 `Qwen3-Embedding-8B` (4096维) 换到 `text-embedding-3-small` (1536维)。

#### 方案 A: 自动重建（丢弃现有数据）

1. 修改配置：
   ```yaml
   embedding:
     mode: remote
     remote:
       api_endpoint: https://api.openai.com/v1
       api_key: sk-xxxxx
       model_name: text-embedding-3-small  # 1536 维
   ```

2. 重启系统，会自动检测并重建：
   ```
   WARNING:vector_store.sqlite_store:检测到维度不匹配:
     现有数据库维度: 4096
     新配置维度: 1536
   WARNING:vector_store.sqlite_store:⚠️  检测到向量维度不匹配，将重建数据库表
   WARNING:vector_store.sqlite_store:⚠️  开始重建数据库，所有现有数据将被删除！
   INFO:vector_store.sqlite_store:✓ 已备份 0 条文档（仅内容，不含向量）
   INFO:vector_store.sqlite_store:✓ 已删除旧表结构
   INFO:vector_store.sqlite_store:✓ 新表结构创建完成
   INFO:vector_store.sqlite_store:✓ 数据库重建完成（原数据库为空）
   ```

#### 方案 B: 数据迁移（保留现有数据）

1. **备份现有数据库**（可选但推荐）：
   ```bash
   cd backend/data
   cp vector_store.db vector_store.db.manual_backup
   ```

2. **修改配置**（同方案 A）

3. **运行迁移工具**：
   ```bash
   cd backend
   python -m utils.migrate_vector_dimension
   ```

4. **迁移过程**：
   ```
   步骤 1/4: 读取现有文档...
   ✓ 从旧数据库读取了 1000 条文档

   步骤 2/4: 备份数据库...
   ✓ 已备份到: data/vector_store.db.backup

   步骤 3/4: 初始化新向量存储...
   ⚠️  检测到向量维度不匹配，将重建数据库表
   ✓ 数据库重建完成

   步骤 4/4: 重新编码 1000 条文档...
   迁移集合 'default' (1000 条文档)...
   100%|██████████| 20/20 [00:15<00:00,  1.28it/s]

   ✅ 迁移完成！
      总共迁移: 1000/1000 条文档
      新向量维度: 1536
      备份位置: data/vector_store.db.backup
   ```

5. **迁移选项**：
   ```bash
   # 仅迁移指定集合
   python -m utils.migrate_vector_dimension --collection emergency_plans

   # 调整批处理大小（默认 50）
   python -m utils.migrate_vector_dimension --batch-size 100
   ```

### 场景 3: 维度配置不匹配（自动修正）

如果配置文件中的 `vector_dimension` 与 Embedder 实际维度不匹配：

**配置文件**：
```yaml
vector_store:
  sqlite_vec:
    vector_dimension: 768  # 错误的配置

embedding:
  remote:
    model_name: Qwen/Qwen3-Embedding-8B  # 实际 4096 维
```

**系统行为**：
```
WARNING:vector_store.client:⚠️  配置的向量维度 (768) 与 Embedder 实际维度 (4096) 不匹配
   将自动使用 Embedder 的实际维度: 4096
INFO:vector_store.sqlite_store:✅ SQLite 向量存储已初始化
   向量维度: 4096, 距离度量: cosine
```

系统会自动使用正确的维度（4096），无需手动修改配置。

## 配置说明

### 推荐配置（自动推断）

```yaml
# backend/config/yaml/config.yaml
vector_store:
  backend: sqlite_vec
  sqlite_vec:
    database_path: data/vector_store.db
    # vector_dimension 会自动从 Embedding 推断，无需配置
    distance_metric: cosine

embedding:
  mode: remote
  remote:
    api_endpoint: https://api-inference.modelscope.cn/v1
    api_key: your_api_key
    model_name: Qwen/Qwen3-Embedding-8B
```

### 手动覆盖（不推荐）

如果确实需要覆盖自动推断的维度：

```yaml
vector_store:
  sqlite_vec:
    vector_dimension: 4096  # 手动指定
```

注意：手动指定的维度必须与 Embedding 模型匹配，否则会导致错误。

## 常见 Embedding 模型维度

| 模型 | API 提供商 | 维度 |
|------|----------|------|
| text-embedding-3-small | OpenAI | 1536 |
| text-embedding-3-large | OpenAI | 3072 |
| text-embedding-ada-002 | OpenAI | 1536 |
| Qwen/Qwen3-Embedding-8B | ModelScope | 4096 |
| BAAI/bge-small-zh-v1.5 | 本地 | 512 |
| BAAI/bge-base-zh-v1.5 | 本地 | 768 |
| BAAI/bge-large-zh-v1.5 | 本地 | 1024 |
| embedding-2 | 智谱AI | 1024 |

## 故障排查

### Q: 启动时提示维度不匹配

**现象**：
```
WARNING:检测到维度不匹配:
  现有数据库维度: 768
  新配置维度: 4096
```

**原因**: 你更换了 Embedding 模型，导致维度变化。

**解决方案**：
- 如果不需要保留数据：让系统自动重建（什么都不做）
- 如果需要保留数据：运行 `python -m utils.migrate_vector_dimension`

### Q: 迁移工具找不到数据库文件

**现象**：
```
ERROR:❌ 数据库文件不存在: data/vector_store.db
```

**解决方案**: 检查数据库路径配置，确保 `config.yaml` 中的路径正确。

### Q: 迁移过程中 Embedding API 调用失败

**现象**：
```
ERROR:❌ 编码失败: 400 Client Error: Bad Request
```

**解决方案**：
1. 检查 API Key 是否有效
2. 检查网络连接
3. 检查 API 额度是否用尽
4. 减小 batch_size：`--batch-size 10`

### Q: 想回到旧的 Embedding 模型

**解决方案**：
1. 修改配置文件，恢复旧模型配置
2. 从备份恢复数据库：
   ```bash
   cd backend/data
   cp vector_store.db.backup vector_store.db
   ```
3. 重启系统

## 技术细节

### 维度推断优先级

1. **Embedder 实际维度**（最高优先级）
   - 从已初始化的 Embedder 获取
   - 通过测试查询获取实际输出维度

2. **配置文件维度**
   - `config.yaml` 中的 `vector_dimension`
   - 作为兜底值

3. **现有数据库维度**
   - 从 `collections` 表读取
   - 用于检测不匹配

### 自动重建触发条件

满足以下所有条件时触发自动重建：
1. 数据库文件已存在
2. `collections` 表存在
3. 存在至少一个集合记录
4. 现有维度 ≠ 新配置维度

### 数据迁移流程

```
读取旧文档 → 备份数据库 → 重建表结构 → 批量重新编码 → 插入新数据
```

## 最佳实践

1. **初次部署**: 无需配置 `vector_dimension`，让系统自动推断

2. **更换模型前**:
   - 备份数据库文件
   - 准备迁移工具命令

3. **生产环境**:
   - 始终使用迁移工具保留数据
   - 在测试环境验证新模型效果

4. **监控日志**:
   - 关注维度不匹配警告
   - 确认向量维度输出正确

## 相关文件

- **智能推断逻辑**: `backend/vector_store/client.py` (`_get_vector_dimension()`)
- **维度检测**: `backend/vector_store/sqlite_store.py` (`_check_dimension_mismatch()`)
- **自动重建**: `backend/vector_store/sqlite_store.py` (`_rebuild_database()`)
- **迁移工具**: `backend/utils/migrate_vector_dimension.py`
- **配置文件**: `backend/config/yaml/config.yaml`
- **文档说明**: `CLAUDE.md` 和 `VECTOR_STORE_MIGRATION.md`
