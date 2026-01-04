# 智能体配置目录

## 概述

此目录存储智能体的配置文件，用于为每个智能体配置独立的 LLM 参数、工具设置和自定义参数。

## 文件说明

- **agent_configs.yaml** - 实际使用的配置文件（自动生成，不提交到 git）
- **agent_configs.yaml.example** - 配置示例文件（提交到 git，供参考）
- **.gitignore** - Git 忽略配置

## 配置文件位置

```
backend/agents/configs/agent_configs.yaml
```

## 自动生成

首次运行系统时，如果 `agent_configs.yaml` 不存在，系统会自动创建默认配置。

默认配置包括：
- `qa_agent` - 问答智能体配置
- `master_agent` - 主协调智能体配置

## 配置管理

### 1. 通过 API 管理（推荐）

访问前端页面：`/agent-config`

或使用 API：
```bash
# 查看所有配置
GET /api/agent-config/configs

# 更新配置
PATCH /api/agent-config/configs/qa_agent
```

### 2. 直接编辑文件

可以直接编辑 `agent_configs.yaml` 文件，系统会在下次启动时加载新配置。

参考 `agent_configs.yaml.example` 了解配置格式。

## 配置优先级

```
智能体独立配置 (agent_configs.yaml)
  ↓
系统全局配置 (backend/config/yaml/config.yaml)
  ↓
默认配置
```

## 注意事项

1. **不要提交 agent_configs.yaml 到 git**
   - 此文件包含用户自定义配置
   - 已通过 .gitignore 忽略

2. **配置验证**
   - 修改配置后建议通过 API 验证：
     ```bash
     GET /api/agent-config/configs/{agent_name}/validate
     ```

3. **备份配置**
   - 重要配置建议导出备份：
     ```bash
     GET /api/agent-config/configs/{agent_name}/export?format=yaml
     ```

## 完整文档

详细使用说明请参考：`backend/agents/AGENT_CONFIG_GUIDE.md`
