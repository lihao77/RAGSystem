# RAGSystem 文档中心

欢迎来到 RAGSystem 文档中心！这里包含系统的所有文档。

## 📚 文档导航

### 配置与迁移
- **[配置系统指南](configuration-guide.md)** - 后端配置、首次部署、健康检查
- **[迁移指南](migration/README.md)** - 向量存储与 ModelAdapter 历史迁移文档
  - [向量存储迁移](migration/VECTOR_STORE_MIGRATION.md) - ChromaDB → SQLite-vec
  - [ModelAdapter 历史迁移](migration/LLMADAPTER_MIGRATION_GUIDE.md) - LLMService / LLMAdapter → ModelAdapter（历史说明）

### 节点系统
- **[节点配置UI文档](node-config-ui/README.md)** - 节点配置界面升级完整文档
  - [快速启动指南](node-config-ui/QUICK_START_CONFIG_UI.md) - 5分钟快速上手
  - [升级总结](node-config-ui/NODE_CONFIG_SUMMARY.md) - 了解升级全貌
  - [升级前后对比](node-config-ui/NODE_CONFIG_COMPARISON.md) - 详细对比
  - [更新日志](node-config-ui/NODE_CONFIG_CHANGELOG.md) - 查看所有更新

### 后端开发
- **[架构边界与路线图](ARCHITECTURE_BOUNDARIES.md)** - 分层规则、运行时入口和重构优先级
- **[P4 Execution Observability Routes](P4_OBSERVABILITY_ROUTES.md)** - execution 查询接口、diagnostics 与 overview 契约
- **[P3 执行平面设计](P3_EXECUTION_LAYER_DESIGN.md)** - 进程内最小 execution layer 设计草案
- **[P3 执行平面实施清单](P3_EXECUTION_LAYER_CHECKLIST.md)** - 按阶段推进的实施与验收 checklist
- **[节点配置UI使用指南](../backend/nodes/CONFIG_UI_GUIDE.md)** - 详细的节点开发指南
- **[UI元数据快速参考](../backend/nodes/UI_METADATA_REFERENCE.md)** - 节点配置元数据速查

### 智能体系统 & Skills
- **[Agent 系统总览](../backend/agents/docs/AGENT_SYSTEM_DESIGN.md)** - MasterAgent + ReActAgent 架构说明
- **[统一入口架构](../backend/agents/docs/architecture/UNIFIED_ENTRY.md)** - MasterAgent 统一入口设计
- **[Agent 配置指南](../backend/agents/docs/AGENT_CONFIG_GUIDE.md)** - `agent_configs.yaml` 配置说明
- **[权限控制指南](../backend/agents/docs/guides/PERMISSIONS.md)** - 工具风险等级与用户审批
- **[错误处理指南](../backend/agents/docs/guides/ERROR_HANDLING.md)** - 重试、错误分类与恢复
- **[可观测性指南](../backend/agents/docs/guides/OBSERVABILITY.md)** - 指标收集与监控 API
- **[Skills 系统概览](../backend/agents/skills/README.md)** - Skills 架构与使用方式
- **[Skills 依赖隔离指南](../backend/agents/skills/SKILL_DEPENDENCY_ISOLATION.md)** - 每个 Skill 独立虚拟环境

## 🎯 快速链接

### 新手入门
1. [系统README](../README.md) - 系统概述和快速启动
2. [节点配置快速启动](node-config-ui/QUICK_START_CONFIG_UI.md) - 5分钟上手节点配置

### 开发者
1. [节点配置UI完整文档](node-config-ui/README.md) - 技术实现和使用指南
2. [UI元数据参考](../backend/nodes/UI_METADATA_REFERENCE.md) - 快速查阅配置选项

### 用户
1. [节点配置对比](node-config-ui/NODE_CONFIG_COMPARISON.md) - 了解新旧界面差异
2. [更新日志](node-config-ui/NODE_CONFIG_CHANGELOG.md) - 查看最新功能

## 📁 文档结构

