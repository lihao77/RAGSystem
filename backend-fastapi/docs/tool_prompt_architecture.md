# 工具提示词架构说明

## 概述

为了降低维护成本，工具的使用说明现在集中在 `@tool` 装饰器中定义，通过 `extended_usage` 字段提供详细的使用指导。

## 架构设计

```
@tool 装饰器 (单一源)
       │
       ├── description: 简短描述（显示在工具列表）
       ├── parameters: 参数定义
       ├── usage_contract: 使用约束列表
       ├── examples: 使用示例
       └── extended_usage: 详细使用说明（新增）⭐
              │
              ▼
        ToolContract
              │
              ▼
     build_function_tool()
              │
              ▼
        format_tool_contract()
              │
              ▼
    Agent 系统提示词（自动生成）
```

## 字段说明

### description
- **用途**：工具的简短描述
- **长度**：1-2 句话
- **显示位置**：工具列表、工具定义

### extended_usage
- **用途**：详细的使用说明、限制、示例
- **格式**：Markdown 格式（支持代码块、列表、标题）
- **显示位置**：Agent 系统提示词中，作为工具说明的一部分
- **内容建议**：
  - 模块/依赖限制
  - 环境变量说明
  - 文件操作规则
  - 错误示例与正确示例
  - 特殊约束说明

## 已迁移的工具

### 1. execute_code
**迁移内容**：
- 禁止/允许导入的模块列表（20+个）
- 已注入的全局变量说明（`path_ops`、`call_tool`、`save_file` 等）
- 文件操作规则（workspace/transient/exports）
- 正确/错误示例

**原位置**：`agents/core/prompting.py:build_code_execution_prompt_section()`  
**现位置**：`tools/local/code_sandbox.py:@tool(extended_usage=...)`

### 2. execute_bash
**迁移内容**：
- 后台执行说明
- 工作目录规则（workspace/transient/exports）
- 安全限制（命令替换、写重定向等）
- 链式命令处理
- 命令分类说明

**原位置**：`agents/core/prompting.py:build_tool_calling_global_rules()`（部分）  
**现位置**：`tools/local/bash_tool.py:@tool(extended_usage=...)`

## 保留的全局规则

以下规则仍保留在 `prompting.py` 中，因为它们是跨工具通用的：

1. **build_managed_space_rules()** - 受管目录 space 说明
   - 适用于所有文件工具和 execute_bash
   - 说明 workspace/transient/exports 的区别

2. **build_data_file_rules_section()** - 数据文件传递规则
   - 适用于所有处理数据文件的场景
   - 说明只传路径不传内容的原则

3. **build_code_execution_prompt_section()** - 动态工具列表
   - 根据 agent 配置动态生成可从 execute_code 中调用的工具列表
   - 无法静态定义在 @tool 中

## 使用示例

### 定义工具

```python
@tool(
    name="my_tool",
    description="工具的简短描述",
    parameters={...},
    extended_usage="""### 详细说明

**使用限制**：
- 限制 1
- 限制 2

**示例**：
\```python
# 正确示例
result = my_tool_usage()
\```

**注意事项**：
- 注意事项 1
- 注意事项 2
""",
)
def my_tool(...):
    ...
```

### 渲染到提示词

`format_tool_contract()` 会自动将 `extended_usage` 渲染到工具说明的开头：

```
### my_tool
**描述**: 工具的简短描述
**调用能力**: direct（可直接调用）
**参数**: ...

### 详细说明           ← extended_usage 内容

**使用限制**：
- 限制 1
- 限制 2
...

**成功返回**: ...      ← 其他字段继续渲染
**使用约束**: ...
**示例**: ...
```

## 维护建议

### 何时使用 extended_usage

✅ **应该使用**：
- 工具特有的使用限制
- 特定的环境要求
- 复杂的参数组合说明
- 常见错误和正确用法对比

❌ **不应该使用**：
- 跨工具通用的规则（放在 prompting.py 的全局规则中）
- 动态生成的内容（如可调用工具列表）
- 架构层面的说明（放在 docs/ 中）

### 修改流程

1. **修改工具说明**：直接编辑 `@tool` 装饰器的 `extended_usage`
2. **测试**：运行工具注册并检查生成的提示词
3. **验证**：确保 Agent 能看到新的说明

### 测试方法

```python
from tools.decorators import get_decorated_tools
from tools.contracts.tool_contracts import build_function_tool
from agents.core.prompting import format_tool_contract

tools = get_decorated_tools()
tool_def = build_function_tool(tools['tool_name']['contract'])
lines = format_tool_contract(tool_def)
print('\n'.join(lines))
```

## 迁移清单

| 工具 | 状态 | extended_usage 大小 |
|-----|------|-------------------|
| execute_code | ✅ 已迁移 | 2116 chars |
| execute_bash | ✅ 已迁移 | 1092 chars |
| read_file | ⏳ 待迁移 | - |
| write_file | ⏳ 待迁移 | - |
| edit_file | ⏳ 待迁移 | - |
| preview_data_structure | ⏳ 待迁移 | - |

## 与 docs/tools.md 的关系

- **docs/tools.md**：技术文档，面向开发者，说明实现细节、设计决策
- **extended_usage**：使用指南，面向 LLM Agent，说明如何正确使用工具
- **更新策略**：工具使用方式变更时，同步更新两处；实现细节变更时，只更新 docs/tools.md

## 收益

1. **单一源**：工具说明在代码中集中定义，减少不同步风险
2. **自动同步**：修改 @tool 定义后，Agent 提示词自动更新
3. **易于维护**：工具代码和使用说明在同一位置，修改更方便
4. **降低复杂度**：减少 prompting.py 中的硬编码规则
5. **更好的代码组织**：每个工具自包含其使用文档

## 版本历史

- **2026-04-03**: 完成 execute_code 和 execute_bash 的迁移
- **2026-04-03**: 新增 extended_usage 字段支持
