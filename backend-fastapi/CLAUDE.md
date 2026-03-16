# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 架构文档（开发前必读）

在修改代码前，先阅读对应的架构文档以避免重复探索：

| 文档 | 路径 | 内容 |
|------|------|------|
| 后端架构 | `docs/architecture.md` | Agent 体系、占位符系统、事件系统、上下文管理、配置、Skills、API 路由 |
| 工具系统 | `docs/tools.md` | 工具注册链路、执行流程、数据模型、工具清单、Artifact 流程 |
| 前端架构 | `../frontend-client/docs/architecture.md` | SSE 通信、消息结构、可视化渲染、态势大屏、会话管理 |

**重要：修改系统代码后，必须同步更新对应的架构文档。**

## 项目概述

基于 FastAPI 的多智能体协作后端，采用 ReAct 模式的 OrchestratorAgent 动态编排子 Agent，支持 MCP、SSE 流式执行、向量检索和 Skills 系统。

## 启动和运行

```bash
pip install -r requirements.txt
python main.py
# 或
uvicorn main:app --host 0.0.0.0 --port 5001 --reload --reload-exclude agents/skills --reload-exclude **/.venv/**
```

环境变量从 `.env` 加载（参考 `.env.example`）。

## 测试

```bash
pytest agents/tests/
pytest agents/tests/test_core/test_base.py
```

## 新增 Agent

1. `agents/implementations/<name>/agent.py` — 继承 `BaseAgent`，实现 `execute()` + `can_handle()`
2. `agents/core/registry.py` — 注册
3. `agents/configs/agent_configs.yaml` — 添加配置
4. 更新 `docs/architecture.md`

## 新增工具

详见 `docs/tools.md` 中的「新增工具 5 步注册链路」。

## 新增 LLM Provider

1. `integrations/model_providers/` — 创建 Provider 类
2. `model_adapter/configs/providers.yaml` — 添加配置
3. 更新 `docs/architecture.md`
