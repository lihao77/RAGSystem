# RAGSystem 文档地图

## 📍 文档位置一览

```
RAGSystem/
│
├── README.md ⭐                          # 项目主页
├── PROJECT_STRUCTURE.md ⭐              # 项目结构说明
├── QUICK_REFERENCE.md                   # 快速参考
├── CLAUDE.md                            # AI 协作说明
│
├── docs/                                # 文档中心
│   ├── README.md ⭐                     # 文档导航
│   ├── DOCUMENTATION_MAP.md            # 本文件 - 文档地图
│   ├── configuration-guide.md          # 配置系统指南
│   ├── migration/                      # 迁移指南
│   │   ├── README.md
│   │   ├── VECTOR_STORE_MIGRATION.md
│   │   └── LLMADAPTER_MIGRATION_GUIDE.md
│   └── node-config-ui/                 # 节点配置UI文档
│       ├── README.md ⭐
│       ├── QUICK_START_CONFIG_UI.md ⭐
│       ├── NODE_CONFIG_SUMMARY.md
│       ├── NODE_CONFIG_UI_UPGRADE.md
│       ├── NODE_CONFIG_COMPARISON.md
│       ├── NODE_CONFIG_CHANGELOG.md
│       └── NODE_CONFIG_CHECKLIST.md
│
├── backend/agents/docs/                 # 智能体文档
│   ├── architecture/                    # 架构设计
│   │   ├── SYSTEM_DESIGN.md
│   │   ├── UNIFIED_ENTRY.md
│   │   └── MULTI_AGENT_SUMMARY.md
│   ├── guides/                          # 使用与配置指南
│   │   ├── CONFIGURATION.md
│   │   ├── MASTER_AGENT_USAGE.md
│   │   └── USAGE_GUIDE.md
│   ├── advanced/                        # 高级主题
│   │   ├── CONTEXT_MANAGEMENT.md
│   │   └── MASTER_CONTEXT_CONFIG.md
│   ├── event-bus/                       # 事件总线
│   │   ├── README.md
│   │   ├── EVENT_BUS_INTEGRATION_GUIDE.md
│   │   └── SESSION_EVENT_BUS_GUIDE.md
│   └── ... (AGENT_*, 升级总结等)
│
├── backend/agents/skills/               # Skills 系统文档
│   ├── README.md
│   ├── USAGE_EXAMPLES.md
│   ├── SKILL_DEPENDENCY_ISOLATION.md
│   └── SKILLS_PERMISSION_CONTROL.md
│
├── backend/model_adapter/               # ModelAdapter 文档
│   └── README.md
│
├── backend/vector_store/                # 向量存储文档
│   └── （配合 docs/migration/VECTOR_STORE_MIGRATION.md 使用）
│
└── backend/nodes/                       # 节点系统代码
    ├── CONFIG_UI_GUIDE.md ⭐            # 配置UI使用指南
    └── UI_METADATA_REFERENCE.md ⭐      # UI元数据快速参考
```

## 🎯 按角色查找文档

### 👤 新用户
**目标：快速了解和使用系统**

1. [README.md](../README.md) - 了解系统概述
2. [快速启动指南](node-config-ui/QUICK_START_CONFIG_UI.md) - 5分钟上手
3. [升级前后对比](node-config-ui/NODE_CONFIG_COMPARISON.md) - 了解新功能

### 👨‍💻 开发者
**目标：开发和扩展节点**

1. [项目结构](../PROJECT_STRUCTURE.md) - 了解代码组织
2. [节点配置UI文档](node-config-ui/README.md) - 了解架构
3. [配置UI使用指南](../backend/nodes/CONFIG_UI_GUIDE.md) - 学习开发
4. [UI元数据参考](../backend/nodes/UI_METADATA_REFERENCE.md) - 快速查阅

### 🔧 维护者
**目标：维护和更新系统**

1. [升级总结](node-config-ui/NODE_CONFIG_SUMMARY.md) - 了解全貌
2. [检查清单](node-config-ui/NODE_CONFIG_CHECKLIST.md) - 验证完整性
3. [更新日志](node-config-ui/NODE_CONFIG_CHANGELOG.md) - 追踪变更
4. [完整升级说明](node-config-ui/NODE_CONFIG_UI_UPGRADE.md) - 技术细节

### 📖 文档编写者
**目标：编写和更新文档**

