# Agent Skills 系统

基于 Claude Skills 理念的简化实现，为 ReAct Agent 提供领域知识注入能力。

## 核心特性

### 1. ✅ 基础元数据
- `name`: Skill 名称（用于标识）
- `description`: 描述（Agent 用于判断何时使用该 Skill）

### 2. ✅ Additional Resources（按需加载）
- 在 `SKILL.md` 中通过 markdown 链接引用其他文件
- Agent 需要时才读取引用文件的内容
- 实现渐进式披露，避免消耗过多上下文

### 3. ✅ Utility Scripts（零上下文执行）
- 在 `scripts/` 目录下放置 Python 脚本
- Agent 执行脚本时，只有输出消耗 token
- 脚本内容不会加载到 Agent 的上下文中

## 目录结构

```
backend/agents/skills/
├── skill_loader.py              # Skill 加载器
├── disaster-report-example/     # 示例 Skill
│   ├── SKILL.md                 # 主文件（必需）
│   ├── report-template.md       # 引用文件 1
│   ├── advanced-analysis.md     # 引用文件 2
│   └── scripts/
│       └── validate_data.py     # 工具脚本
```

## SKILL.md 格式

```markdown
---
name: skill-name
description: Skill 的功能描述和使用场景
---

# Skill 标题

## 核心内容
在此处放置最重要的指导信息（保持简洁）。

## Additional Resources
详细的参考资料请参见：
- [模板文档](template.md)
- [高级指南](advanced.md)

## Utility Scripts
使用验证脚本检查数据：
```bash
python scripts/validate.py input.json
```
```

## 使用方法

### 1. 创建新 Skill

```bash
# 创建 Skill 目录
mkdir -p backend/agents/skills/my-skill

# 创建主文件
touch backend/agents/skills/my-skill/SKILL.md

# （可选）创建 scripts 目录
mkdir backend/agents/skills/my-skill/scripts
```

### 2. 编写 SKILL.md

```markdown
---
name: my-skill
description: 这个 Skill 的功能和使用场景
---

# 我的 Skill

详细说明...
```

### 3. 加载 Skills

```python
from agents.skills.skill_loader import get_skill_loader

# 获取加载器
loader = get_skill_loader()

# 加载所有 Skills
skills = loader.load_all_skills()

# 遍历 Skills
for skill in skills:
    print(f"名称: {skill.name}")
    print(f"描述: {skill.description}")
```

### 4. 按需加载引用文件

```python
# 获取某个 Skill
skill = skills[0]

# 查看引用的文件
print(skill.referenced_files)  # ['template.md', 'guide.md']

# 加载具体文件的内容
content = skill.get_referenced_file_content('template.md')
print(content)
```

### 5. 使用工具脚本

```python
# 检查是否有脚本
if skill.has_scripts():
    # 获取脚本路径
    script_path = skill.get_script_path('validate.py')

    # 执行脚本（使用 subprocess 或 Bash 工具）
    import subprocess
    result = subprocess.run(['python', str(script_path)], capture_output=True)
    print(result.stdout.decode())
```

## 测试

运行测试脚本验证 Skill 加载器：

```bash
cd backend
python test_skill_loader.py
```

## 当前状态

- ✅ Skill 加载器实现完成
- ✅ 支持 name 和 description 解析
- ✅ 支持 Additional resources 按需加载
- ✅ 支持 Utility scripts 识别
- ✅ 创建示例 Skill
- 🔄 集成到 ReAct Agent（进行中）

## 下一步

1. 在 ReAct Agent 的 system prompt 中注入 Skills 列表
2. 实现智能 Skill 匹配机制（根据用户问题选择合适的 Skill）
3. 在 Agent 执行过程中动态加载 Skill 内容
4. 前端展示当前激活的 Skill

## API 参考

### Skill 类

```python
class Skill:
    name: str                          # Skill 名称
    description: str                   # Skill 描述
    content: str                       # Markdown 内容
    skill_dir: Path                    # Skill 目录路径
    referenced_files: List[str]        # 引用的文件列表
    metadata: Dict                     # 元数据字典

    def get_referenced_file_content(file_name: str) -> Optional[str]
    def has_scripts() -> bool
    def get_script_path(script_name: str) -> Optional[Path]
    def to_dict() -> Dict
```

### SkillLoader 类

```python
class SkillLoader:
    skills_dir: Path                   # Skills 目录

    def load_all_skills() -> List[Skill]
```

## 设计原则

1. **渐进式披露**：主文件简洁，详细内容按需加载
2. **零上下文执行**：脚本执行不消耗 Agent 上下文
3. **文件组织清晰**：每个 Skill 独立目录，结构统一
4. **易于扩展**：添加新 Skill 只需创建新目录
