# Skills 系统 - 自动注入功能

## 核心改进

将 `load_skill_resource` 和 `execute_skill_script` 两个工具改为**自动注入**，而不是要求用户手动配置。

## 设计理念

**Skills 工具是 Skills 系统的内置能力**：
- ✅ 启用 Skills → 自动获得这两个工具
- ✅ 未启用 Skills → 不会获得这两个工具
- ✅ 用户无需在配置文件中手动添加
- ✅ 对后台管理系统透明

## 用户体验

### 之前（手动配置）

```yaml
qa_agent:
  tools:
    enabled_tools:
      - query_knowledge_graph_with_nl
      - load_skill_resource        # ❌ 需要手动添加
      - execute_skill_script       # ❌ 需要手动添加
  skills:
    enabled_skills:
      - disaster-report-example
```

### 现在（自动注入）

```yaml
qa_agent:
  tools:
    enabled_tools:
      - query_knowledge_graph_with_nl
      # ✅ 不需要手动添加 Skills 工具
  skills:
    enabled_skills:
      - disaster-report-example    # 只需配置这个
```

## 技术实现

### 1. 自动注入逻辑

位置：`backend/agents/config/loader.py`

```python
if agent_config and agent_config.skills and agent_config.skills.enabled_skills:
    # 过滤 Skills
    filtered_skills = [...]

    # 🔧 自动注入 Skills 系统工具
    skill_tools = [
        {"type": "function", "function": {"name": "load_skill_resource", ...}},
        {"type": "function", "function": {"name": "execute_skill_script", ...}}
    ]

    # 添加到工具列表（避免重复）
    for skill_tool in skill_tools:
        if tool_name not in existing_tool_names:
            filtered_tools.append(skill_tool)
            logger.info(f"  → 自动注入 Skills 系统工具: {tool_name}")
```

### 2. 工具定义位置变更

**之前**：
- 工具定义在 `backend/tools/function_definitions.py`
- 作为全局工具，所有 agent 都能看到

**现在**：
- 工具由 `backend/agents/config/loader.py` 在运行时注入
- 只有启用 Skills 的 agent 才会获得这两个工具
- `function_definitions.py` 中添加注释说明

### 3. 工具执行逻辑

位置：`backend/tools/tool_executor.py`

工具执行逻辑保持不变，继续使用 `load_skill_resource()` 和 `execute_skill_script()` 函数。

## 测试验证

### 运行测试

```bash
cd backend
python test_auto_inject_skills_tools.py
```

### 预期结果

```
📋 Agent: qa_agent
   显示名称: 知识图谱问答智能体
   ✅ 已配置 Skills: ['disaster-report-example']
   ✅ Skills 工具已自动注入
      - load_skill_resource: 存在
      - execute_skill_script: 存在
   📊 工具总数: 10

📋 Agent: chart_agent
   显示名称: 数据可视化智能体
   ⚪ 未配置 Skills
   ✅ 正确: 未注入 Skills 工具
```

## 优势

1. **用户友好**：无需手动配置工具，降低配置复杂度
2. **逻辑清晰**：Skills 工具作为 Skills 系统的内置能力，自然而然
3. **权限控制**：只有启用 Skills 的 agent 才能使用这两个工具
4. **向后兼容**：如果用户之前手动配置了这两个工具，系统会自动去重

## 相关文档

- **设计文档**：`backend/agents/skills/HOW_AI_USES_SKILLS.md`
- **使用示例**：`backend/agents/skills/USAGE_EXAMPLES.md`
- **权限控制**：`backend/agents/skills/SKILLS_PERMISSION_CONTROL.md`
- **完整说明**：`backend/agents/skills/README.md`

## 修改文件清单

1. `backend/agents/config/loader.py` - 自动注入逻辑
2. ✅ `backend/agents/configs/agent_configs.yaml` - 移除手动配置的工具
3. ✅ `backend/tools/function_definitions.py` - 移除工具定义，添加说明注释
4. ✅ `backend/agents/skills/HOW_AI_USES_SKILLS.md` - 更新文档
5. ✅ `backend/test_auto_inject_skills_tools.py` - 新增测试脚本
6. ✅ `backend/agents/skills/AUTO_INJECT_FEATURE.md` - 新增功能说明（本文件）

## 总结

通过自动注入机制，Skills 系统实现了零配置体验。用户只需在配置文件中指定 `enabled_skills`，系统会自动为该 agent 添加访问 Skills 资源所需的工具。这大大简化了配置流程，同时保持了权限控制的严格性。