1. [文档中心](README.md) - 了解文档结构
2. [文档地图](DOCUMENTATION_MAP.md) - 本文件
3. [项目结构](../PROJECT_STRUCTURE.md) - 了解代码结构

## 🔍 按主题查找文档

### 节点系统
| 主题 | 文档 | 位置 |
|------|------|------|
| 节点配置UI概述 | [README](node-config-ui/README.md) | docs/node-config-ui/ |
| 快速启动 | [QUICK_START](node-config-ui/QUICK_START_CONFIG_UI.md) | docs/node-config-ui/ |
| 开发指南 | [CONFIG_UI_GUIDE](../backend/nodes/CONFIG_UI_GUIDE.md) | backend/nodes/ |
| 快速参考 | [UI_METADATA_REFERENCE](../backend/nodes/UI_METADATA_REFERENCE.md) | backend/nodes/ |

### 智能体系统 & Skills
| 主题 | 文档 | 位置 |
|------|------|------|
| Agent 系统总览 | [AGENT_SYSTEM_DESIGN](../backend/agents/docs/AGENT_SYSTEM_DESIGN.md) | backend/agents/docs/ |
| 统一入口架构 | [UNIFIED_ENTRY](../backend/agents/docs/architecture/UNIFIED_ENTRY.md) | backend/agents/docs/architecture/ |
| Agent 配置与管理 | [AGENT_CONFIG_GUIDE](../backend/agents/docs/AGENT_CONFIG_GUIDE.md) | backend/agents/docs/ |
| 权限控制 | [PERMISSIONS](../backend/agents/docs/guides/PERMISSIONS.md) | backend/agents/docs/guides/ |
| 错误处理 | [ERROR_HANDLING](../backend/agents/docs/guides/ERROR_HANDLING.md) | backend/agents/docs/guides/ |
| 可观测性 | [OBSERVABILITY](../backend/agents/docs/guides/OBSERVABILITY.md) | backend/agents/docs/guides/ |
| Skills 总览 | [Skills README](../backend/agents/skills/README.md) | backend/agents/skills/ |
| Skills 依赖隔离 | [SKILL_DEPENDENCY_ISOLATION](../backend/agents/skills/SKILL_DEPENDENCY_ISOLATION.md) | backend/agents/skills/ |

### 模型与向量存储
| 主题 | 文档 | 位置 |
|------|------|------|
| ModelAdapter 使用指南 | [ModelAdapter README](../backend/model_adapter/README.md) | backend/model_adapter/ |
| 向量存储迁移 | [VECTOR_STORE_MIGRATION](migration/VECTOR_STORE_MIGRATION.md) | docs/migration/ |
| 向量化器配置 | `backend/vector_store/vectorizer_config.py` | backend/vector_store/ |

### 项目信息
| 主题 | 文档 | 位置 |
|------|------|------|
| 项目概述 | [README](../README.md) | 根目录 |
| 项目结构 | [PROJECT_STRUCTURE](../PROJECT_STRUCTURE.md) | 根目录 |
| 文档导航 | [docs/README](README.md) | docs/ |

### 配置与迁移
| 主题 | 文档 | 位置 |
|------|------|------|
| 配置系统指南 | [configuration-guide](configuration-guide.md) | docs/ |
| 迁移指南索引 | [migration/README](migration/README.md) | docs/migration/ |
| 向量存储迁移 | [VECTOR_STORE_MIGRATION](migration/VECTOR_STORE_MIGRATION.md) | docs/migration/ |
| ModelAdapter 历史迁移 | [LLMADAPTER_MIGRATION_GUIDE](migration/LLMADAPTER_MIGRATION_GUIDE.md) | docs/migration/ |

### 更新信息
| 主题 | 文档 | 位置 |
|------|------|------|
| 升级总结 | [SUMMARY](node-config-ui/NODE_CONFIG_SUMMARY.md) | docs/node-config-ui/ |
| 更新日志 | [CHANGELOG](node-config-ui/NODE_CONFIG_CHANGELOG.md) | docs/node-config-ui/ |
| 升级对比 | [COMPARISON](node-config-ui/NODE_CONFIG_COMPARISON.md) | docs/node-config-ui/ |

