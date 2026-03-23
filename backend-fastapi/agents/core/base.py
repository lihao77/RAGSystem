# -*- coding: utf-8 -*-
"""
智能体基类 - 所有智能体的抽象基类
"""

from abc import ABC, abstractmethod
from typing import Callable, Dict, List, Any, Optional, Tuple
import json
import logging
import re
import time
import uuid

from .models import AgentResponse
from .context import AgentContext


logger = logging.getLogger(__name__)


class InterruptedError(Exception):
    """Agent 执行被用户中断"""
    pass


def parse_llm_json(content: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    从 LLM 返回文本中解析 JSON，支持多种常见变形。
    Returns:
        (parsed_dict, None) 成功；(None, error_message) 失败。
    """
    if not content or not isinstance(content, str):
        return None, "空或非字符串响应"
    raw = content.strip()
    if not raw:
        return None, "空响应"
    raw = raw.lstrip("\ufeff")  # BOM
    last_error: Optional[str] = None
    stripped = ""

    def try_parse(s: str, strict: bool = True) -> Optional[Dict[str, Any]]:
        nonlocal last_error
        try:
            return json.loads(s, strict=strict)
        except json.JSONDecodeError as e:
            last_error = str(e)
            return None

    out = try_parse(raw)
    if out is not None:
        return out, None

    if raw.startswith("```"):
        lines = raw.split("\n")
        if lines[0].strip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()
        if stripped:
            out = try_parse(stripped)
            if out is not None:
                return out, None
            out = try_parse(stripped, strict=False)
            if out is not None:
                return out, None

    first = raw.find("{")
    last = raw.rfind("}")
    if first != -1 and last != -1 and last > first:
        segment = raw[first : last + 1]
        out = try_parse(segment)
        if out is not None:
            return out, None
        out = try_parse(segment, strict=False)
        if out is not None:
            return out, None

    out = try_parse(raw, strict=False)
    if out is not None:
        return out, None

    if raw.startswith("```") and stripped:
        out = try_parse(stripped, strict=False)
        if out is not None:
            return out, None

    return None, last_error or "JSON 解析失败"


class BaseAgent(ABC):
    """
    智能体基类 - 所有智能体必须继承此类并实现 execute 方法
    """

    def __init__(
        self,
        name: str,
        description: str,
        capabilities: Optional[List[str]] = None,
        model_adapter = None,
        agent_config = None,
        system_config = None
    ):
        self.name = name
        self.description = description
        self.capabilities = capabilities or []
        self.model_adapter = model_adapter
        self.llm_adapter = model_adapter
        self.logger = logging.getLogger(f"Agent.{name}")
        self.agent_config = agent_config
        self.system_config = system_config
        self.tools: List[Dict[str, Any]] = []
        self.available_tools: List[Dict[str, Any]] = []
        self.available_skills: List[Any] = []
        self.context_pipeline = None
        self.result_normalizer = None
        self.observation_policy = None
        self.prompt_materializer = None
        self.max_rounds: Optional[int] = None
        self.base_prompt = ""
        self.display_name = name

    @abstractmethod
    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """执行任务（子类必须实现）"""
        pass

    def execute_stream(self, task: str, context: AgentContext) -> AgentResponse:
        """向后兼容的流式入口；默认复用 execute。"""
        return self.execute(task, context)

    def stream_execute(self, task: str, context: AgentContext) -> AgentResponse:
        """向后兼容别名。"""
        return self.execute(task, context)

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """判断是否能处理该任务（子类可以重写）"""
        return True

    def before_execute(self, task: str, context: AgentContext):
        """执行前钩子"""
        self.logger.info(f"[{self.name}] 开始执行任务: {task}")

    def after_execute(self, task: str, context: AgentContext, result: AgentResponse):
        """执行后钩子"""
        self.logger.info(
            f"[{self.name}] 任务完成: success={result.success}, "
            f"time={result.execution_time:.2f}s"
        )

    def get_info(self) -> Dict[str, Any]:
        """获取智能体信息"""
        info = {
            'name': self.name,
            'description': self.description,
            'capabilities': self.capabilities,
            'tools': [tool.get('function', {}).get('name') for tool in (self.available_tools or self.tools)]
        }
        if self.agent_config:
            info['config'] = {
                'enabled': self.agent_config.enabled,
                'llm': self.agent_config.llm.to_dict(),
                'custom_params': self.agent_config.custom_params
            }
        return info

    def _format_skills_description(self) -> str:
        """
        格式化 Skills 说明（仅列出 name 和 description）。

        具体使用流程由各 Skill 的主文件（SKILL.md）定义。
        """
        available_skills = getattr(self, 'available_skills', [])
        if not available_skills:
            return "当前无可用的领域知识。"

        lines = ["可用 Skills：", ""]
        for idx, skill in enumerate(available_skills, 1):
            lines.append(f"### Skill {idx}: {skill.name}")
            lines.append(f"**适用场景**: {skill.description}")
            lines.append("")
        return "\n".join(lines)

    @staticmethod
    def _format_allowed_callers(func: Dict[str, Any]) -> str:
        allowed_callers = list(func.get('allowed_callers') or ['direct'])
        labels = []
        if 'direct' in allowed_callers:
            labels.append('direct（可直接调用）')
        if 'code_execution' in allowed_callers:
            labels.append('code_execution（可在 execute_code 中通过 call_tool 调用）')
        return '、'.join(labels) if labels else 'direct（可直接调用）'

    @staticmethod
    def _render_tool_example_param(key: str, value: Any) -> str:
        if isinstance(value, list):
            item_parts = []
            for item in value:
                if isinstance(item, str) and ('\n' in item or '<' in item or '>' in item or '&' in item):
                    item_parts.append(f"    <item><![CDATA[{item}]]></item>")
                else:
                    item_parts.append(f"    <item>{item}</item>")
            return f"  <{key}>\n" + "\n".join(item_parts) + f"\n  </{key}>"
        if isinstance(value, str) and ('\n' in value or '<' in value or '>' in value or '&' in value):
            return f"  <{key}><![CDATA[{value}]]></{key}>"
        if isinstance(value, str):
            return f"  <{key}>{value}</{key}>"
        return f"  <{key}>{json.dumps(value, ensure_ascii=False)}</{key}>"

    @staticmethod
    def _render_tool_example(example: Dict[str, Any], tool_name: str) -> str:
        params = example.get('input') if isinstance(example.get('input'), dict) else example
        extra = {k: v for k, v in example.items() if k != 'input'}
        xml_attrs = extra.pop('xml_attrs', {}) if isinstance(extra.get('xml_attrs'), dict) else {}
        xml_parts = []
        for key, value in params.items():
            attrs = xml_attrs.get(key)
            if isinstance(attrs, dict) and attrs:
                attr_text = ' '.join(f'{attr}="{attr_value}"' for attr, attr_value in attrs.items())
                if isinstance(value, list):
                    item_parts = []
                    for item in value:
                        if isinstance(item, str) and ('\n' in item or '<' in item or '>' in item or '&' in item):
                            item_parts.append(f"    <item><![CDATA[{item}]]></item>")
                        else:
                            item_parts.append(f"    <item>{item}</item>")
                    rendered = f"  <{key} {attr_text}>\n" + "\n".join(item_parts) + f"\n  </{key}>"
                elif isinstance(value, str) and ('\n' in value or '<' in value or '>' in value or '&' in value):
                    rendered = f"  <{key} {attr_text}><![CDATA[{value}]]></{key}>"
                else:
                    scalar = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                    rendered = f"  <{key} {attr_text}>{scalar}</{key}>"
                xml_parts.append(rendered)
                continue
            xml_parts.append(BaseAgent._render_tool_example_param(key, value))
        xml_block = "\n".join(xml_parts)
        block = f"  ```xml\n  <tool name=\"{tool_name}\">\n{xml_block}\n  </tool>\n  ```"
        if extra:
            hint_lines = [f"  <!-- {k}: {json.dumps(v, ensure_ascii=False)} -->" for k, v in extra.items()]
            block += "\n" + "\n".join(hint_lines)
        return block

    @staticmethod
    def _format_tool_contract(tool_or_func: Dict[str, Any]) -> List[str]:
        func = tool_or_func.get('function', tool_or_func)
        lines: List[str] = []

        returns = func.get('returns')
        if returns:
            lines.append("**成功返回**:")
            return_desc = returns.get('description')
            if return_desc:
                lines.append(f"  - {return_desc}")
            return_shape = returns.get('shape')
            if return_shape is not None:
                lines.append(f"  ```json\n  {json.dumps(return_shape, ensure_ascii=False, indent=2)}\n  ```")

        usage_contract = func.get('usage_contract') or []
        if usage_contract:
            lines.append("**使用约束**:")
            for item in usage_contract:
                lines.append(f"  - {item}")

        examples = func.get('examples') or []
        if examples:
            lines.append("**示例**:")
            for example in examples:
                lines.append(BaseAgent._render_tool_example(example, func.get('name', '...')))

        return lines

    @staticmethod
    def _build_tool_calling_global_rules() -> str:
        return """## 工具调用总规则

- 每个工具条目中的 `调用能力` 字段是唯一准则：`direct` 表示可直接输出为 XML 工具调用；`code_execution` 表示仅可在 `execute_code` 中通过 `call_tool(tool_name, arguments)` 调用
- 如果某个工具没有标注 `code_execution`，就不要假设它能在 `execute_code` 中调用
- 路径类工具统一使用 `workspace / transient / exports` 三个受管目录空间；`space` 只影响相对 `file_path` / `working_dir` 的解析根"""

    @staticmethod
    def _build_managed_space_rules() -> str:
        return """### 受管目录 space 说明
- `workspace`: 当前 effective workspace；direct 文件工具与 `execute_bash` 的相对路径/目录默认都按这里解析
- `transient`: 当前 session 的临时目录，适合中间文件与临时产物
- `exports`: 当前 session 的导出目录 `exports/<run_id>`，适合最终交付文件；使用时需要当前运行上下文提供 `run_id`
- XML 直接调用时，可用属性形式指定目录桶，例如 `<file_path space="transient">tmp.txt</file_path>`、`<file_path space="exports">report.md</file_path>`、`<working_dir space="workspace">.</working_dir>`
- JSON 参数调用时，不要传字符串化 XML 标签；应使用 `file_path`/`working_dir` 搭配 `file_path_space`/`working_dir_space`
- `space` 只影响相对 `file_path` / `working_dir` 的解析根；绝对路径仍只做受管边界校验
- 对 `execute_bash` 而言，默认工作目录为当前 effective workspace，不再默认指向 backend-fastapi/"""

    @staticmethod
    def _build_data_file_rules_section() -> str:
        return """### 数据文件传递规则
- 数据文件（JSON/GeoJSON/CSV 等）只传路径，不传内容
- 已有文件路径时，直接在 `<final_answer>` 中返回路径
- 工具返回的 `file_path` 是绝对路径，后续工具调用应直接复用；`display_path` 仅用于展示
- 需要确认结构时优先用 `preview_data_structure`；需要抽样确认内容时，可用 `read_file(limit=...)` 后仍只传路径
- 需要处理/转换数据时，用 `execute_code` 读取并写出新文件
- `<final_answer>` 中引用数据文件格式：`[data:文件路径]`
- 不要在 `<final_answer>` 中输出超过 20 行原始数据"""

    @staticmethod
    def _invoke_prompt_hook(agent: Any, method_name: str, *args: Any) -> Any:
        instance_method = getattr(agent, method_name, None)
        if callable(instance_method):
            return instance_method(*args)
        method = getattr(type(agent), method_name, None)
        if callable(method):
            return method(agent, *args)
        return getattr(BaseAgent, method_name)(agent, *args)

    def _get_direct_tools_for_prompt(self) -> List[Dict[str, Any]]:
        from tools.tool_registry import get_tool_registry

        builtin_tool_names = set(get_tool_registry().get_builtin_tool_names())
        direct_tools: List[Dict[str, Any]] = []
        for tool in getattr(self, 'available_tools', []) or []:
            func = tool.get('function', {}) if isinstance(tool, dict) else {}
            tool_name = func.get('name', '')
            if tool_name and tool_name not in builtin_tool_names:
                direct_tools.append(tool)
        return direct_tools

    def _build_direct_tools_section(self) -> str:
        direct_tools = self._get_direct_tools_for_prompt()
        if not direct_tools:
            return ""

        lines = [
            "## 可直接调用的工具",
            "",
            "以下工具可直接作为 XML action 调用：",
        ]
        for tool in direct_tools:
            func = tool.get('function', {})
            name = func.get('name', '')
            desc = func.get('description', '')
            params = func.get('parameters', {})
            lines.append("")
            lines.append(f"### {name}")
            lines.append(f"**描述**: {desc}")
            lines.append(f"**调用能力**: {BaseAgent._format_allowed_callers(func)}")
            if params and 'properties' in params:
                lines.append("**参数**:")
                required = params.get('required', [])
                for param_name, param_info in params['properties'].items():
                    param_type = param_info.get('type', 'any')
                    param_desc = param_info.get('description', '')
                    required_mark = " (必填)" if param_name in required else " (可选)"
                    lines.append(f"  - `{param_name}` ({param_type}){required_mark}: {param_desc}")
            lines.extend(BaseAgent._format_tool_contract(func))

        lines.extend(["", BaseAgent._build_managed_space_rules()])
        return "\n".join(lines)

    def _build_prompt_intro(self) -> str:
        return (self.base_prompt or "").strip()

    def _build_prompt_goal_section(self) -> str:
        return """## 工作目标

你是当前任务的执行者。优先级如下：
1. 准确完成用户任务
2. 只基于已知信息、技能内容和工具结果作答，不编造事实
3. 用最少必要步骤完成任务；信息足够时直接回答，不要为了“更智能”而额外调用工具
4. 缺少关键输入且无法通过工具补齐时，调用 `request_user_input`"""

    def _build_prompt_principles_section(self) -> str:
        return """## 决策与回答原则

- 先判断是否真的需要工具。解释、总结、改写、简单判断等任务，若现有信息足够，可直接输出 `<final_answer>`
- 需要工具时，优先选择最直接、最可靠的工具；不要重复发起已知会失败的调用
- 如果用户指定了格式、字段、排序、时间范围、地区范围、单位或语言风格，最终答案必须严格遵守
- 使用与用户一致的语言；用户未指定时默认中文
- 最终答案先给结论，再给必要细节；避免空话、寒暄和过程描述
- 不确定、未查到或数据不足时，要明确说明边界，不要猜测"""

    def _build_prompt_tools_section(self) -> str:
        parts = []
        direct_tools_section = BaseAgent._invoke_prompt_hook(self, '_build_direct_tools_section')
        if direct_tools_section:
            parts.append(direct_tools_section)
        parts.append(BaseAgent._build_tool_calling_global_rules())
        return "\n\n".join(part for part in parts if part)

    def _build_prompt_skills_section(self) -> str:
        skills_description = BaseAgent._invoke_prompt_hook(self, '_format_skills_description')
        return "## 领域知识 Skills\n\n" + skills_description

    def _build_prompt_tool_call_example(self) -> str:
        direct_tools = BaseAgent._invoke_prompt_hook(self, '_get_direct_tools_for_prompt')
        if not direct_tools:
            return "<tools>\n<tool name=\"tool_name\">\n</tool>\n</tools>"

        func = direct_tools[0].get('function', {})
        example_params = func.get('parameters', {}).get('properties', {})
        example_arg_xml = ""
        if example_params:
            first_param = list(example_params.keys())[0]
            example_arg_xml = f"  <{first_param}>示例值</{first_param}>\n"
        return f"<tools>\n<tool name=\"{func.get('name', 'tool_name')}\">\n{example_arg_xml}</tool>\n</tools>"

    def _build_prompt_output_format_section(self) -> str:
        tool_example = BaseAgent._invoke_prompt_hook(self, '_build_prompt_tool_call_example')
        return f"""## 输出格式

**直接输出工具调用或答案。禁止写推理、分析、过程解释，也不要使用 `<thinking>` 标签。**

调用工具：
{tool_example}

向用户追问缺失信息：
<tools>
<tool name="request_user_input">
  <prompt>请提供需要的关键信息</prompt>
</tool>
</tools>

给出最终答案：
<final_answer>
答案内容
</final_answer>

如需补充一段简短意图（可选，用 1-2 句自然语言概括当前判断或下一步计划，像人在心里做下一步判断，不要展开冗长推理）：
<intent>我先确认现有信息是否足够，再决定是直接回答还是调用工具。</intent>
<tools>...</tools>

**参数格式说明**：
- 每个参数用 XML 子标签传递：`<参数名>值</参数名>`
- 多行文本或含 `<` `>` `&` 的参数值用 CDATA 包裹：`<code><![CDATA[内容]]></code>`
- JSON 格式参数也兼容，但推荐使用 XML 子标签"""

    def _build_prompt_rules_section(self) -> str:
        return """## 执行规则

1. 只能使用上面列出的工具
2. 互相独立的工具调用放同一 `<tools>` 中并行
3. 链式调用用 {{result_N}} 引用同轮第 N 个工具结果
4. 报错后下一轮应调整参数、换工具或缩小任务，不要机械重试
5. 数据文件与工具返回路径按“数据文件传递规则”处理，优先传路径而不是内容
6. 不要编造工具结果或 artifact_id；必须使用工具返回的真实数据"""

    def _has_tool(self, tool_name: str) -> bool:
        return any(
            tool.get('function', {}).get('name') == tool_name
            for tool in getattr(self, 'available_tools', []) or []
            if isinstance(tool, dict)
        )

    def _get_code_callable_tool_names(self) -> List[str]:
        tool_names: List[str] = []
        for tool in getattr(self, 'available_tools', []) or []:
            if not isinstance(tool, dict):
                continue
            func = tool.get('function', {})
            tool_name = func.get('name')
            if not tool_name or tool_name == 'execute_code':
                continue
            allowed_callers = list(func.get('allowed_callers') or ['direct'])
            if 'code_execution' in allowed_callers:
                tool_names.append(tool_name)
        return tool_names

    def _build_code_execution_prompt_section(self) -> str:
        if not BaseAgent._invoke_prompt_hook(self, '_has_tool', 'execute_code'):
            return ""

        code_callable_tools = BaseAgent._invoke_prompt_hook(self, '_get_code_callable_tool_names') or []
        tools_list = (
            "、".join(f"`{tool_name}`" for tool_name in code_callable_tools)
            if code_callable_tools
            else "当前没有额外工具可从代码中调用"
        )
        return f"""## execute_code 中可调用的工具

在 `execute_code` 的代码中使用 `call_tool(tool_name, arguments)` 时，只能调用以下工具：
{tools_list}

`call_tool()` 只返回工具的主内容，也就是 `ToolExecutionResult.content`；如果需要完整响应壳，不要假设它会返回 `content / summary / metadata` 结构。

三个受管目录 `space` 与 direct 文件工具、`execute_bash` 一致：`workspace` / `transient` / `exports`。在代码里优先使用 `SESSION_WORKSPACE_DIR`、`SESSION_TRANSIENT_DIR`、`SESSION_EXPORTS_DIR`，不要自己猜路径。

文件读写不要再通过 `call_tool('read_file'/'write_file'/'edit_file', ...)` 完成；这 3 个工具现在只允许 direct 调用。`execute_code` 内应直接使用受限 `open()` 读取文件，写入前先调用 `request_write_approval()`，再用 `open()` 写入。

示例：
```python
risk = call_tool('assess_flood_risk', {{
    'location': '南宁市',
    'rainfall_24h': 180,
    'water_level': 72.3,
    'warning_level': 70.0
}})
result = {{
    'risk_level': risk.get('risk_level'),
    'summary': risk.get('summary')
}}
```

文件读取：
```python
text = open('sample.json', 'r', encoding='utf-8').read()
data = json.loads(text)
result = {{
    'count': len(data.get('river', []))
}}
```

错误示例：
```python
risk = call_tool('assess_flood_risk', {{
    'location': '南宁市',
    'rainfall_24h': 180,
    'water_level': 72.3,
    'warning_level': 70.0
}})['content']
```

未列出的工具不能从代码中调用，只能直接作为 action 使用。"""

    def _build_agent_specific_prompt_sections(self) -> List[str]:
        return []

    def _build_shared_system_prompt(self) -> str:
        sections: List[str] = []
        section_order = [
            '_build_prompt_intro',
            '_build_prompt_goal_section',
            '_build_prompt_principles_section',
            '_build_prompt_tools_section',
            '_build_prompt_skills_section',
            '_build_prompt_output_format_section',
            '_build_prompt_rules_section',
        ]
        for method_name in section_order:
            section = BaseAgent._invoke_prompt_hook(self, method_name)
            if section and str(section).strip():
                sections.append(str(section).strip())

        code_execution_section = BaseAgent._invoke_prompt_hook(self, '_build_code_execution_prompt_section')
        if code_execution_section and str(code_execution_section).strip():
            sections.append(str(code_execution_section).strip())

        for section in BaseAgent._invoke_prompt_hook(self, '_build_agent_specific_prompt_sections') or []:
            if section and str(section).strip():
                sections.append(str(section).strip())

        sections.append(BaseAgent._build_data_file_rules_section())
        return "\n\n".join(section for section in sections if section)

    def _log_prefix(self, llm_config: Optional[Dict[str, Any]] = None, display_name: Optional[str] = None) -> str:
        """返回带模型名的日志前缀"""
        name = display_name if display_name is not None else self.name
        if llm_config and (llm_config.get('model_name') or llm_config.get('provider')):
            extra = llm_config.get('model_name') or llm_config.get('provider')
            return f"[{name} {extra}]"
        return f"[{name}]"

    def get_llm_config(self, context: Optional[AgentContext] = None, task_type: Optional[str] = None) -> Dict[str, Any]:
        """
        获取 LLM 配置（优先智能体配置，支持请求级覆盖，支持从 ModelAdapter 继承）

        Args:
            context: 智能体上下文（可选）
            task_type: 任务类型（可选），支持 'fast'/'default'/'powerful'，用于多层级模型路由

        Returns:
            LLM 配置字典
        """
        # 1. 如果指定了 task_type 且配置了 llm_tiers，尝试使用对应层级的配置
        if task_type and self.agent_config and self.agent_config.llm_tiers:
            tier_config = self.agent_config.llm_tiers.get(task_type)
            if tier_config:
                # 使用层级配置
                config = tier_config.merge_with_default(
                    self.system_config,
                    model_adapter=self.model_adapter
                )
                self.logger.debug(f"[{self.name}] 使用 {task_type} 层级模型: {config.get('model_name', 'default')}")
                return config
            elif task_type == 'default':
                # 'default' 层级未配置时，回退到主 llm 配置
                pass
            else:
                # 其他层级未配置时，记录警告并回退到主配置
                self.logger.debug(f"[{self.name}] {task_type} 层级未配置，回退到默认配置")

        # 2. 使用主 llm 配置
        config = {}
        if self.agent_config and self.agent_config.llm:
            # 传递 model_adapter 以支持从 Provider 配置继承上下文/思考预算等元数据
            config = self.agent_config.llm.merge_with_default(
                self.system_config,
                model_adapter=self.model_adapter
            )
        elif self.system_config:
            llm_config = getattr(self.system_config, 'llm', None)
            if llm_config:
                config = {
                    'provider': getattr(llm_config, 'provider', None),
                    'provider_type': getattr(llm_config, 'provider_type', None),
                    'model_name': getattr(llm_config, 'model_name', None),
                    'temperature': getattr(llm_config, 'temperature', 0.7),
                    'max_tokens': getattr(llm_config, 'max_completion_tokens', None) or getattr(llm_config, 'max_tokens', 4096),
                    'max_completion_tokens': getattr(llm_config, 'max_completion_tokens', None) or getattr(llm_config, 'max_tokens', 4096),
                    'max_context_tokens': getattr(llm_config, 'max_context_tokens', None),
                    'thinking_budget_tokens': getattr(llm_config, 'thinking_budget_tokens', None),
                    'reasoning_effort': getattr(llm_config, 'reasoning_effort', None),
                    'retry_attempts': getattr(llm_config, 'retry_attempts', 10),
                    'retry_backoff_factor': getattr(llm_config, 'retry_backoff_factor', 2.5),
                }
        if not config:
            self.logger.warning(f"[{self.name}] 未配置 LLM，使用默认配置")
            config = {
                'temperature': 0.7,
                'max_tokens': 4096,
                'max_completion_tokens': 4096,
                'retry_attempts': 10,
                'retry_backoff_factor': 2.5,
            }

        # 3. 应用请求级覆盖
        override = getattr(context, 'llm_override', None) if context else None
        if override:
            agent_llm = self.agent_config.llm if (self.agent_config and self.agent_config.llm) else None
            for key in ('provider', 'provider_type', 'model_name'):
                from_agent = agent_llm is not None and getattr(agent_llm, key, None) is not None
                if not from_agent and override.get(key):
                    config[key] = override[key]
        return config

    def get_custom_param(self, key: str, default: Any = None) -> Any:
        """获取自定义参数"""
        if self.agent_config and self.agent_config.custom_params:
            return self.agent_config.custom_params.get(key, default)
        return default

    def is_tool_enabled(self, tool_name: str) -> bool:
        """检查工具是否启用"""
        if self.agent_config and self.agent_config.tools:
            enabled_tools = self.agent_config.tools.enabled_tools
            return not enabled_tools or tool_name in enabled_tools
        return True

    def _setup_react_runtime(
        self,
        *,
        available_tools: Optional[List[Dict[str, Any]]] = None,
        available_skills: Optional[List[Any]] = None,
        event_bus = None,
        builtin_tool_getter: Optional[Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]]] = None,
        budget_profile_name: str = "worker",
        fallback_multiplier: Optional[float] = None,
        runtime_label: Optional[str] = None,
    ) -> None:
        """初始化 ReAct 运行时的公共组件。"""
        from agents.context.budget import (
            DEFAULT_MAX_COMPLETION_TOKENS,
            compute_context_budget,
            get_context_budget_profile,
        )
        from agents.artifacts import ArtifactStore
        from agents.context.config import ContextConfig
        from agents.context.observation_policy import ObservationPolicy
        from agents.context.pipeline import ContextPipeline
        from agents.context.prompt_materializer import PromptMaterializer
        from agents.monitoring.observation_window import ObservationWindowCollector
        from tools.result_normalizer import ToolResultNormalizer

        base_tools = list(available_tools or [])
        if builtin_tool_getter:
            base_tools = builtin_tool_getter(base_tools)

        self.available_tools = base_tools
        self.available_skills = list(available_skills or [])

        behavior_config = self.agent_config.custom_params.get('behavior', {}) if self.agent_config else {}
        self.max_rounds = behavior_config.get('rounds')
        self.base_prompt = behavior_config.get('system_prompt', '')
        budget_profile = get_context_budget_profile(
            behavior_config.get('budget_profile') or budget_profile_name
        )

        llm_config = self.get_llm_config()
        model_max_completion_tokens = (
            llm_config.get('max_completion_tokens')
            or llm_config.get('max_tokens', DEFAULT_MAX_COMPLETION_TOKENS)
        )
        model_context_window = llm_config.get('max_context_tokens')

        max_context_tokens = compute_context_budget(
            model_context_window=model_context_window,
            max_completion_tokens=model_max_completion_tokens,
            explicit_budget=behavior_config.get('max_context_tokens'),
            fallback_multiplier=behavior_config.get(
                'fallback_multiplier',
                fallback_multiplier if fallback_multiplier is not None else budget_profile.fallback_multiplier,
            ),
        )

        context_config = ContextConfig(
            max_tokens=max_context_tokens,
            budget_profile=budget_profile.name,
            model_name=llm_config.get('model_name'),
            compression_trigger_ratio=behavior_config.get(
                'compression_trigger_ratio',
                budget_profile.compression_trigger_ratio,
            ),
            summarize_max_tokens=behavior_config.get(
                'summarize_max_tokens',
                budget_profile.summarize_max_tokens,
            ),
            preserve_recent_turns=behavior_config.get(
                'preserve_recent_turns',
                budget_profile.preserve_recent_turns,
            ),
        )
        observation_window = ObservationWindowCollector()
        self.context_pipeline = ContextPipeline(
            config=context_config,
            model_adapter=self.model_adapter,
            get_llm_config_fn=lambda task_type=None: self.get_llm_config(task_type=task_type),
            logger=self.logger,
            observation_window=observation_window,
        )
        data_save_dir = behavior_config.get('data_save_dir') or None
        artifact_store = ArtifactStore(
            base_dir=data_save_dir,
            observation_window=observation_window,
        )
        self.result_normalizer = ToolResultNormalizer(
            observation_window=observation_window,
        )
        self.observation_policy = ObservationPolicy(
            max_context_tokens=context_config.max_tokens,
            budget_profile=budget_profile.name,
            inline_text_limit=behavior_config.get('observation_inline_text_limit'),
            inline_json_limit=behavior_config.get('observation_inline_json_limit'),
            summarize_limit=behavior_config.get('observation_summarize_limit'),
            artifact_ttl_seconds=behavior_config.get('observation_artifact_ttl_seconds'),
        )
        self.prompt_materializer = PromptMaterializer(
            artifact_store=artifact_store,
            observation_window=observation_window,
            large_data_threshold=self.observation_policy.large_data_threshold,
        )

        label = runtime_label or self.__class__.__name__
        self.logger.info(
            "%s '%s' 运行时初始化完成，可用工具: %s，可用 Skills: %s，模型输出限制: %s tokens，上下文窗口: %s，上下文预算: %s tokens",
            label,
            self.name,
            len(self.available_tools),
            len(self.available_skills),
            model_max_completion_tokens,
            model_context_window or '未配置',
            max_context_tokens,
        )
        self.logger.info("%s '%s' 使用上下文预算档位: %s", label, self.name, budget_profile.name)

    def _resolve_event_bus(self, context: AgentContext, event_bus = None):
        """获取当前 run 的事件总线。"""
        if event_bus is not None:
            return event_bus
        if hasattr(context, 'metadata'):
            context_event_bus = context.metadata.get('event_bus')
            if context_event_bus is not None:
                return context_event_bus
            run_id = context.metadata.get('run_id')
            if run_id:
                from agents.events.session_manager import get_run_event_bus
                return get_run_event_bus(run_id, session_id=getattr(context, 'session_id', None))
        return None

    def _ensure_publisher(
        self,
        context: AgentContext,
        *,
        event_bus = None,
        call_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        force_new: bool = False,
    ):
        """为当前执行构建 EventPublisher。"""
        from agents.events import EventPublisher

        resolved_event_bus = self._resolve_event_bus(context, event_bus=event_bus)
        current_session_id = getattr(context, 'session_id', None)
        if call_id is None:
            call_id = f"call_{uuid.uuid4()}"
        if parent_call_id is None and hasattr(context, 'metadata'):
            parent_call_id = context.metadata.get('parent_call_id') or context.metadata.get('parent_task_id')

        del force_new
        if resolved_event_bus is None:
            return None
        return EventPublisher(
            agent_name=self.name,
            session_id=current_session_id,
            trace_id=context.metadata.get('trace_id') if hasattr(context, 'metadata') else None,
            span_id=context.metadata.get('span_id') if hasattr(context, 'metadata') else None,
            call_id=call_id,
            parent_call_id=parent_call_id,
            event_bus=resolved_event_bus,
        )

    def _handle_user_input_request(
        self,
        arguments: Dict[str, Any],
        event_bus,
        session_id: Optional[str],
        tool_call_id: str,
        publisher=None,
        parent_call_id: Optional[str] = None,
        log_label: Optional[str] = None,
    ) -> Optional[str]:
        """处理 request_user_input 伪工具调用。"""
        from agents.events import EventType
        from agents.events.bus import Event
        from agents.task_registry import get_task_registry

        prompt = arguments.get('prompt', '请提供额外信息')
        input_type = arguments.get('input_type', 'text')
        options = arguments.get('options', [])

        input_id = str(uuid.uuid4())
        registry = get_task_registry()
        wait_evt = registry.add_pending_input(session_id, input_id) if session_id else None

        if publisher:
            publisher.tool_call_start(
                call_id=tool_call_id,
                tool_name='request_user_input',
                arguments=arguments,
                parent_call_id=parent_call_id,
            )

        if event_bus:
            event_bus.publish(Event(
                type=EventType.USER_INPUT_REQUIRED,
                session_id=session_id,
                agent_name=self.name,
                data={
                    "input_id": input_id,
                    "tool_call_id": tool_call_id,
                    "prompt": prompt,
                    "input_type": input_type,
                    "options": options,
                }
            ))

        prefix = log_label or self.display_name or self.name
        self.logger.info("[%s] 等待用户输入 input_id=%s prompt=%r", prefix, input_id, prompt[:60])

        if wait_evt is None:
            self.logger.warning("request_user_input: 缺少 session_id，无法等待用户输入")
            if publisher:
                publisher.tool_call_end(
                    call_id=tool_call_id,
                    tool_name='request_user_input',
                    result='（无 session，跳过）',
                    parent_call_id=parent_call_id,
                )
            return ""

        started_at = time.time()
        from utils.timeout_pause import pause_current, resume_current

        pause_current()
        try:
            wait_evt.wait()
        finally:
            resume_current()
        value = registry.get_input_result(session_id, input_id)

        if publisher:
            publisher.tool_call_end(
                call_id=tool_call_id,
                tool_name='request_user_input',
                result=value if value else '（已取消）',
                execution_time=time.time() - started_at,
                parent_call_id=parent_call_id,
            )

        self.logger.info("[%s] 用户输入已接收 input_id=%s", prefix, input_id)
        return value if value != "" else None

    def _publish_visualization_candidate(self, candidate: Dict[str, Any]) -> None:
        """[Deprecated] 新架构下不再通过 SSE 推送可视化数据。"""
        pass

    def _publish_deferred_visualizations(self, candidates: Optional[List[Dict[str, Any]]]) -> None:
        """[Deprecated] 新架构下不再通过 SSE 推送可视化数据。"""
        pass

    def _get_runtime_log_label(self) -> str:
        """返回运行时日志展示名。"""
        return "ReAct"

    def _prepare_execution_state(
        self,
        task: str,
        context: AgentContext,
        start_time: float,
    ) -> Dict[str, Any]:
        """准备一次标准 ReAct 执行的初始状态。"""
        event_bus = self._resolve_event_bus(context)
        current_call_id = None
        parent_call_id = None
        if hasattr(context, 'metadata'):
            current_call_id = context.metadata.get('call_id')
            parent_call_id = context.metadata.get('parent_call_id') or context.metadata.get('parent_task_id')
        if not current_call_id:
            current_call_id = f"call_{uuid.uuid4()}"

        publisher = self._ensure_publisher(
            context,
            event_bus=event_bus,
            call_id=current_call_id,
            parent_call_id=parent_call_id,
        )
        if publisher:
            metadata = {}
            if self.max_rounds is not None:
                metadata['max_rounds'] = self.max_rounds
            publisher.agent_start(task, metadata=metadata)

        return {
            'start_time': start_time,
            'event_bus': event_bus,
            'publisher': publisher,
            'call_id': current_call_id,
            'parent_call_id': parent_call_id,
            'current_session': [{"role": "user", "content": task}],
            'tool_calls_history': [],
            'rounds': 0,
        }

    def _publish_context_usage(self, managed_messages, rounds: int, publisher) -> None:
        """发布上下文用量事件。"""
        if not publisher:
            return
        from agents.events.bus import EventType

        current_tokens = self.context_pipeline._token_counter.count_messages(managed_messages)
        # 分离 system_prompt tokens，使前端展示口径一致
        system_tokens = self.context_pipeline._token_counter.count_messages([managed_messages[0]]) if managed_messages else 0
        session_tokens = current_tokens - system_tokens
        budget_tokens = self.context_pipeline.config.max_tokens + system_tokens  # 总输入预算
        publisher._publish(EventType.CONTEXT_USAGE, {
            'used_tokens': current_tokens,
            'system_prompt_tokens': system_tokens,
            'total_tokens': current_tokens,
            'budget_tokens': budget_tokens,
            'round': rounds,
        })

    def _format_assistant_context_message(
        self,
        intent: str,
        actions: Optional[List[Dict[str, Any]]],
        final_answer: Optional[str],
        full_response: str,
    ) -> str:
        """返回适合上下文存储的 assistant 消息内容（原始 LLM 输出）。"""
        return (full_response or "").strip()

    def _on_assistant_message(
        self,
        intent: str,
        actions: Optional[List[Dict[str, Any]]],
        full_response: str,
        final_answer: str,
        rounds: int,
        state: Dict[str, Any],
    ) -> None:
        """处理一轮模型返回后的 assistant 消息。"""
        publisher = state.get('publisher')
        if not publisher or final_answer:
            return
        content = self._format_assistant_context_message(
            intent=intent,
            actions=actions,
            final_answer=final_answer,
            full_response=full_response,
        )
        if not content:
            return
        publisher.react_intermediate(
            role="assistant",
            content=content,
            round=rounds,
            msg_type="assistant_response",
        )

    def _record_visualization_result(
        self,
        tool_name: str,
        result: Any,
        state: Dict[str, Any],
    ) -> None:
        """[Deprecated] 新架构下可视化通过 artifact_id 持久化，不再收集事件。"""
        pass

    def _format_tool_observation(
        self,
        result: Any,
        *,
        tool_name: str | None = None,
        session_id: str | None = None,
        is_skills_tool: bool = False,
    ) -> str:
        """Format normalized tool results into observation text."""
        if (
            self.result_normalizer is None
            or self.observation_policy is None
            or self.prompt_materializer is None
        ):
            raise RuntimeError("Observation formatting runtime is not configured")

        normalized = self.result_normalizer.normalize(result, tool_name=tool_name)
        decision = self.observation_policy.decide(
            normalized,
            is_skills_tool=is_skills_tool,
        )
        return self.prompt_materializer.materialize_tool_observation(
            normalized,
            decision,
            tool_name=tool_name or "",
            is_skills_tool=is_skills_tool,
            session_id=session_id,
        )

    @staticmethod
    def _compact_text(value: Any, *, max_chars: int = 220) -> str:
        text = "" if value is None else str(value)
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) <= max_chars:
            return text
        return text[: max_chars - 3].rstrip() + "..."

    def _handle_actions(
        self,
        actions: List[Dict[str, Any]],
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
        log_prefix: str,
    ) -> None:
        """默认动作处理：直接工具执行。"""
        from tools.response_builder import success_result, error_result
        from tools.result_references import result_event_payload
        from tools.tool_executor import execute_tool
        from tools.tool_registry import get_tool_registry

        tool_registry = get_tool_registry()
        event_bus = state.get('event_bus')
        publisher = state.get('publisher')
        current_session_id = getattr(context, 'session_id', None)
        observations: List[str] = []
        emit_event = getattr(self, '_emit_event', None)
        tool_results: Dict[int, Any] = {}

        for idx, action in enumerate(actions, 1):
            self._check_interrupt(context)

            tool_name = action.get('tool')
            arguments = action.get('arguments', {})
            if not tool_name:
                continue

            resolver = getattr(self, '_resolve_tool_references', None)
            if callable(resolver) and tool_results:
                original_arguments = arguments
                try:
                    arguments = resolver(arguments, tool_results, idx)
                    if arguments != original_arguments:
                        self.logger.info(
                            f"{log_prefix} 占位符替换: {original_arguments} -> {arguments}"
                        )
                except Exception as error:
                    self.logger.warning(
                        "%s 占位符替换失败，沿用原始参数: %s",
                        log_prefix,
                        error,
                    )

            self.logger.info(f"{log_prefix} [{idx}/{len(actions)}] 执行工具: {tool_name}, 参数: {arguments}")
            tool_call_id = f"tool_{uuid.uuid4()}"

            # C6: 拦截未替换的占位符
            from tools.result_references import detect_unresolved_placeholders
            unresolved = detect_unresolved_placeholders(arguments)
            if unresolved:
                observation = f"[{tool_name}] 参数中包含未替换的占位符: {', '.join(unresolved)}，请检查引用路径是否正确"
                observations.append(observation)
                tool_results[idx] = error_result(observation, tool_name=tool_name)
                continue

            if tool_name == 'request_user_input':
                user_value = self._handle_user_input_request(
                    arguments=arguments,
                    event_bus=event_bus,
                    session_id=current_session_id,
                    tool_call_id=tool_call_id,
                    publisher=publisher,
                    parent_call_id=state.get('call_id'),
                )
                if user_value is None:
                    self._check_interrupt(context)
                    user_value = ""
                observations.append(f"[{tool_name}]\n用户输入: {user_value}")
                tool_results[idx] = success_result(
                    content=user_value,
                    summary="用户输入",
                    tool_name=tool_name,
                )
                state.setdefault('tool_calls_history', []).append({
                    'tool_name': tool_name,
                    'arguments': arguments,
                    'result': {'success': True, 'user_input': user_value},
                })
                continue

            if callable(emit_event):
                emit_event('tool_start', {
                    'tool_call_id': tool_call_id,
                    'tool_name': tool_name,
                    'arguments': arguments,
                    'index': idx,
                    'total': len(actions),
                }, publisher=publisher, agent_call_id=state.get('call_id'), session_id=current_session_id)
            elif publisher:
                publisher.tool_call_start(
                    call_id=tool_call_id,
                    tool_name=tool_name,
                    arguments=arguments,
                    parent_call_id=state.get('call_id'),
                    round=rounds,
                )

            tool_started_at = time.time()
            result = execute_tool(
                tool_name,
                arguments,
                agent_config=self.agent_config,
                event_bus=event_bus,
                session_id=current_session_id,
                cancel_event=context.metadata.get('cancel_event') if hasattr(context, 'metadata') else None,
            )
            elapsed_time = time.time() - tool_started_at
            is_skills_tool = tool_name in tool_registry.get_skill_tool_names()
            observation = self._format_tool_observation(
                result,
                tool_name=tool_name,
                session_id=current_session_id,
                is_skills_tool=is_skills_tool,
            )

            if callable(emit_event):
                emit_event('tool_end', {
                    'tool_call_id': tool_call_id,
                    'tool_name': tool_name,
                    'result': result,
                    'elapsed_time': elapsed_time,
                    'index': idx,
                    'total': len(actions),
                }, publisher=publisher, agent_call_id=state.get('call_id'), session_id=current_session_id)
            elif publisher:
                preview_text = f"[{tool_name}]\n{observation}" if observation else ""
                tool_success = getattr(result, 'success', True) if result is not None else True
                publisher.tool_call_end(
                    call_id=tool_call_id,
                    tool_name=tool_name,
                    result=preview_text,
                    result_preview=preview_text,
                    raw_result=result_event_payload(result),
                    raw_result_ref={
                        'session_id': current_session_id,
                        'call_id': tool_call_id,
                        'tool_name': tool_name,
                    },
                    execution_time=elapsed_time,
                    parent_call_id=state.get('call_id'),
                    success=tool_success,
                    round=rounds,
                )

            self._record_visualization_result(tool_name, result, state)
            tool_results[idx] = result
            state.setdefault('tool_calls_history', []).append({
                'tool_name': tool_name,
                'arguments': arguments,
                'result': result,
            })
            if observation:
                observations.append(f"[{tool_name}]\n{observation}")

        combined_observations = "\n\n".join(observations)
        state['current_session'].append({
            "role": "user",
            "content": combined_observations,
        })
        if publisher and combined_observations:
            publisher.react_intermediate(
                role="user",
                content=combined_observations,
                round=rounds,
                msg_type="observation",
            )

    def _handle_no_action(
        self,
        llm_result: Any,
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
        log_prefix: str,
    ) -> None:
        """处理既无 action 也无最终答案的场景。"""
        del context, rounds
        parse_fail_hint = f"（工具参数解析失败: {llm_result.error}）" if llm_result.error else ""
        self.logger.warning(f"{log_prefix} LLM 既没有调用工具也没有给出最终答案{parse_fail_hint}")
        state['current_session'].append({
            "role": "user",
            "content": (
                f"工具参数解析失败{parse_fail_hint}，请使用 XML 子标签格式传递参数，例如：\n"
                "<tools>\n<tool name=\"工具名\">\n  <参数名>值</参数名>\n</tool>\n</tools>\n"
                "多行文本或含特殊字符的参数值用 CDATA 包裹：<参数名><![CDATA[内容]]></参数名>"
            ) if llm_result.error else "请直接输出 <final_answer> 或 <tools>。"
        })

    def _handle_llm_error(
        self,
        error_message: str,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理 LLM 调用错误。"""
        del context
        publisher = state.get('publisher')
        if publisher:
            publisher.agent_error(error=error_message, error_type="LLMError")
        return AgentResponse(
            success=False,
            content="",
            error=error_message,
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _handle_final_answer(
        self,
        final_answer: str,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理最终答案。"""
        del context

        publisher = state.get('publisher')
        if publisher:
            publisher.final_answer(final_answer)
            publisher.agent_end(
                result=final_answer,
                execution_time=time.time() - start_time,
            )

        return AgentResponse(
            success=True,
            content=final_answer,
            agent_name=self.name,
            execution_time=time.time() - start_time,
            tool_calls=state.get('tool_calls_history', []),
            metadata={
                'rounds': state.get('rounds', 0),
                'reasoning_steps': [
                    msg for msg in state.get('current_session', [])
                    if msg.get('role') == 'assistant'
                ],
            },
        )

    def _handle_max_rounds(
        self,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理达到最大轮数的情况。"""
        del context
        self.logger.warning(f"{self._log_prefix(None, self._get_runtime_log_label())} 达到最大轮数 {self.max_rounds}")
        final_content = "抱歉，经过多轮分析后仍无法给出完整答案。建议重新描述问题或提供更多信息。"
        publisher = state.get('publisher')
        if publisher:
            publisher.final_answer(final_content)
            publisher.agent_end(
                result=final_content,
                execution_time=time.time() - start_time,
            )
        return AgentResponse(
            success=True,
            content=final_content,
            agent_name=self.name,
            execution_time=time.time() - start_time,
            tool_calls=state.get('tool_calls_history', []),
            metadata={
                'rounds': state.get('rounds', 0),
                'max_rounds_reached': True,
            },
        )

    def _handle_interrupted(
        self,
        error: InterruptedError,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理中断。"""
        del context
        self.logger.info(f"任务被用户中断: {error}")
        publisher = state.get('publisher')
        if publisher:
            publisher.agent_error(error=str(error), error_type="InterruptedError")
            publisher.agent_end(
                result="[已停止生成]",
                execution_time=time.time() - start_time,
            )
        return AgentResponse(
            success=False,
            content="[已停止生成]",
            error="interrupted",
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _handle_execution_error(
        self,
        error: Exception,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        """处理未捕获异常。"""
        del context
        self.logger.error(f"执行任务失败: {error}", exc_info=True)
        publisher = state.get('publisher')
        if publisher:
            publisher.agent_error(error=str(error), error_type="ExecutionError")
            publisher.agent_end(
                result=str(error),
                execution_time=time.time() - start_time,
            )
        return AgentResponse(
            success=False,
            content=str(error),
            error=str(error),
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _cleanup_execution(
        self,
        context: AgentContext,
        state: Dict[str, Any],
    ) -> None:
        """清理执行态资源。默认无操作。"""
        del context, state

    def _execute_react_task(self, task: str, context: AgentContext) -> AgentResponse:
        """统一的 ReAct 主循环。"""
        from agents.streaming import StreamExecutor

        start_time = time.time()
        state: Dict[str, Any] = {}
        try:
            state = self._prepare_execution_state(task, context, start_time)
            current_session = state['current_session']
            publisher = state.get('publisher')

            while True:
                if self.max_rounds is not None and state['rounds'] >= self.max_rounds:
                    return self._handle_max_rounds(context, state, start_time)
                state['rounds'] += 1
                rounds = state['rounds']

                self._check_interrupt(context)
                llm_config = self.get_llm_config(context)
                log_prefix = self._log_prefix(llm_config, self._get_runtime_log_label())
                self.logger.info(f"{log_prefix} 第 {rounds} 轮推理")

                managed_messages = self.context_pipeline.prepare_messages(
                    system_prompt=self._build_system_prompt(),
                    context=context,
                    current_session=current_session,
                    publisher=publisher,
                    llm_config=llm_config,
                )
                self.logger.info(f"{log_prefix} {self.context_pipeline.format_summary(managed_messages)}")
                self._publish_context_usage(managed_messages, rounds, publisher)

                stream_executor = StreamExecutor(
                    model_adapter=self.model_adapter,
                    publisher=publisher,
                    agent_logger=self.logger,
                )
                result = stream_executor.execute_llm_stream(
                    messages=managed_messages,
                    llm_config=llm_config,
                    round_num=rounds,
                    cancel_event=context.metadata.get('cancel_event'),
                )

                self._check_interrupt(context)

                if result.error:
                    if result.error == 'interrupted':
                        raise InterruptedError("LLM 调用被中断")
                    return self._handle_llm_error(
                        f"LLM 调用失败: {result.error}",
                        context,
                        state,
                        start_time,
                    )

                intent = result.intent
                actions = result.actions or []
                final_answer = result.answer
                full_response = result.full_response
                if actions and final_answer:
                    self.logger.info("%s 同轮同时返回了 actions 与 answer，当前轮先忽略 answer", log_prefix)
                    final_answer = None

                if intent:
                    self.logger.info(f"{log_prefix} Intent: {intent[:100]}...")
                elif actions:
                    self.logger.info(f"{log_prefix} Actions: {len(actions)} tool(s): {[a.get('tool_name', '?') for a in actions]}")
                elif final_answer:
                    self.logger.info(f"{log_prefix} Answer: {final_answer[:100]}...")

                assistant_message = self._format_assistant_context_message(
                    intent=intent,
                    actions=actions,
                    final_answer=final_answer,
                    full_response=full_response,
                )
                current_session.append({
                    "role": "assistant",
                    "content": assistant_message,
                })
                self._on_assistant_message(intent, actions, full_response, final_answer, rounds, state)

                if actions:
                    self.logger.info(f"{log_prefix} 执行 {len(actions)} 个动作")
                    self._handle_actions(actions, context, state, rounds, log_prefix)
                    continue

                if final_answer:
                    return self._handle_final_answer(final_answer, context, state, start_time)

                self._handle_no_action(result, context, state, rounds, log_prefix)
        except InterruptedError as error:
            try:
                return self._handle_interrupted(error, context, state, start_time)
            except Exception as handler_error:
                self.logger.error("处理中断收尾失败: %s", handler_error, exc_info=True)
                publisher = state.get('publisher')
                if publisher:
                    try:
                        publisher.agent_end(
                            result="[已停止生成]",
                            execution_time=time.time() - start_time,
                        )
                    except Exception:
                        pass
                return AgentResponse(
                    success=False,
                    content="[已停止生成]",
                    error="interrupted",
                    agent_name=self.name,
                    execution_time=time.time() - start_time,
                )
        except Exception as error:
            try:
                return self._handle_execution_error(error, context, state, start_time)
            except Exception as handler_error:
                self.logger.error("处理执行异常收尾失败: %s", handler_error, exc_info=True)
                publisher = state.get('publisher')
                if publisher:
                    try:
                        publisher.agent_end(
                            result=str(error),
                            execution_time=time.time() - start_time,
                        )
                    except Exception:
                        pass
                return AgentResponse(
                    success=False,
                    content="",
                    error=str(error),
                    agent_name=self.name,
                    execution_time=time.time() - start_time,
                )
        finally:
            try:
                self._cleanup_execution(context, state)
            except Exception as cleanup_error:
                self.logger.warning("清理执行态资源失败: %s", cleanup_error, exc_info=True)

    def _check_interrupt(self, context: AgentContext):
        """检查是否被用户中断"""
        cancel_event = context.metadata.get('cancel_event') if hasattr(context, 'metadata') else None
        if cancel_event and cancel_event.is_set():
            raise InterruptedError(f"Agent {self.name} 被用户中断")

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__}(name='{self.name}')>"


class AgentExecutionError(Exception):
    """智能体执行错误"""

    def __init__(self, agent_name: str, message: str, original_error: Optional[Exception] = None):
        self.agent_name = agent_name
        self.message = message
        self.original_error = original_error
        super().__init__(f"[{agent_name}] {message}")
