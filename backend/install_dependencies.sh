#!/bin/bash
# ============================================
# RAGSystem 依赖安装脚本
# 版本: v2.0
# 更新日期: 2025-12-18
# ============================================

set -e  # 遇到错误立即退出

echo "================================================"
echo "  RAGSystem 依赖安装脚本"
echo "================================================"
echo ""

# 检查Python版本
echo "[1/5] 检查Python环境..."
python_version=$(python --version 2>&1 | awk '{print $2}')
echo "当前Python版本: $python_version"

if ! python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"; then
    echo "❌ 错误: 需要Python 3.10或更高版本"
    exit 1
fi
echo "✅ Python版本检查通过"
echo ""

# 升级pip
echo "[2/5] 升级pip..."
pip install --upgrade pip
echo "✅ pip升级完成"
echo ""

# 安装核心依赖
echo "[3/5] 安装核心依赖..."
pip install -r requirements.txt
echo "✅ 核心依赖安装完成"
echo ""

# 安装自定义依赖（源码安装）
echo "[4/5] 安装自定义依赖..."

# 安装llmjson
if [ -d "/tmp/llmjson" ]; then
    rm -rf /tmp/llmjson
fi
git clone https://github.com/lihao77/llmjson.git /tmp/llmjson
pip install -e /tmp/llmjson
echo "✅ llmjson 安装完成"

# 安装json2graph
if [ -d "/tmp/json2graph-for-review" ]; then
    rm -rf /tmp/json2graph-for-review
fi
git clone https://github.com/lihao77/json2graph-for-review.git /tmp/json2graph-for-review
pip install -e /tmp/json2graph-for-review
echo "✅ json2graph 安装完成"
echo ""

# 验证安装
echo "[5/5] 验证安装..."
python -c "
import sys
try:
    # 核心依赖
    import flask
    import neo4j
    import chromadb
    import sentence_transformers
    import jieba
    
    # 向量数据库模块
    from vector_store import get_vector_client, get_embedder, DocumentIndexer, VectorRetriever
    
    # 自定义依赖
    import llmjson
    import json2graph
    
    print('✅ 所有依赖验证通过')
    sys.exit(0)
except ImportError as e:
    print(f'❌ 导入失败: {e}')
    sys.exit(1)
"

if [ $? -eq 0 ]; then
    echo ""
    echo "================================================"
    echo "  🎉 依赖安装完成！"
    echo "================================================"
    echo ""
    echo "下一步操作:"
    echo "  1. 配置 config.json 文件"
    echo "  2. 启动Neo4j数据库"
    echo "  3. 运行: python app.py"
    echo ""
else
    echo ""
    echo "❌ 安装验证失败，请检查错误信息"
    exit 1
fi