### 技术细节
| 主题 | 文档 | 位置 |
|------|------|------|
| 架构边界与路线图 | [ARCHITECTURE_BOUNDARIES](ARCHITECTURE_BOUNDARIES.md) | docs/ |
| P3 执行平面设计 | [P3_EXECUTION_LAYER_DESIGN](P3_EXECUTION_LAYER_DESIGN.md) | docs/ |
| P3 执行平面实施清单 | [P3_EXECUTION_LAYER_CHECKLIST](P3_EXECUTION_LAYER_CHECKLIST.md) | docs/ |
| 完整升级说明 | [UPGRADE](node-config-ui/NODE_CONFIG_UI_UPGRADE.md) | docs/node-config-ui/ |
| 检查清单 | [CHECKLIST](node-config-ui/NODE_CONFIG_CHECKLIST.md) | docs/node-config-ui/ |

## 📖 推荐阅读顺序

### 路径1：快速上手（15分钟）
```
1. README.md (5分钟)
   ↓
2. QUICK_START_CONFIG_UI.md (5分钟)
   ↓
3. NODE_CONFIG_COMPARISON.md (5分钟)
```

### 路径2：深入了解（1小时）
```
1. README.md (5分钟)
   ↓
2. PROJECT_STRUCTURE.md (10分钟)
   ↓
3. node-config-ui/README.md (15分钟)
   ↓
4. CONFIG_UI_GUIDE.md (20分钟)
   ↓
5. NODE_CONFIG_SUMMARY.md (10分钟)
```

### 路径3：开发节点（2小时）
```
1. PROJECT_STRUCTURE.md (10分钟)
   ↓
2. node-config-ui/README.md (15分钟)
   ↓
3. CONFIG_UI_GUIDE.md (30分钟)
   ↓
4. UI_METADATA_REFERENCE.md (15分钟)
   ↓
5. 查看示例代码 (30分钟)
   - backend/nodes/llmjson_v2/config.py
   - backend/nodes/llmjson/config.py
   ↓
6. 实践开发 (20分钟)
```

## 🔗 文档关系图

```
                    README.md (项目主页)
                         │
        ┌────────────────┼────────────────┐
        │                │                │
PROJECT_STRUCTURE    docs/README    其他文档
        │            (文档中心)
        │                │
        │         ┌──────┴──────┐
        │         │             │
        │   node-config-ui/     │
        │         │             │
        │         │
        │    ┌────┴────┐
        │    │         │
        │  README   QUICK_START
        │    │         │
        │    ├─────────┤
        │    │         │
        │  SUMMARY  COMPARISON
        │    │         │
        │    ├─────────┤
        │    │         │
        │  UPGRADE  CHANGELOG
        │    │         │
        │    └─────────┘
        │         │
        └─────────┴─────────┐
                            │
                    backend/nodes/
                            │
                    ┌───────┴───────┐
                    │               │
            CONFIG_UI_GUIDE  UI_METADATA
                                REFERENCE
```

## 📊 文档统计

### 按类型
- **导航文档**: 3个 (README, docs/README, node-config-ui/README)
- **快速启动**: 1个 (QUICK_START_CONFIG_UI)
- **开发指南**: 2个 (CONFIG_UI_GUIDE, UI_METADATA_REFERENCE)
- **项目信息**: 1个 (PROJECT_STRUCTURE)
- **更新信息**: 3个 (SUMMARY, CHANGELOG, COMPARISON)
- **技术文档**: 2个 (UPGRADE, CHECKLIST)

### 按位置
- **根目录**: 2个
- **docs/**: 2个
- **docs/node-config-ui/**: 5个
- **backend/nodes/**: 2个

### 总计
- **文档文件**: 11个
- **总字数**: 约25000字
- **覆盖率**: 100%

## 🎯 文档维护

### 更新频率
- **README.md** - 每次重大更新
- **CHANGELOG.md** - 每次功能更新
- **QUICK_START** - 功能变化时
- **开发指南** - API变化时

### 维护原则
1. 保持文档同步
2. 及时更新链接
3. 定期检查准确性
4. 收集用户反馈

## 💡 使用技巧

### 快速查找
1. 使用Ctrl+F搜索关键词
2. 查看文档地图（本文件）
3. 从文档中心开始导航

### 离线阅读
所有文档都是Markdown格式，可以：
1. 使用任何Markdown阅读器
2. 在IDE中直接查看
3. 转换为PDF保存

### 贡献文档
1. 遵循现有文档结构
2. 使用清晰的标题层级
3. 添加必要的链接
4. 更新文档地图

---

**文档地图版本**: v1.0  
**最后更新**: 2025-12-26  
**维护者**: RAGSystem Team  

🗺️ **使用文档地图，快速找到所需文档！**
