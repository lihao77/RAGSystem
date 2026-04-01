# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 工作定位

本文件只承担后端开发代理工作指引，不充当仓库正式文档目录。

开始修改代码前：
- 仓库级正式文档入口请先看 `../docs/README.md`
- 后端正式文档入口请先看 `docs/README.md`

## 必读文档（开发前先读）

在修改代码前，先阅读对应的正式文档以避免重复探索：

| 文档 | 路径 | 内容 |
|------|------|------|
| 后端文档入口 | `docs/README.md` | 后端文档导航、阅读顺序、维护约定 |
| 后端架构 | `docs/architecture.md` | Agent 体系、占位符系统、事件系统、上下文管理、配置、Skills、API 路由 |
| 工具系统 | `docs/tools.md` | tools 目录分层、工具注册、执行流程、权限、路径治理、Artifact 流程 |
| 前端文档入口 | `../frontend-client/docs/README.md` | 前端文档导航与维护约定 |
| 前端架构 | `../frontend-client/docs/architecture.md` | SSE 通信、消息结构、可视化渲染、态势大屏、会话管理 |

历史评估文档已归档到 `../docs/archive/backend-fastapi/architecture-review.md`，不再作为当前主线架构说明。

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

详见 `docs/tools.md` 中关于工具注册、执行流程与权限约束的对应章节。

## 新增 LLM Provider

1. `integrations/model_providers/` — 创建 Provider 类
2. `model_adapter/configs/providers.yaml` — 添加配置
3. 更新 `docs/architecture.md`
