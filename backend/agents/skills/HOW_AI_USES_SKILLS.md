# Skills 使用机制设计文档

## 核心机制：自动注入 Skills 工具

当智能体启用 Skills 时，`load_skill_resource` 和 `execute_skill_script` 两个工具会**自动注入**到该智能体的工具列表中，无需用户手动配置。

### 设计理念

**Skills 工具是 Skills 系统的内置能力**：
- ✅ 启用 Skills → 自动获得这两个工具
- ✅ 未启用 Skills → 不会获得这两个工具
- ✅ 用户无需在配置文件中手动添加
- ✅ 对用户透明，降低配置复杂度

### 实现位置

**自动注入逻辑** 在 `backend/agents/config/loader.py` 中：

```python
# 加载 Skills（根据配置过滤）
filtered_skills = []
if agent_config and agent_config.skills and agent_config.skills.enabled_skills:
    enabled_skill_names = agent_config.skills.enabled_skills
    filtered_skills = [
        skill for skill in all_skills
        if skill.name in enabled_skill_names
    ]

    # 🔧 自动注入 Skills 系统工具（内置能力，无需用户配置）
    skill_tools = [
        {
            "type": "function",
            "function": {
                "name": "load_skill_resource",
                "description": "加载当前 Skill 的引用文件内容（Additional Resources）...",
                ...
            }
        },
        {
            "type": "function",
            "function": {
                "name": "execute_skill_script",
                "description": "执行 Skill 的实用脚本（零上下文执行）...",
                ...
            }
        }
    ]

    # 自动添加到工具列表（避免重复）
    for skill_tool in skill_tools:
        tool_name = skill_tool.get('function', {}).get('name')
        if tool_name not in existing_tool_names:
            filtered_tools.append(skill_tool)
            logger.info(f"  → 自动注入 Skills 系统工具: {tool_name}")
```

### 用户配置示例

用户只需配置 `enabled_skills`，**不需要**手动添加工具：

```yaml
agents:
  qa_agent:
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
        - find_causal_chain
        # ❌ 不需要手动添加 load_skill_resource
        # ❌ 不需要手动添加 execute_skill_script

    skills:
      enabled_skills:
        - disaster-report-example  # ✅ 只需配置这个
      auto_inject: true
```

系统会自动为 `qa_agent` 添加 `load_skill_resource` 和 `execute_skill_script` 工具。

---

## AI 如何获取详细文件和执行脚本？

### 两个核心工具

Skills 系统为 AI 提供两个专用工具，在启用 Skills 时自动注入。

#### 工具 1: load_skill_resource

**功能**：加载 Skill 的引用文件内容（Additional Resources）

**使用场景**：当 Skill 的 SKILL.md 中提到 `[文件名](文件名)` 链接时，AI 可以调用此工具加载详细内容

**参数**：
- `skill_name`: Skill 名称
- `resource_file`: 文件名（如 `report-template.md`）

**返回**：文件的完整内容

**示例**：
```json
{
  "tool": "load_skill_resource",
  "arguments": {
    "skill_name": "disaster-report-example",
    "resource_file": "report-template.md"
  }
}
```

#### 工具 2: execute_skill_script

**功能**：执行 Skill 的实用脚本（零上下文执行）

**使用场景**：当 Skill 提示运行某个脚本时使用

**参数**：
- `skill_name`: Skill 名称
- `script_name`: 脚本文件名（如 `validate_data.py`）
- `arguments`: 命令行参数（可选）

**返回**：脚本的标准输出、标准错误和返回码

**特性**：零上下文执行 - 脚本代码不会加载到上下文，只返回执行结果

**示例**：
```json
{
  "tool": "execute_skill_script",
  "arguments": {
    "skill_name": "disaster-report-example",
    "script_name": "validate_data.py",
    "arguments": []
  }
}
```

### 工具执行逻辑

工具的实际执行逻辑在 `backend/tools/tool_executor.py` 中：

```python
def load_skill_resource(skill_name, resource_file):
    """加载 Skill 的引用文件内容"""
    skill_loader = get_skill_loader()
    all_skills = skill_loader.load_all_skills()
    skill = next((s for s in all_skills if s.name == skill_name), None)

    if not skill:
        return error_response(f"Skill '{skill_name}' 不存在")

    content = skill.get_referenced_file_content(resource_file)
    if content is None:
        return error_response(f"文件 '{resource_file}' 不存在")

    return success_response(
        message=f"成功加载 {resource_file}",
        results={"file_name": resource_file, "content": content}
    )

def execute_skill_script(skill_name, script_name, arguments=None):
    """执行 Skill 的实用脚本（零上下文执行）"""
    skill_loader = get_skill_loader()
    all_skills = skill_loader.load_all_skills()
    skill = next((s for s in all_skills if s.name == skill_name), None)

    if not skill:
        return error_response(f"Skill '{skill_name}' 不存在")

    script_path = skill.get_script_path(script_name)
    if not script_path:
        return error_response(f"脚本 '{script_name}' 不存在")

    # 零上下文执行
    result = subprocess.run(
        ['python', str(script_path)] + (arguments or []),
        capture_output=True, text=True, timeout=30
    )

    return success_response(
        results={
            "stdout": result.stdout,
            "stderr": result.stderr,
            "return_code": result.returncode
        }
    )
```

