# 文档清理报告

生成时间：2026-02-23 20:24:55

## 一、已删除文档（2 个）

- ❌ `MASTER_AGENT_GUIDE.md` - 已完全过期，无保留价值
- ❌ `PLUGIN_GUIDE.md` - 已完全过期，无保留价值

## 二、已归档文档（4 个）

- 📦 `UNIFIED_ENTRY_ARCHITECTURE.md` -> `archive/UNIFIED_ENTRY_ARCHITECTURE.md` - 有历史价值，已归档
- 📦 `MULTI_AGENT_ARCHITECTURE_SUMMARY.md` -> `archive/MULTI_AGENT_ARCHITECTURE_SUMMARY.md` - 有历史价值，已归档
- 📦 `MASTER_AGENT_CONTEXT_CONFIG.md` -> `archive/MASTER_AGENT_CONTEXT_CONFIG.md` - 有历史价值，已归档
- 📦 `SMART_CONTEXT_MANAGEMENT.md` -> `archive/SMART_CONTEXT_MANAGEMENT.md` - 有历史价值，已归档

## 三、需要手动更新的文档（3 个）


### AGENT_SYSTEM_DESIGN.md

- **原因**：需要更新架构图，移除 V1 相关内容
- **操作**：手动更新

### USAGE_GUIDE.md

- **原因**：需要更新使用示例，使用 V2 API
- **操作**：手动更新

### AGENT_CONFIG_GUIDE.md

- **原因**：需要更新配置示例，添加新字段说明
- **操作**：手动更新

## 四、文档结构（更新后）

```
backend/agents/docs/
├── README.md                    # 文档索引
├── AGENT_CONFIG_GUIDE.md        # 配置指南（需更新）
├── AGENT_SYSTEM_DESIGN.md       # 系统设计（需更新）
├── USAGE_GUIDE.md               # 使用指南（需更新）
├── architecture/                # 架构设计
│   ├── SYSTEM_DESIGN.md
│   ├── UNIFIED_ENTRY.md
│   └── MULTI_AGENT_SUMMARY.md
├── guides/                      # 使用指南
│   ├── CONFIGURATION.md
│   ├── PLUGIN_DEVELOPMENT.md
│   ├── MASTER_AGENT_USAGE.md
│   └── USAGE_GUIDE.md
├── advanced/                    # 高级主题
│   ├── CONTEXT_MANAGEMENT.md
│   └── MASTER_CONTEXT_CONFIG.md
├── event-bus/                   # 事件总线
│   ├── SESSION_EVENT_BUS_GUIDE.md
│   └── EVENT_BUS_INTEGRATION_GUIDE.md
└── archive/                     # 归档文档
    ├── README.md
    ├── UNIFIED_ENTRY_ARCHITECTURE.md
    ├── MULTI_AGENT_ARCHITECTURE_SUMMARY.md
    ├── MASTER_AGENT_CONTEXT_CONFIG.md
    └── SMART_CONTEXT_MANAGEMENT.md
```

## 五、后续操作

### 1. 手动更新文档

请按照"三、需要手动更新的文档"部分的说明，逐个更新文档内容。

### 2. 更新 CLAUDE.md

在 `CLAUDE.md` 中更新文档引用：

```markdown
### 智能体系统
- **系统设计**: `backend/agents/docs/architecture/SYSTEM_DESIGN.md`
- **统一入口架构**: `backend/agents/docs/architecture/UNIFIED_ENTRY.md`
- **配置指南**: `backend/agents/docs/AGENT_CONFIG_GUIDE.md`
- **使用指南**: `backend/agents/docs/USAGE_GUIDE.md`
```

### 3. 验证文档链接

运行以下命令检查文档中的链接是否有效：

```bash
# 检查所有 Markdown 文件中的链接
find backend/agents/docs -name "*.md" -exec grep -H "\[.*\](.*\.md)" {} \;
```

### 4. 提交更改

```bash
git add backend/agents/docs/
git commit -m "docs(agents): 清理过期文档，归档历史文档"
```

## 六、注意事项

1. **归档文档不要删除**：虽然已过期，但有历史参考价值
2. **更新文档链接**：确保其他文档中的链接指向正确位置
3. **保持文档同步**：代码变更时及时更新文档
4. **定期审查**：每季度审查一次文档，清理过期内容