```
docs/
├── README.md                    # 本文件 - 文档中心导航
├── DOCUMENTATION_MAP.md         # 文档地图
├── configuration-guide.md       # 配置系统指南
├── ARCHITECTURE_BOUNDARIES.md   # 架构边界与演进路线图
├── P3_EXECUTION_LAYER_DESIGN.md # P3 执行平面设计文档
├── P3_EXECUTION_LAYER_CHECKLIST.md # P3 执行平面实施清单
├── BACKEND_CONFIG_SURVEY.md    # 后端配置调查报告
├── FILE_SYSTEM_INTEGRATION.md   # 文件系统集成
├── migration/                  # 迁移指南
│   ├── README.md
│   ├── VECTOR_STORE_MIGRATION.md
│   └── LLMADAPTER_MIGRATION_GUIDE.md
└── node-config-ui/             # 节点配置UI文档
    ├── README.md
    ├── QUICK_START_CONFIG_UI.md
    ├── NODE_CONFIG_SUMMARY.md
    ├── NODE_CONFIG_UI_UPGRADE.md
    ├── NODE_CONFIG_COMPARISON.md
    ├── NODE_CONFIG_CHANGELOG.md
    └── NODE_CONFIG_CHECKLIST.md

backend/agents/docs/             # 智能体与事件总线文档
├── architecture/
│   ├── SYSTEM_DESIGN.md
│   ├── UNIFIED_ENTRY.md
│   └── MULTI_AGENT_SUMMARY.md
├── guides/
│   ├── CONFIGURATION.md
│   ├── MASTER_AGENT_USAGE.md
│   ├── USAGE_GUIDE.md
│   ├── PERMISSIONS.md
│   ├── ERROR_HANDLING.md
│   └── OBSERVABILITY.md
├── advanced/
│   ├── CONTEXT_MANAGEMENT.md
│   └── MASTER_CONTEXT_CONFIG.md
├── event-bus/
│   ├── README.md
│   ├── EVENT_BUS_INTEGRATION_GUIDE.md
│   └── SESSION_EVENT_BUS_GUIDE.md
└── ... (AGENT_* 升级总结等)

backend/agents/skills/           # Skills 系统文档
├── README.md
├── USAGE_EXAMPLES.md
├── SKILL_DEPENDENCY_ISOLATION.md
└── SKILLS_PERMISSION_CONTROL.md

backend/nodes/
├── CONFIG_UI_GUIDE.md           # 节点配置 UI 使用指南
└── UI_METADATA_REFERENCE.md     # UI 元数据参考
```

## 🔍 按主题查找

### 节点系统
- 节点配置界面升级 → [node-config-ui/README.md](node-config-ui/README.md)
- 如何为节点添加UI元数据 → [../backend/nodes/CONFIG_UI_GUIDE.md](../backend/nodes/CONFIG_UI_GUIDE.md)
- UI元数据配置选项 → [../backend/nodes/UI_METADATA_REFERENCE.md](../backend/nodes/UI_METADATA_REFERENCE.md)

### 快速上手
- 5分钟快速启动 → [node-config-ui/QUICK_START_CONFIG_UI.md](node-config-ui/QUICK_START_CONFIG_UI.md)
- 系统快速启动 → [../README.md](../README.md)

### 了解更新
- 节点配置UI更新 → [node-config-ui/NODE_CONFIG_CHANGELOG.md](node-config-ui/NODE_CONFIG_CHANGELOG.md)
- 升级前后对比 → [node-config-ui/NODE_CONFIG_COMPARISON.md](node-config-ui/NODE_CONFIG_COMPARISON.md)

## 💡 推荐阅读路径

### 路径1：新用户
1. [系统README](../README.md) - 了解系统
2. [节点配置快速启动](node-config-ui/QUICK_START_CONFIG_UI.md) - 体验新功能
3. [升级前后对比](node-config-ui/NODE_CONFIG_COMPARISON.md) - 了解改进

### 路径2：开发者
1. [节点配置UI文档](node-config-ui/README.md) - 了解架构
2. [配置UI使用指南](../backend/nodes/CONFIG_UI_GUIDE.md) - 学习开发
3. [UI元数据参考](../backend/nodes/UI_METADATA_REFERENCE.md) - 快速查阅

### 路径3：维护者
1. [升级总结](node-config-ui/NODE_CONFIG_SUMMARY.md) - 了解全貌
2. [检查清单](node-config-ui/NODE_CONFIG_CHECKLIST.md) - 验证完整性
3. [更新日志](node-config-ui/NODE_CONFIG_CHANGELOG.md) - 追踪变更

##  最新更新

### 2025-12-26 - 节点配置UI升级
- ✅ 智能表单生成
- ✅ 字段分组展示
- ✅ 实时验证
- ✅ 双视图模式
- ✅ 4个节点完成适配

查看详情：[节点配置UI文档](node-config-ui/README.md)

## 📞 获取帮助

1. **查看文档** - 使用上方导航查找相关文档
2. **快速搜索** - 使用Ctrl+F搜索关键词
3. **查看示例** - 参考已适配节点的配置代码

---

**文档版本**: v1.0  
**最后更新**: 2025-12-26  
**维护者**: RAGSystem Team  

🚀 **开始探索文档吧！**
