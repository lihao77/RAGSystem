# Scripts 工具脚本

## 目录说明

本目录包含系统维护、数据初始化和批处理任务脚本。

## 可用脚本

### init_emergency_plans.py

**功能**：初始化应急预案向量数据库

**用途**：
- 首次部署时索引预案文档
- 预案文档更新后重新索引
- 向量数据库损坏后恢复

**使用方法**：
```bash
# 方式1：直接运行
cd backend
python scripts/init_emergency_plans.py

# 方式2：作为模块运行
python -m scripts.init_emergency_plans
```

**执行过程**：
1. 读取 `广西应急预案.md` (项目根目录)
2. 文本分块（500字符/块，50字符重叠）
3. 使用 sentence-transformers 生成向量（384维）
4. 存储到 ChromaDB (`backend/data/vector_store/`)
5. 自动测试检索功能

**输出示例**：
```
============================================================
开始索引应急预案: guangxi_emergency_plan
============================================================
[1/4] 加载文档...
成功加载文件: /path/to/广西应急预案.md
文件大小: 125847 字符

[2/4] 初始化向量索引器...
[3/4] 文档分块与向量化...
  - 分块大小: 500 字符
  - 重叠大小: 50 字符

索引完成！
  ✅ 文档ID: guangxi_emergency_plan
  ✅ 分块数量: 253
  ✅ 向量维度: 384
  ✅ 模型: paraphrase-multilingual-MiniLM-L12-v2

[4/4] 验证索引...
============================================================
测试向量检索
============================================================
查询: Ⅰ级应急响应的启动条件

检索结果 (Top 3):
【结果 1】
  相似度: 0.8542
  来源: guangxi_emergency_plan
  内容: Ⅰ级响应启动条件：...

✅ 应急预案初始化完成！
```

**注意事项**：
- 确保 `广西应急预案.md` 存在于项目根目录
- 需要安装向量数据库依赖（chromadb, sentence-transformers）
- 首次运行会下载embedding模型（~500MB）
- 索引过程需要1-5分钟，取决于文档大小

**环境要求**：
```bash
# 需要激活ragsystem环境
conda activate ragsystem

# 或确保安装了依赖
pip install -r requirements.txt
```

## 脚本开发规范

### 基本结构

```python
#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
脚本简要说明
"""

import sys
import logging
from pathlib import Path

# 添加backend目录到路径
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def main():
    """主函数"""
    try:
        logger.info("开始执行...")
        
        # 脚本逻辑
        
        logger.info("执行完成")
        return 0
        
    except Exception as e:
        logger.error(f"执行失败: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
```

### 最佳实践

1. **幂等性**：多次运行结果一致
   ```python
   # 好的做法：先检查是否存在
   if not collection_exists():
       create_collection()
   else:
       logger.info("集合已存在，跳过创建")
   ```

2. **进度显示**：长时间任务显示进度
   ```python
   from tqdm import tqdm
   
   for item in tqdm(items, desc="处理中"):
       process(item)
   ```

3. **参数化**：支持命令行参数
   ```python
   import argparse
   
   parser = argparse.ArgumentParser()
   parser.add_argument('--force', action='store_true')
   args = parser.parse_args()
   ```

4. **错误处理**：优雅退出
   ```python
   try:
       process()
   except KeyboardInterrupt:
       logger.warning("用户中断")
       sys.exit(130)
   except Exception as e:
       logger.error(f"错误: {e}")
       sys.exit(1)
   ```

## 故障排查

### 常见问题

**1. 找不到模块**
```
ModuleNotFoundError: No module named 'vector_store'
```
**解决**：确保从backend目录或项目根目录运行脚本

**2. 找不到文档文件**
```
找不到应急预案文件: /path/to/广西应急预案.md
```
**解决**：确保文件在项目根目录，或修改脚本中的路径

**3. 模型下载失败**
```
ConnectionError: Failed to download model
```
**解决**：
```bash
# 设置国内镜像
export HF_ENDPOINT=https://hf-mirror.com
```

**4. 内存不足**
```
MemoryError: Unable to allocate array
```
**解决**：减小chunk_size或分批处理

## 维护日志

| 日期 | 脚本 | 更新内容 |
|------|------|----------|
| 2025-01-18 | init_emergency_plans.py | 初始版本 - 应急预案初始化 |

## 贡献指南

添加新脚本时：
1. 遵循命名规范：`verb_noun.py`（如 `init_*.py`, `cleanup_*.py`）
2. 添加完整的docstring
3. 实现 `main()` 函数
4. 更新本README
5. 添加使用示例

## 相关文档

- [向量数据库模块](../vector_store/README.md)
- [工具系统文档](../tools/README.md)
- [安装指南](../INSTALL.md)
