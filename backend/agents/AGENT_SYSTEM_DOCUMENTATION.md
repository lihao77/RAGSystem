# 智能体系统文档 (Agent System Documentation)

## 1. 系统概述

RAGSystem 的智能体系统采用 **MasterAgent 统一入口架构**，旨在解决复杂任务的自动分解、路由和多智能体协作问题。

### 核心设计理念
- **统一入口**: 所有外部请求通过 `MasterAgent` 进入，用户无需关心具体调用哪个智能体。
- **动态加载**: 支持基于配置文件的智能体动态加载和热插拔。
- **分层架构**:
  - **Orchestrator (编排层)**: 负责路由分发。
  - **MasterAgent (决策层)**: 负责任务分析与分解。
  - **Worker Agents (执行层)**: 负责具体领域任务（如 ReActAgent）。

## 2. 核心组件详解

### 2.1 BaseAgent (智能体基类)
所有智能体的基类，定义了统一的生命周期和接口。
- **位置**: `backend/agents/base.py`
- **主要职责**:
  - `execute(task, context)`: 执行任务的抽象方法（必须实现）。
  - `before_execute/after_execute`: 执行前后的钩子函数。
  - `get_llm_config()`: 获取 LLM 配置（支持从系统配置继承）。
  - 上下文管理 (`AgentContext`): 管理会话历史和中间结果。

### 2.2 AgentLoader (智能体加载器)
负责从配置文件实例化智能体对象。
- **位置**: `backend/agents/agent_loader.py`
- **工作流程**:
  1. 读取 `backend/agents/configs/agent_configs.yaml`。
  2. 根据 `custom_params.type` 或名称判断智能体类型。
  3. 实例化对应的智能体类（ReActAgent, MasterAgent）。
  4. **特殊处理**: `MasterAgent` 为系统级智能体，强制加载且配置受限。

### 2.3 AgentConfigManager (配置管理器)
负责配置的 CRUD 操作和持久化。
- **位置**: `backend/agents/config_manager.py`
- **功能**:
  - 加载/保存 YAML 配置。
  - 提供运行时配置更新接口。
  - 支持配置预设（如 "快速模式", "深度思考模式"）。

### 2.4 MasterAgent (主协调智能体)
系统的 "大脑"，不直接执行具体任务，而是协调其他智能体。
- **位置**: `backend/agents/master_agent.py`
- **能力**:
  - **任务分析**: 判断任务复杂度。
  - **任务分解**: 将复杂任务拆解为子步骤。
  - **结果整合**: 汇总各子智能体的执行结果。

## 3. 智能体配置指南

智能体配置存储在 `backend/agents/configs/agent_configs.yaml` 中。

### 3.1 配置文件结构
```yaml
agents:
  qa_agent:
    agent_name: qa_agent
    display_name: 问答智能体
    enabled: true
    llm:
      provider: deepseek
      model_name: deepseek-chat
      temperature: 0.2
    tools:
      enabled_tools:
        - query_kg
        - semantic_search
    custom_params:
      type: react
      behavior:
        max_rounds: 10
        system_prompt: "你是一个知识图谱问答助手..."
```

### 3.2 如何添加新智能体

#### 方法：使用 ReActAgent 配置
通过配置文件定义智能体，无需编写代码：
1. 打开 `backend/agents/configs/agent_configs.yaml`。
2. 添加新的 entry，设置 `custom_params.type: react`。
3. 在 `custom_params.behavior` 中定义角色提示词和行为参数。

## 4. 智能体工作流

1. **初始化**: 系统启动时，`AgentLoader` 加载所有启用的智能体。
2. **请求接收**: API 接收用户请求 `/api/agent/execute`。
3. **路由**: 请求被转发给 `MasterAgent`。
4. **分析**: `MasterAgent` 分析任务：
   - **简单任务**: 直接调用相关智能体（如 QAAgent）。
   - **复杂任务**: 分解为多个子步骤，依次调度不同智能体。
5. **执行**: 目标智能体执行 `execute()`，可能调用工具（Tools）或 LLM。
6. **响应**: 结果返回给 `MasterAgent` 整合，最终返回给用户。

## 5. 目录结构说明

```
backend/agents/
├── agent_loader.py       # 智能体加载器
├── config_manager.py     # 配置管理器
├── base.py               # 基础类定义
├── master_agent.py       # 主智能体实现
├── qa_agent.py           # 问答智能体实现
├── generic_agent.py      # 通用智能体实现
├── orchestrator.py       # 编排器
├── registry.py           # 注册表
└── configs/              # 配置文件目录
    └── agent_configs.yaml
```
