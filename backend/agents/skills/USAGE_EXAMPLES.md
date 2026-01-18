# Skills 使用完整示例

本文档展示 AI 如何使用 Skills 系统的三个核心能力。

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      ReAct Agent                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  System Prompt (包含 Skills 列表)                     │   │
│  │  - disaster-report-example                           │   │
│  │    适用场景：生成灾害报告、总结灾害、分析灾情         │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                          ↓
                    AI 判断需要使用
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                   可用的工具                                 │
│  1. load_skill_resource   - 加载引用文件                    │
│  2. execute_skill_script  - 执行脚本                        │
│  3. query_knowledge_graph - 查询数据                        │
│  4. generate_chart        - 生成图表                        │
│  ... 其他工具 ...                                           │
└─────────────────────────────────────────────────────────────┘
```

## 示例 1：查看报告模板

### 用户请求
```
用户: 帮我生成一份 2023年广西洪涝灾害的报告
```

### AI 的推理过程

#### Round 1：识别 Skill
```json
{
  "thought": "用户要求生成报告。我看到有 disaster-report-example Skill，其描述是'生成结构化的洪涝灾害报告'，非常匹配。Skill 内容提到'详细的报告结构参见 report-template.md'，我需要先查看模板。",
  "actions": [
    {
      "tool": "load_skill_resource",
      "arguments": {
        "skill_name": "disaster-report-example",
        "resource_file": "report-template.md"
      }
    }
  ],
  "final_answer": null
}
```

#### 系统返回
```json
{
  "success": true,
  "data": {
    "file_name": "report-template.md",
    "content": "# 报告结构模板\n\n## 1. 执行摘要（200字内）\n- 灾害类型和时间\n- 主要影响区域\n...",
    "skill": "disaster-report-example"
  },
  "metadata": {
    "length": 993
  }
}
```

#### Round 2：查询数据
```json
{
  "thought": "已经了解报告结构。现在按模板要求查询灾害数据。",
  "actions": [
    {
      "tool": "query_knowledge_graph_with_nl",
      "arguments": {
        "question": "2023年广西洪涝灾害的基本信息、受灾人口和经济损失"
      }
    }
  ],
  "final_answer": null
}
```

#### Round 3：生成报告
```json
{
  "thought": "已获取所有必要数据，按照模板结构生成报告。",
  "actions": [],
  "final_answer": "# 2023年广西洪涝灾害报告\n\n## 1. 执行摘要\n\n2023年6月至10月，广西壮族自治区遭遇多轮强降雨..."
}
```

## 示例 2：执行验证脚本

### 用户请求
```
用户: 生成报告前，帮我验证一下数据是否完整
```

### AI 的推理过程

#### Round 1：执行验证脚本
```json
{
  "thought": "Skill 提示在生成报告前运行验证脚本。我看到 SKILL.md 中提到：'使用验证脚本检查数据：python scripts/validate_data.py'",
  "actions": [
    {
      "tool": "execute_skill_script",
      "arguments": {
        "skill_name": "disaster-report-example",
        "script_name": "validate_data.py"
      }
    }
  ],
  "final_answer": null
}
```

#### 系统返回（零上下文执行）
```json
{
  "success": true,
  "data": {
    "script_name": "validate_data.py",
    "stdout": "============================================================\n灾害数据验证脚本\n============================================================\n\n正在验证数据...\n{\n  \"disaster_name\": \"2023年广西洪涝灾害\",\n  \"start_date\": \"2023-06-01\",\n  \"location\": \"广西壮族自治区\",\n  \"affected_population\": 528800,\n  \"economic_loss\": 3.9\n}\n\n============================================================\n✓ 数据验证通过\n============================================================\n",
    "stderr": "",
    "return_code": 0,
    "skill": "disaster-report-example"
  },
  "metadata": {
    "command": "python E:\\Python\\RAGSystem\\backend\\agents\\skills\\disaster-report-example\\scripts\\validate_data.py",
    "success": true
  }
}
```

**注意**：脚本内容（约100行代码）没有被加载到上下文中，只有输出结果消耗了 token。

#### Round 2：继续生成报告
```json
{
  "thought": "数据验证通过（return_code=0），所有必需字段完整。现在可以安全地生成报告。",
  "actions": [
    {
      "tool": "query_knowledge_graph_with_nl",
      "arguments": {
        "question": "2023年广西洪涝灾害详细数据"
      }
    }
  ],
  "final_answer": null
}
```

## 示例 3：查看高级分析方法

### 用户请求
```
用户: 我想做更深入的灾害对比分析，有什么建议吗？
```

### AI 的推理过程

#### Round 1：加载高级指南
```json
{
  "thought": "用户想做深入分析。disaster-report-example Skill 中提到'更多详细的分析方法和案例请参见：[高级分析方法](advanced-analysis.md)'，我应该查看这个文件。",
  "actions": [
    {
      "tool": "load_skill_resource",
      "arguments": {
        "skill_name": "disaster-report-example",
        "resource_file": "advanced-analysis.md"
      }
    }
  ],
  "final_answer": null
}
```

#### 系统返回
```json
{
  "success": true,
  "data": {
    "file_name": "advanced-analysis.md",
    "content": "# 高级分析方法\n\n## 多维度对比分析\n\n### 1. 跨年度对比\n使用 compare_entities 工具...",
    "skill": "disaster-report-example"
  },
  "metadata": {
    "length": 1809
  }
}
```

#### Round 2：提供建议
```json
{
  "thought": "已阅读高级分析方法指南。其中提供了多维度对比、因果链挖掘、数据整合等策略。我可以基于这些方法给用户建议。",
  "actions": [],
  "final_answer": "基于 Skill 的高级分析指南，我建议以下分析方法：\n\n## 1. 多维度对比分析\n\n**跨年度对比**：\n使用 compare_entities 工具对比 2020、2021、2022 三年的洪涝灾害...\n\n## 2. 因果链深度挖掘\n\n使用 find_causal_chain 的 max_depth 参数追踪 3 层因果关系..."
}
```

## 关键机制解析

### 1. 渐进式披露 (Progressive Disclosure)

**初始状态**：System Prompt 中只包含 Skill 的 name 和 description（约100字）

**第一次扩展**：AI 判断需要时，调用 `load_skill_resource` 加载主文档（约2000字）

**第二次扩展**：需要更多细节时，加载引用的详细文档（约5000字）

**优势**：
- ✅ 节省初始上下文
- ✅ 按需加载，避免无关信息
- ✅ 保持 Agent 的响应速度

### 2. 零上下文脚本执行 (Zero-Context Script Execution)

**传统方式**：
```
1. 读取脚本文件内容（100行 × 80字符 = 8000 token）
2. 将代码加载到上下文
3. 解释代码逻辑
4. 执行代码
```

**零上下文方式**：
```
1. 调用 execute_skill_script
2. 系统直接执行脚本
3. 只返回输出结果（约500 token）
```

**优势**：
- ✅ 节省 95% 以上的上下文消耗
- ✅ 脚本可以任意复杂，不影响 AI
- ✅ 执行速度快（subprocess 并行执行）

### 3. Skill 权限控制

**配置层面**：
```yaml
qa_agent:
  skills:
    enabled_skills:
      - disaster-report-example
  tools:
    enabled_tools:
      - load_skill_resource
      - execute_skill_script
```

**运行时验证**：
- ✅ Agent 只能访问配置中的 Skills
- ✅ 只能加载自己拥有的 Skill 的资源
- ✅ 只能执行自己拥有的 Skill 的脚本

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

## 最佳实践

### 1. 在 SKILL.md 中清晰指引

```markdown
## 报告结构模板

完整的报告结构和格式规范请参见 [report-template.md](report-template.md)

## 数据验证

在生成报告之前，建议使用验证脚本检查数据完整性：

\`\`\`bash
python scripts/validate_data.py
\`\`\`

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

## 总结

通过 `load_skill_resource` 和 `execute_skill_script` 两个工具，AI 能够：

1. **按需加载详细文档**：实现渐进式披露
2. **零上下文执行脚本**：节省上下文消耗
3. **遵循 Skill 指导**：利用领域知识完成复杂任务

这完全符合 Claude Skills 的设计理念，让 Skills 成为真正实用的能力扩展机制。