---

## AI 使用流程示例

### 场景 1：查看报告模板

**SKILL.md 内容**：
```markdown
详细的报告结构参见 [report-template.md](report-template.md)
```

**AI 的推理过程**：
```
1. AI 看到 Skill 描述中提到 "report-template.md"
2. AI 判断需要查看模板了解结构
3. AI 调用工具：
   {
     "tool": "load_skill_resource",
     "arguments": {
       "skill_name": "disaster-report-example",
       "resource_file": "report-template.md"
     }
   }
4. 系统返回文件内容
5. AI 基于模板内容生成报告
```

### 场景 2：执行验证脚本

**SKILL.md 内容**：
```markdown
在生成报告前，运行验证脚本检查数据：
```bash
python scripts/validate_data.py
```
```

**AI 的推理过程**：
```
1. AI 看到 Skill 建议先验证数据
2. AI 调用工具：
   {
     "tool": "execute_skill_script",
     "arguments": {
       "skill_name": "disaster-report-example",
       "script_name": "validate_data.py"
     }
   }
3. 系统执行脚本，返回输出：
   {
     "stdout": "✓ 数据验证通过\n所有必需字段完整...",
     "return_code": 0
   }
4. AI 确认数据有效，继续生成报告
```

---

## 渐进式披露 (Progressive Disclosure)

Skills 系统采用渐进式披露策略，按需加载内容：

### 初始状态（System Prompt）
只包含 Skill 的 name 和 description（约 100 字）

```
## 领域知识 (Skills)

### 1. disaster-report-example
**适用场景**: 生成结构化的洪涝灾害报告，包括灾情概览、影响分析、时空演化和应急建议。
```

### 第一次扩展（加载主文档）
AI 判断需要时，调用 `load_skill_resource` 加载 SKILL.md（约 2000 字）

### 第二次扩展（加载详细文档）
需要更多细节时，加载引用的详细文档（约 5000 字）

### 零上下文执行（脚本）
执行脚本时，只返回输出结果（约 500 tokens），不加载代码（可能 8000+ tokens）

**优势**：
- ✅ 节省初始上下文
- ✅ 按需加载，避免无关信息
- ✅ 保持 Agent 的响应速度
- ✅ 节省 95% 以上的上下文消耗（脚本执行）

---

## Token 消耗对比

### 场景：生成灾害报告（需要查看模板）

**不使用 Skills 系统**：
```
- System Prompt: 500 tokens
- 完整模板内容: 2000 tokens
- 高级分析指南: 3000 tokens
- 验证脚本代码: 1500 tokens
----------------------------------
总计: 7000 tokens
```

**使用 Skills 系统**：
```
- System Prompt (含 Skill 列表): 600 tokens
- 按需加载模板: 2000 tokens
- 脚本输出（不含代码）: 100 tokens
----------------------------------
总计: 2700 tokens （节省 61%）
```

---

## 最佳实践

### 1. 在 SKILL.md 中清晰指引

```markdown
## 报告结构模板

完整的报告结构和格式规范请参见 [report-template.md](report-template.md)

## 数据验证

在生成报告之前，建议使用验证脚本检查数据完整性：

```bash
python scripts/validate_data.py
```

该脚本会检查：
- 必需字段是否存在
- 数值范围是否合理
- 时间格式是否正确
```

### 2. 提供清晰的工具使用说明

让 AI 明确知道：
- **何时**加载引用文件
- **何时**执行脚本
- **如何**传递参数

### 3. 保持主文件简洁

SKILL.md 应该：
- ✅ 概述核心流程（5-10步骤）
- ✅ 指向详细文档的链接
- ✅ 说明何时使用工具
- ❌ 不包含大段的详细说明
- ❌ 不包含大量示例代码

---

## 总结

通过自动注入机制，Skills 系统实现了：

1. **零配置体验**：用户只需配置 `enabled_skills`，工具自动注入
2. **按需加载文档**：实现渐进式披露，节省上下文
3. **零上下文执行脚本**：脚本代码不进上下文，只返回结果
4. **权限控制**：Agent 只能访问配置允许的 Skills

这完全符合 Claude Skills 的设计理念，让 Skills 成为真正实用的能力扩展机制。
