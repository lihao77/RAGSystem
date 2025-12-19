# RAGSystem 文档和测试文件清理计划

## 📋 清理目标

合并重复文档，删除过时测试文件，保持项目整洁。

---

## ✅ 保留文件

### 核心文档（根目录）
- ✅ `README.md` - 项目简介（必须保留）
- ✅ `CLAUDE.md` - AI 助手指南（必须保留）
- ✅ `DEVELOPMENT_GUIDE.md` - **新建整合文档**（包含所有关键信息）

### 后端文档
- ✅ `backend/README.md` - 后端说明
- ✅ `backend/config/README.md` - 配置系统详解
- ✅ `backend/tools/README.md` - 工具调用指南
- ✅ `backend/scripts/README.md` - 脚本说明

### 前端文档
- ✅ `frontend/README.md` - 前端说明
- ✅ `frontend/CONFIG_CHECK_GUIDE.md` - 配置检查使用指南

---

## 🗑️ 删除文件

### 根目录（已整合到 DEVELOPMENT_GUIDE.md）
- ❌ `ARCHITECTURE.md` - 内容已整合
- ❌ `EMBEDDING_GUIDE.md` - 内容已整合
- ❌ `INIT_REFACTOR.md` - 内容已整合
- ❌ `NODESVIEW_ENHANCEMENT.md` - 特定功能文档，已过时
- ❌ `NODE_TYPE_STANDARDS.md` - 内容已整合
- ❌ `UPGRADE_PLAN.md` - 临时文档，已完成
- ❌ `UPGRADE_PROGRESS.md` - 临时文档，已完成
- ❌ `VECTOR_INDEXING_GUIDE.md` - 内容已整合

### 后端文档
- ❌ `backend/FLASK_RELOADER_ISSUE.md` - 问题已解决，内容已整合
- ❌ `backend/CHART_AGENT_USAGE.md` - 特定功能文档
- ❌ `backend/SYSTEM_PROMPT_OPTIMIZATION.md` - 临时文档
- ❌ `backend/graph_overview.md` - 过时文档
- ❌ `backend/INSTALL.md` - 内容已整合到主文档

### 前端文档
- ❌ `frontend/CONFIG_CACHE_FIX.md` - 问题修复文档，内容已整合

### 测试文件（临时测试，可删除）
- ❌ `backend/test_chart_agent.py`
- ❌ `backend/test_chart_workflow.py`
- ❌ `backend/test_config_env2.py`
- ❌ `backend/test_embedding_config.py`
- ❌ `backend/test_embedding_models.py`
- ❌ `backend/test_function_calling.py`
- ❌ `backend/test_graphrag_cypher.py`
- ❌ `backend/test_lazy_init.py`
- ❌ `backend/test_nodes.py`
- ❌ `backend/test_similarity_fix.py`
- ❌ `backend/test_vector_indexer_node.py`
- ❌ `backend/test_vector_similarity.py`

---

## 📝 删除原因

### 文档类

1. **ARCHITECTURE.md** → 整合到 DEVELOPMENT_GUIDE.md 的"系统架构"章节
2. **EMBEDDING_GUIDE.md** → 整合到"配置系统"和"向量库使用"章节
3. **INIT_REFACTOR.md** → 整合到"初始化系统"章节
4. **NODESVIEW_ENHANCEMENT.md** → 特定功能优化，已完成，不需要长期保留
5. **NODE_TYPE_STANDARDS.md** → 整合到"节点系统"章节
6. **UPGRADE_PLAN.md** → 升级计划已完成，不需要保留
7. **UPGRADE_PROGRESS.md** → 升级进度追踪，已完成
8. **VECTOR_INDEXING_GUIDE.md** → 整合到"向量库使用"章节
9. **FLASK_RELOADER_ISSUE.md** → 问题已解决，解决方案已整合
10. **CONFIG_CACHE_FIX.md** → 问题已修复，解决方案已整合

### 测试文件

所有 `test_*.py` 文件都是临时测试文件，用于开发调试：
- 不是正式的单元测试
- 不在 CI/CD 流程中
- 功能已验证完成
- 保留会增加混乱

---

## 🔧 清理脚本

