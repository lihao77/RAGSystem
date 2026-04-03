# 工具提示词集中化重构说明

## 修改日期
2026-04-03

## 修改目的
将分散在 `prompting.py` 中的工具使用说明迁移到各个工具的 `@tool` 装饰器中，实现提示词的集中管理，降低维护成本。

## 修改的文件

### 1. 核心架构文件

#### `tools/contracts/tool_contracts.py`
**修改内容**：
- 在 `ToolContract` dataclass 中添加 `extended_usage: str = ""` 字段
- 在 `build_function_tool()` 中添加对 `extended_usage` 的序列化支持

**影响**：所有工具现在都可以定义扩展使用说明

#### `tools/decorators.py`
**修改内容**：
- 在 `tool()` 装饰器函数签名中添加 `extended_usage: str = ""` 参数
- 在创建 `ToolContract` 时传递 `extended_usage` 参数

**影响**：@tool 装饰器现在支持 extended_usage 参数

#### `agents/core/prompting.py`
**修改内容**：
1. `format_tool_contract()` 函数：
   - 在函数开头添加对 `extended_usage` 的渲染
   - 如果 extended_usage 存在，将其作为工具说明的第一部分输出

2. `build_code_execution_prompt_section()` 函数：
   - 大幅简化，删除所有静态说明（模块列表、全局变量、文件操作规则）
   - 只保留动态生成的"可调用工具列表"
   - 添加注释说明静态内容已迁移到 execute_code 的 extended_usage

**影响**：
- 工具的扩展说明会自动渲染到 Agent 提示词中
- prompting.py 不再包含 execute_code 的详细使用说明

### 2. 工具定义文件

#### `tools/local/code_sandbox.py`
**修改内容**：
- 在 `execute_code` 的 `@tool` 装饰器中添加 `extended_usage` 参数
- 内容包括：
  - 禁止/允许导入的模块列表
  - 已注入的全局变量说明（path_ops、call_tool、save_file 等）
  - 文件操作规则（workspace/transient/exports）
  - call_tool 使用说明
  - 正确/错误示例

**字符数**：2116 字符

#### `tools/local/bash_tool.py`
**修改内容**：
- 在 `execute_bash` 的 `@tool` 装饰器中添加 `extended_usage` 参数
- 内容包括：
  - 后台执行说明
  - 工作目录规则
  - 安全限制说明
  - 链式命令处理
  - 命令分类详解

**字符数**：1092 字符

### 3. 文档文件

#### `docs/tool_prompt_architecture.md` (新建)
**内容**：
- 新架构说明
- 字段用途说明
- 已迁移工具清单
- 使用示例
- 维护建议

## 架构变更对比

### 之前的架构
```
prompting.py 硬编码规则
    ├── build_code_execution_prompt_section() - 包含所有 execute_code 说明
    ├── build_tool_calling_global_rules() - 包含 bash 后台执行说明
    └── 与工具定义分离，容易不同步
```

### 现在的架构
```
@tool 装饰器 (单一源)
    └── extended_usage 字段 - 工具特定说明
            ↓
    format_tool_contract() - 自动渲染
            ↓
    Agent 系统提示词 - 动态生成
```

## 保留的全局规则

以下规则仍保留在 `prompting.py` 中：

1. `build_managed_space_rules()` - 受管目录说明（跨工具通用）
2. `build_data_file_rules_section()` - 数据文件传递规则（跨工具通用）
3. `build_code_execution_prompt_section()` - 动态工具列表（无法静态定义）

## 测试验证

### 验证已完成
```bash
✅ All imports successful
✅ execute_code has extended_usage (2116 chars)
✅ execute_bash has extended_usage (1092 chars)
✅ extended_usage rendered correctly in format_tool_contract()
```

## 收益

1. **维护成本降低**：工具说明在定义处集中管理，修改时不需要在多个文件中同步
2. **减少不同步风险**：代码和文档在一起，不容易出现描述与实现不一致
3. **代码可读性提升**：查看工具定义时能直接看到使用说明
4. **自动化程度提高**：修改 @tool 定义后，Agent 提示词自动更新

## 后续工作

可以继续迁移其他工具的说明到 extended_usage：
- read_file
- write_file
- edit_file
- preview_data_structure
- 其他需要详细说明的工具
