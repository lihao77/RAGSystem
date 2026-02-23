#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
清理过期文档脚本

用途：
1. 删除已废弃的文档
2. 移动重复文档到归档目录
3. 生成文档清理报告
"""

import os
import shutil
from pathlib import Path
from datetime import datetime

# 项目根目录
ROOT_DIR = Path(__file__).parent
DOCS_DIR = ROOT_DIR / "backend" / "agents" / "docs"
ARCHIVE_DIR = DOCS_DIR / "archive"

# 需要删除的文档（已完全过期）
DOCS_TO_DELETE = [
    # 这些文档描述的是已删除的 MasterAgent V1 架构
    "MASTER_AGENT_GUIDE.md",           # V1 使用指南（已被 guides/MASTER_AGENT_USAGE.md 替代）
    "PLUGIN_GUIDE.md",                 # 插件指南（已被 guides/PLUGIN_DEVELOPMENT.md 替代）
]

# 需要归档的文档（有历史价值但不再使用）
DOCS_TO_ARCHIVE = [
    "UNIFIED_ENTRY_ARCHITECTURE.md",   # 统一入口架构（已被 architecture/UNIFIED_ENTRY.md 替代）
    "MULTI_AGENT_ARCHITECTURE_SUMMARY.md",  # 多智能体架构总结（已被 architecture/MULTI_AGENT_SUMMARY.md 替代）
    "MASTER_AGENT_CONTEXT_CONFIG.md",  # Master 上下文配置（已被 advanced/MASTER_CONTEXT_CONFIG.md 替代）
    "SMART_CONTEXT_MANAGEMENT.md",     # 智能上下文管理（已被 advanced/CONTEXT_MANAGEMENT.md 替代）
]

# 需要更新的文档（内容部分过期）
DOCS_TO_UPDATE = [
    {
        "file": "AGENT_SYSTEM_DESIGN.md",
        "reason": "需要更新架构图，移除 V1 相关内容",
        "action": "手动更新"
    },
    {
        "file": "USAGE_GUIDE.md",
        "reason": "需要更新使用示例，使用 V2 API",
        "action": "手动更新"
    },
    {
        "file": "AGENT_CONFIG_GUIDE.md",
        "reason": "需要更新配置示例，添加新字段说明",
        "action": "手动更新"
    }
]


def create_archive_dir():
    """创建归档目录"""
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    readme_path = ARCHIVE_DIR / "README.md"
    if not readme_path.exists():
        readme_path.write_text(
            f"""# 归档文档

此目录包含已过期但有历史价值的文档。

归档时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## 说明

这些文档描述的功能已被新版本替代，但保留用于：
1. 历史参考
2. 迁移指南
3. 架构演进记录

**请勿在新项目中使用这些文档。**
""",
            encoding="utf-8"
        )


def delete_docs():
    """删除过期文档"""
    deleted = []
    for doc in DOCS_TO_DELETE:
        doc_path = DOCS_DIR / doc
        if doc_path.exists():
            doc_path.unlink()
            deleted.append(doc)
            print(f"✅ 已删除: {doc}")
        else:
            print(f"⚠️  文件不存在: {doc}")
    return deleted


def archive_docs():
    """归档文档"""
    archived = []
    for doc in DOCS_TO_ARCHIVE:
        doc_path = DOCS_DIR / doc
        if doc_path.exists():
            archive_path = ARCHIVE_DIR / doc
            shutil.move(str(doc_path), str(archive_path))
            archived.append(doc)
            print(f"📦 已归档: {doc} -> archive/{doc}")
        else:
            print(f"⚠️  文件不存在: {doc}")
    return archived


def generate_report(deleted, archived):
    """生成清理报告"""
    report_path = ROOT_DIR / "docs_cleanup_report.md"

    report_content = f"""# 文档清理报告

生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## 一、已删除文档（{len(deleted)} 个）

"""

    if deleted:
        for doc in deleted:
            report_content += f"- ❌ `{doc}` - 已完全过期，无保留价值\n"
    else:
        report_content += "无\n"

    report_content += f"""
## 二、已归档文档（{len(archived)} 个）

"""

    if archived:
        for doc in archived:
            report_content += f"- 📦 `{doc}` -> `archive/{doc}` - 有历史价值，已归档\n"
    else:
        report_content += "无\n"

    report_content += f"""
## 三、需要手动更新的文档（{len(DOCS_TO_UPDATE)} 个）

"""

    for item in DOCS_TO_UPDATE:
        report_content += f"""
### {item['file']}

- **原因**：{item['reason']}
- **操作**：{item['action']}
"""

    report_content += """
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
find backend/agents/docs -name "*.md" -exec grep -H "\\[.*\\](.*\\.md)" {} \\;
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
"""

    report_path.write_text(report_content, encoding="utf-8")
    print(f"\n📄 清理报告已生成: {report_path}")


def main():
    """主函数"""
    print("=" * 60)
    print("智能体系统文档清理工具")
    print("=" * 60)
    print()

    # 确认操作
    print("⚠️  此操作将：")
    print(f"   1. 删除 {len(DOCS_TO_DELETE)} 个过期文档")
    print(f"   2. 归档 {len(DOCS_TO_ARCHIVE)} 个历史文档")
    print(f"   3. 标记 {len(DOCS_TO_UPDATE)} 个文档需要手动更新")
    print()

    response = input("是否继续？(y/N): ").strip().lower()
    if response != 'y':
        print("❌ 操作已取消")
        return

    print()
    print("开始清理...")
    print()

    # 创建归档目录
    create_archive_dir()

    # 删除过期文档
    print("1️⃣  删除过期文档...")
    deleted = delete_docs()
    print()

    # 归档文档
    print("2️⃣  归档历史文档...")
    archived = archive_docs()
    print()

    # 生成报告
    print("3️⃣  生成清理报告...")
    generate_report(deleted, archived)
    print()

    print("=" * 60)
    print("✅ 文档清理完成！")
    print("=" * 60)
    print()
    print("📋 后续操作：")
    print("   1. 查看清理报告: docs_cleanup_report.md")
    print("   2. 手动更新标记的文档")
    print("   3. 更新 CLAUDE.md 中的文档引用")
    print("   4. 提交更改到 Git")


if __name__ == "__main__":
    main()
