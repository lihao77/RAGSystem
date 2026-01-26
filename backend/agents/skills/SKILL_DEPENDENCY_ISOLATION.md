# Skill 依赖隔离完全指南

## 🎯 问题背景

Skills 系统的脚本可能需要特定的 Python 依赖包，如果直接安装到后端系统环境：
- ❌ **版本冲突**：Skill A 需要 pandas 1.5，Skill B 需要 pandas 2.0
- ❌ **环境污染**：安装大量不必要的包（如 ML 库）
- ❌ **安全风险**：恶意 Skill 可能引入有漏洞的依赖

## ✨ 解决方案

每个 Skill 拥有**独立的虚拟环境**，完全隔离依赖。

### 架构图
```
RAGSystem/backend/agents/skills/
├── disaster-report-example/
│   ├── SKILL.md
│   ├── requirements.txt      # 📦 依赖声明
│   ├── .venv/                # 🔒 独立虚拟环境（自动创建）
│   │   ├── Lib/site-packages/  # 此 Skill 的依赖
│   │   └── Scripts/python.exe
│   └── scripts/
│       └── validate_data.py
│
├── data-visualization-skill/
│   ├── SKILL.md
│   ├── requirements.txt      # 📦 不同的依赖
│   ├── .venv/                # 🔒 完全隔离
│   │   └── ...
│   └── scripts/
│       └── plot_chart.py
```

---

## 📦 方案 1：虚拟环境隔离（推荐）⭐

### 特点
- ✅ 完全隔离，零冲突
- ✅ 性能接近原生
- ✅ 自动管理，零配置
- ✅ 跨平台支持

### 使用方法

#### 1. 在 Skill 目录创建 `requirements.txt`

```bash
# backend/agents/skills/your-skill/requirements.txt
pandas>=2.0.0
numpy>=1.24.0
matplotlib>=3.7.0
requests>=2.31.0
```

#### 2. 系统自动处理（无需手动操作）

首次执行脚本时，系统会：
1. ✅ 检测 `requirements.txt`
2. ✅ 创建虚拟环境 `.venv/`
3. ✅ 安装依赖 `pip install -r requirements.txt`
4. ✅ 在虚拟环境中执行脚本

后续执行：
- ✅ 直接使用已有虚拟环境
- ✅ 除非 `requirements.txt` 更新，否则不会重复安装

#### 3. 智能体调用示例

```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "data-visualization-skill",
    "script_name": "plot_chart.py"
  }
}
```

系统会自动在 `data-visualization-skill/.venv/` 环境中执行脚本。

---

## 🐳 方案 2：Docker 容器隔离（生产环境）

### 特点
- ✅ 最强隔离（文件系统、网络、进程）
- ✅ 可限制 CPU/内存
- ✅ 适合不受信任的 Skills
- ⚠️ 需要 Docker 环境
- ⚠️ 性能开销较大

### 配置方法（预留）

```yaml
# config.yaml
skills:
  isolation_mode: docker
```

**注意**：Docker 模式暂未实现，计划在后续版本支持。

---

## 🔧 方案 3：共享环境（开发测试）

### 特点
- ✅ 无需创建虚拟环境
- ✅ 启动快
- ❌ 可能冲突
- ❌ 污染系统环境

### 配置方法

```yaml
# config.yaml
skills:
  isolation_mode: shared
```

**适用场景**：
- 开发测试阶段
- Skill 无额外依赖
- 依赖已安装在系统中

---

## ⚙️ 配置详解

### 系统配置（`config/yaml/config.default.yaml`）

```yaml
skills:
  # 隔离模式
  isolation_mode: venv  # venv | docker | shared

  # 自动安装依赖
  auto_install_dependencies: true

  # 虚拟环境目录名
  venv_dir_name: .venv
```

### 环境变量覆盖

```bash
# Windows
set SKILLS__ISOLATION_MODE=docker

# Linux/Mac
export SKILLS__ISOLATION_MODE=docker
```

---

## 📝 最佳实践

### 1. requirements.txt 编写规范

✅ **推荐**：
```txt
# 固定主版本，允许小版本更新
pandas>=2.0.0,<3.0.0
numpy>=1.24.0,<2.0.0
requests>=2.31.0

# 避免不必要的依赖
# ❌ 不要包含：torch, tensorflow（太大）
# ❌ 不要包含：flask, django（后端已有）
```

❌ **不推荐**：
```txt
# 不固定版本（可能不兼容）
pandas
numpy

# 包含巨型依赖（>500MB）
torch
tensorflow
```

### 2. 脚本编写规范