```bash
#!/bin/bash
# cleanup.sh - 清理不必要的文档和测试文件

echo "开始清理 RAGSystem 项目..."

# 根目录文档
cd /mnt/e/Python/RAGSystem
rm -f ARCHITECTURE.md
rm -f EMBEDDING_GUIDE.md
rm -f INIT_REFACTOR.md
rm -f NODESVIEW_ENHANCEMENT.md
rm -f NODE_TYPE_STANDARDS.md
rm -f UPGRADE_PLAN.md
rm -f UPGRADE_PROGRESS.md
rm -f VECTOR_INDEXING_GUIDE.md

echo "✓ 根目录文档清理完成"

# 后端文档
cd backend
rm -f FLASK_RELOADER_ISSUE.md
rm -f CHART_AGENT_USAGE.md
rm -f SYSTEM_PROMPT_OPTIMIZATION.md
rm -f graph_overview.md
rm -f INSTALL.md

echo "✓ 后端文档清理完成"

# 前端文档
cd ../frontend
rm -f CONFIG_CACHE_FIX.md

echo "✓ 前端文档清理完成"

# 测试文件
cd ../backend
rm -f test_chart_agent.py
rm -f test_chart_workflow.py
rm -f test_config_env2.py
rm -f test_embedding_config.py
rm -f test_embedding_models.py
rm -f test_function_calling.py
rm -f test_graphrag_cypher.py
rm -f test_lazy_init.py
rm -f test_nodes.py
rm -f test_similarity_fix.py
rm -f test_vector_indexer_node.py
rm -f test_vector_similarity.py

echo "✓ 测试文件清理完成"

cd ..
echo ""
echo "==============================================="
echo "清理完成！"
echo "==============================================="
echo ""
echo "保留的文档："
echo "  - README.md (项目简介)"
echo "  - CLAUDE.md (AI 助手指南)"
echo "  - DEVELOPMENT_GUIDE.md (开发指南)"
echo "  - backend/README.md"
echo "  - backend/config/README.md"
echo "  - backend/tools/README.md"
echo "  - frontend/README.md"
echo "  - frontend/CONFIG_CHECK_GUIDE.md"
echo ""
echo "已删除："
echo "  - 8 个根目录文档"
echo "  - 5 个后端文档"
echo "  - 1 个前端文档"
echo "  - 12 个测试文件"
echo ""
```

---

## 📊 清理统计

### 删除前
- 根目录文档: 10 个
- 后端文档: 8 个
- 前端文档: 3 个
- 测试文件: 12 个
- **总计: 33 个文件**

### 删除后
- 根目录文档: 3 个（保留核心）
- 后端文档: 4 个（保留必要）
- 前端文档: 2 个（保留使用指南）
- 测试文件: 0 个（全部清理）
- **总计: 9 个文件**

**减少: 24 个文件（73% 减少）**

---

## 🎯 清理后的文档结构

```
RAGSystem/
├── README.md                        ← 项目简介
├── CLAUDE.md                        ← AI 助手指南
├── DEVELOPMENT_GUIDE.md             ← 开发指南（新增，整合所有关键信息）
├── backend/
│   ├── README.md                    ← 后端说明
│   ├── config/
│   │   └── README.md                ← 配置系统详解
│   ├── tools/
│   │   └── README.md                ← 工具调用指南
│   └── scripts/
│       └── README.md                ← 脚本说明
└── frontend/
    ├── README.md                    ← 前端说明
    └── CONFIG_CHECK_GUIDE.md        ← 配置检查使用指南
```

---

## ⚠️ 执行前注意

1. **备份重要信息**：虽然内容已整合，建议先备份
2. **确认不再需要**：确保被删除的文档不包含未整合的关键信息
3. **团队通知**：通知团队成员文档结构变更

---

## 🚀 执行清理

```bash
# 方法1：手动执行（推荐）
# 逐个检查并删除文件

# 方法2：使用脚本（快速）
chmod +x cleanup.sh
./cleanup.sh

# 方法3：Git 中删除
git rm ARCHITECTURE.md EMBEDDING_GUIDE.md ...
git commit -m "docs: 清理和整合文档"
```

---

**准备执行**: 是 ☐ / 否 ☐  
**备份完成**: 是 ☐ / 否 ☐  
**团队通知**: 是 ☐ / 否 ☐
