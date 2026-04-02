#!/usr/bin/env python3
"""测试 after_execute hook 是否触发"""

import sys
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# 设置详细日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

from tools.runtime.executor import execute_tool

# 模拟执行一个简单的工具
print("\n" + "=" * 70)
print("测试 after_execute Hook 触发")
print("=" * 70)

print("\n执行 read_file 工具...")

try:
    result = execute_tool(
        tool_name="read_file",
        arguments={"file_path": "README.md"},
        session_id="test-session",
        run_id="test-run",
        current_agent_name="test_agent",
        caller="direct",
    )

    print(f"\n工具执行结果:")
    print(f"  - 成功: {result.success}")
    print(f"  - 摘要: {result.summary}")

except Exception as e:
    print(f"\n执行失败: {e}")
    import traceback
    traceback.print_exc()

print("\n" + "=" * 70)
print("检查日志中是否有 [TEST HOOK] 标记")
print("应该看到 before_execute 和 after_execute 两条日志")
print("=" * 70)