```python
#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
脚本功能描述

依赖：
- pandas>=2.0.0
- numpy>=1.24.0
"""

import sys
import pandas as pd
import numpy as np

def main():
    # 脚本逻辑
    print("处理完成")
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

### 3. 依赖最小化原则

只安装**必需**的依赖：
- ✅ 脚本直接 import 的包
- ✅ 核心功能必须的包
- ❌ "可能用到"的包
- ❌ 开发工具（如 pytest, black）

### 4. 安全注意事项

**安装第三方 Skill 前检查**：
```bash
# 查看 requirements.txt
cat backend/agents/skills/third-party-skill/requirements.txt

# 检查是否有可疑依赖
# ⚠️ 警惕：未知来源的包、版本过旧的包
```

---

## 🔍 故障排查

### 问题 1：虚拟环境创建失败

**症状**：
```
创建虚拟环境失败: [Errno 13] Permission denied
```

**解决**：
```bash
# 检查 Skills 目录权限
ls -l backend/agents/skills/

# 授予写权限
chmod -R 755 backend/agents/skills/
```

### 问题 2：依赖安装超时

**症状**：
```
安装依赖失败: socket.timeout: timed out
```

**解决**：
```bash
# 使用国内镜像（加快下载）
# 编辑 requirements.txt
-i https://pypi.tuna.tsinghua.edu.cn/simple
pandas>=2.0.0
numpy>=1.24.0
```

### 问题 3：脚本找不到模块

**症状**：
```
ModuleNotFoundError: No module named 'pandas'
```

**原因**：虚拟环境未激活或依赖未安装

**解决**：
```bash
# 手动测试虚拟环境
cd backend/agents/skills/your-skill/

# Windows
.venv\Scripts\activate
python scripts/your_script.py

# Linux/Mac
source .venv/bin/activate
python scripts/your_script.py
```

### 问题 4：依赖更新不生效

**症状**：修改 `requirements.txt` 后，脚本仍使用旧版本

**解决**：
```bash
# 删除虚拟环境重建
rm -rf backend/agents/skills/your-skill/.venv/
rm backend/agents/skills/your-skill/.venv/.installed

# 下次执行时会自动重建
```

---

## 🚀 进阶用法

### 1. 预构建虚拟环境

对于大型依赖，可以预先创建虚拟环境：

```bash
cd backend/agents/skills/ml-analysis-skill/

# 创建虚拟环境
python -m venv .venv

# 激活环境
# Windows: .venv\Scripts\activate
# Linux: source .venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 创建标记文件
touch .venv/.installed
```

### 2. 使用 UV 包管理器（最快）

[UV](https://github.com/astral-sh/uv) 是 Rust 编写的超快 Python 包管理器：

```bash
# 安装 UV
pip install uv

# 在 requirements.txt 中指定
# 系统会自动检测并使用 UV 安装
```

性能对比：
- pip: ~60 秒
- UV: ~2 秒（30x 加速）

### 3. 共享基础环境

如果多个 Skills 有相同的依赖，可以创建共享基础环境：

```yaml
# config.yaml
skills:
  base_venv: backend/agents/skills/.shared-venv
```

然后每个 Skill 的虚拟环境继承基础环境：
```bash
python -m venv --system-site-packages .venv
```

---

## 📊 性能对比

| 模式 | 首次启动 | 后续启动 | 内存占用 | 安全性 |
|------|---------|---------|---------|--------|
| **venv** | ~5秒（安装依赖） | ~50ms | +20MB | ⭐⭐⭐⭐ |
| **docker** | ~30秒（构建镜像） | ~500ms | +100MB | ⭐⭐⭐⭐⭐ |
| **shared** | ~50ms | ~50ms | 0 | ⭐⭐ |

**推荐**：默认使用 `venv`，生产环境考虑 `docker`。

---

## 🎓 总结

### ✅ 推荐做法
1. **使用虚拟环境隔离**（`isolation_mode: venv`）
2. **最小化依赖**（只安装必需的包）
3. **固定版本范围**（避免不兼容更新）
4. **预先测试**（手动激活虚拟环境测试脚本）

### ❌ 避免
1. ❌ 直接安装到后端环境
2. ❌ 包含巨型依赖（>100MB）
3. ❌ 不固定版本（可能随时崩溃）
4. ❌ 使用共享环境处理不受信任的 Skills

### 🔐 安全清单
- [ ] 审查 `requirements.txt` 中的每个依赖
- [ ] 检查是否有已知漏洞（使用 `pip audit`）
- [ ] 避免使用未维护的包（3年+无更新）
- [ ] 限制网络访问（通过防火墙）
- [ ] 定期更新依赖（`pip list --outdated`）

---

## 📚 相关文档

- **Skills 系统概述**：`backend/agents/skills/README.md`
- **工具使用指南**：`backend/agents/skills/HOW_AI_USES_SKILLS.md`
- **权限控制**：`backend/agents/skills/SKILLS_PERMISSION_CONTROL.md`
- **Python 虚拟环境**：https://docs.python.org/3/library/venv.html
