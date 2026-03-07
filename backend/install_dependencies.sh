#!/usr/bin/env bash
# ============================================
# RAGSystem 依赖安装脚本
# 版本: v3.1
# 更新日期: 2026-03-07
# ============================================

set -euo pipefail

resolve_python_bin() {
  if [[ -n "${PYTHON_BIN:-}" ]]; then
    echo "$PYTHON_BIN"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
    return
  fi

  if command -v python >/dev/null 2>&1; then
    echo "python"
    return
  fi

  echo ""
}

PYTHON_BIN="$(resolve_python_bin)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "❌ 未找到可用的 Python 解释器（python3 / python）"
  exit 1
fi

PIP_CMD=("$PYTHON_BIN" -m pip)
REQUIREMENTS_FILE="requirements.lock.txt"
if [[ ! -f "$REQUIREMENTS_FILE" ]]; then
  REQUIREMENTS_FILE="requirements.txt"
fi

echo "================================================"
echo "  RAGSystem 依赖安装脚本"
echo "================================================"
echo "Python解释器: $PYTHON_BIN"
echo "依赖清单: $REQUIREMENTS_FILE"
echo ""

echo "[1/5] 检查 Python 环境..."
python_version=$($PYTHON_BIN --version 2>&1 | awk '{print $2}')
echo "当前Python版本: $python_version"
if ! $PYTHON_BIN -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"; then
  echo "❌ 错误: 需要 Python 3.10 或更高版本"
  exit 1
fi
echo "✅ Python版本检查通过"
echo ""

echo "[2/5] 升级 pip..."
"${PIP_CMD[@]}" install --upgrade pip
echo "✅ pip 升级完成"
echo ""

echo "[3/5] 安装后端依赖..."
"${PIP_CMD[@]}" install -r "$REQUIREMENTS_FILE"
echo "✅ 后端依赖安装完成"
echo ""

echo "[4/5] 验证关键依赖..."
$PYTHON_BIN - <<'PY'
import importlib
import sys

checks = [
    ("flask", "Flask"),
    ("flask_cors", "Flask-CORS"),
    ("neo4j", "neo4j"),
    ("requests", "requests"),
    ("dotenv", "python-dotenv"),
    ("pydantic", "pydantic"),
    ("yaml", "PyYAML"),
    ("coloredlogs", "coloredlogs"),
    ("structlog", "structlog"),
    ("docx", "python-docx"),
    ("tiktoken", "tiktoken"),
    ("json_repair", "json-repair"),
    ("sqlite_vec", "sqlite-vec"),
    ("jieba", "jieba"),
    ("numpy", "numpy"),
    ("pandas", "pandas"),
    ("shapely", "shapely"),
    ("mcp", "mcp"),
    ("llmjson", "llmjson"),
    ("json2graph", "json2graph"),
]

missing = []
for module_name, display_name in checks:
    try:
        importlib.import_module(module_name)
    except Exception as exc:
        missing.append(f"{display_name} ({exc.__class__.__name__}: {exc})")

if missing:
    print("❌ 以下依赖导入失败:")
    for item in missing:
        print(f"  - {item}")
    sys.exit(1)

from model_adapter import ModelAdapter
from vector_store.sqlite_store import SQLiteVectorStore

print("✅ 关键依赖与核心模块导入通过")
print(f"   ModelAdapter: {ModelAdapter.__name__}")
print(f"   SQLiteVectorStore: {SQLiteVectorStore.__name__}")
PY
echo "✅ 依赖验证完成"
echo ""

echo "[5/5] 下一步建议..."
echo "  1. cp .env.example .env"
echo "  2. cp model_adapter/configs/providers.yaml.example model_adapter/configs/providers.yaml"
echo "  3. 编辑上述文件并填入真实配置"
echo "  4. 运行: $PYTHON_BIN app.py"
echo ""
echo "如需检查配置结构，可运行："
echo "  $PYTHON_BIN -m config.health_check"
echo ""
echo "================================================"
echo "  🎉 依赖安装流程完成"
echo "================================================"
