# -*- coding: utf-8 -*-
"""
ReAct Agent - 使用 XML 标签格式 + 流式输出

优势：
1. 不依赖 function calling API
2. 支持任何大模型
3. 推理过程实时流式可见（thinking_delta）
4. 最终答案逐字流式输出
"""

import logging
import json
from typing import Optional, Dict, Any, List
from agents.core import BaseAgent, AgentContext, AgentResponse
from tools.tool_registry import get_tool_registry

logger = logging.getLogger(__name__)
_TOOL_REGISTRY = get_tool_registry()


def _format_tool_contract(tool: Dict[str, Any]) -> List[str]:
    """Render extended tool metadata into prompt lines."""
    func = tool.get('function', {})
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
            lines.append(f"  ```json\n  {json.dumps(example, ensure_ascii=False, indent=2)}\n  ```")

    return lines


class ReActAgent(BaseAgent):
    """
    ReAct (Reasoning + Acting) 智能体

    使用 XML 标签格式 + 流式输出，支持实时展示思考和回答过程
    """

    def __init__(
        self,
        agent_name: str,
        display_name: str = None,
        description: str = None,
        model_adapter = None,
        agent_config = None,
        system_config = None,
        available_tools: Optional[List[Dict[str, Any]]] = None,
        available_skills: Optional[List] = None,  # 新增：Skills 列表
        event_callback = None,  # 新增：事件回调函数（向后兼容）
        event_bus = None  # 新增：会话级事件总线
    ):
        super().__init__(
            name=agent_name,
            description=description or display_name or agent_name,
            capabilities=['reasoning', 'tool_calling'],
            model_adapter=model_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.display_name = display_name or agent_name
        self.event_callback = event_callback  # 保存回调函数（向后兼容）
        from agents.context.budget import WORKER_CONTEXT_PROFILE_NAME
        self._setup_react_runtime(
            available_tools=available_tools,
            available_skills=available_skills,
            event_bus=event_bus,
            builtin_tool_getter=_TOOL_REGISTRY.get_builtin_tools_for_worker,
            budget_profile_name=WORKER_CONTEXT_PROFILE_NAME,
            runtime_label="ReActAgent",
        )

    def _handle_user_input_request(
        self,
        arguments: Dict[str, Any],
        event_bus,
        session_id: Optional[str],
        tool_call_id: str,
        publisher=None,
        parent_call_id: Optional[str] = None,
    ) -> Optional[str]:
        return super()._handle_user_input_request(
            arguments=arguments,
            event_bus=event_bus,
            session_id=session_id,
            tool_call_id=tool_call_id,
            publisher=publisher,
            parent_call_id=parent_call_id,
            log_label="ReAct",
        )

    def _emit_event(self, event_type: str, data: Dict[str, Any]):
        """
        发送事件到回调函数和事件总线

        支持两种方式（向后兼容）：
        1. 旧方式：通过 event_callback 回调函数
        2. 新方式：通过 EventPublisher 发布到事件总线
        """
        # 旧方式：回调函数（向后兼容）
        if self.event_callback:
            try:
                self.event_callback(event_type, data)
            except Exception as e:
                self.logger.warning(f"事件回调失败: {e}")

        # 新方式：事件总线
        if self._publisher:
            try:
                # ✨ 获取当前 ReActAgent 的 call_id（作为工具调用的 parent_call_id）
                agent_call_id = getattr(self, '_current_call_id', None)
                # 兼容旧 task_id
                if not agent_call_id:
                    agent_call_id = getattr(self, '_current_task_id', None)

                # 映射事件类型到 EventPublisher 方法
                if event_type in ('intent_structured', 'thinking_structured'):
                    self._publisher.intent_structured(
                        intent=data.get('intent', data.get('thinking', '')),
                        actions=data.get('actions', []),
                        reasoning=f"第 {data.get('round', 0)} 轮推理",
                        round=data.get('round'),
                    )
                elif event_type == 'tool_start':
                    # 生成唯一的 tool call_id
                    import uuid
                    tool_call_id = data.get('tool_call_id') or f"tool_{uuid.uuid4()}"

                    self._publisher.tool_call_start(
                        call_id=tool_call_id,
                        tool_name=data.get('tool_name'),
                        arguments=data.get('arguments', {}),
                        parent_call_id=agent_call_id  # ✨ 关联到 ReActAgent 的调用
                    )
                elif event_type == 'tool_end':
                    from tools.result_references import result_event_payload
                    self._publisher.tool_call_end(
                        call_id=data.get('tool_call_id'),
                        tool_name=data.get('tool_name'),
                        result=result_event_payload(data.get('result')),
                        execution_time=data.get('elapsed_time'),
                        parent_call_id=agent_call_id  # ✨ 关联到 ReActAgent 的调用
                    )
                elif event_type == 'tool_error':
                    self._publisher.tool_error(
                        tool_name=data.get('tool_name'),
                        error=data.get('error')
                    )
            except Exception as e:
                self.logger.warning(f"事件总线发布失败: {e}")

    def _build_system_prompt(self) -> str:
        """构建系统提示词"""
        # 构建详细的工具说明（包含参数定义）
        tools_desc_lines = []
        for tool in self.available_tools:
            func = tool['function']
            name = func['name']
            desc = func['description']
            params = func.get('parameters', {})

            # 基本描述
            tools_desc_lines.append(f"\n### {name}")
            tools_desc_lines.append(f"**描述**: {desc}")

            # 参数说明
            if params and 'properties' in params:
                tools_desc_lines.append("**参数**:")
                required = params.get('required', [])
                for param_name, param_info in params['properties'].items():
                    param_type = param_info.get('type', 'any')
                    param_desc = param_info.get('description', '')
                    required_mark = " (必填)" if param_name in required else " (可选)"
                    tools_desc_lines.append(f"  - `{param_name}` ({param_type}){required_mark}: {param_desc}")

            tools_desc_lines.extend(_format_tool_contract(tool))

        tools_desc = "\n".join(tools_desc_lines)

        # 构建 execute_code 可调用工具说明
        # 当 execute_code 在可用工具中时，告知 LLM 哪些工具可在 call_tool() 中调用
        code_callable_hint = ""
        has_execute_code = any(
            t['function']['name'] == 'execute_code' for t in self.available_tools
        )
        if has_execute_code:
            code_callable_tools = [
                t['function']['name']
                for t in self.available_tools
                if t['function']['name'] != 'execute_code'
                and 'code_execution' in t['function'].get('allowed_callers', ['direct'])
            ]
            if code_callable_tools:
                tools_list = ", ".join(f"`{t}`" for t in code_callable_tools)
                code_callable_hint = f"""

## execute_code 中可调用的工具

在 `execute_code` 的代码中使用 `call_tool(tool_name, arguments)` 时，**只能调用以下工具**：
{tools_list}

其他工具（如高风险写操作工具）不允许从代码中调用，只能直接作为 action 使用。"""

        # 构建 Skills 说明
        skills_desc = self._format_skills_description()

        # 🔒 动态生成示例：使用当前智能体可用的工具
        example_tool_name = self.available_tools[0]['function']['name'] if self.available_tools else "tool_name"
        example_params = self.available_tools[0]['function'].get('parameters', {}).get('properties', {})

        # 构造示例参数
        if example_params:
            first_param = list(example_params.keys())[0]
            example_arg_json = json.dumps({first_param: "示例值"}, ensure_ascii=False)
        else:
            example_arg_json = "{}"

        return f"""{self.base_prompt}

## 可用工具

{tools_desc}
{code_callable_hint}

## 领域知识 (Skills)

{skills_desc}

## 输出格式

**直接输出工具调用或答案，如需说明意图用 <intent>，禁止写推理分析。**

调用工具：
<tools>
<tool name="工具名">{{"参数": "值"}}</tool>
</tools>

给出最终答案：
<answer>
答案内容
</answer>

如需备注意图（可选，10字以内）：
<intent>激活技能</intent>
<tools>...</tools>

**规则：**
1. 只能使用"可用工具"中列出的工具
2. `<intent>` 只允许10字以内的动作标注，禁止写推理、分析、解释，或直接省略
3. 互相独立的工具调用放同一 <tools> 中并行
4. 链式调用：{{result_N}} 引用同轮第N个工具结果
5. 数据充足时直接输出 <answer>
6. 报错时下一轮换策略

**数据处理：**
- 批量查多实体 → `execute_code`（call_tool 循环）
- 工具返回文件路径 → 直接传给 `process_data_file` 或 `generate_chart`
- 内存中小数据格式变换 → `transform_data`

### 图表引用规则
只有调用了 `present_chart` / `generate_map` 的可视化结果才会真正发送前端。若本轮要展示图表，先用 `generate_chart` 产出草稿，必要时检查或修改配置，再调用 `present_chart`。最终答案中对每个要展示的可视化插入 [CHART:N]（N 从 1 起，独占一行，前后空行）。
"""

    def execute_stream(self, task: str, context: AgentContext) -> AgentResponse:
        """
        执行任务（向后兼容方法）

        注意：不再使用 yield 返回事件，所有事件通过事件总线发布
        前端应使用 SSEAdapter 订阅事件总线
        """
        return self.execute(task, context)

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """执行任务（非流式版本，兼容旧接口）"""
        return self._execute_react_task(task, context)

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        ReAct Agent 始终返回 True，让 OrchestratorAgent 通过 LLM 智能分析来决定路由
        """
        return True

    def _safe_json_dumps(self, obj):
        """
        安全地序列化对象为 JSON 字符串，处理 NaN/Infinity 等特殊值

        Args:
            obj: 要序列化的对象

        Returns:
            JSON 字符串
        """
        import json
        import math

        def clean_value(value):
            """递归清理 NaN 和 Infinity"""
            if isinstance(value, float):
                if math.isnan(value) or math.isinf(value):
                    return None  # 将 NaN/Inf 转换为 null
                return value
            elif isinstance(value, dict):
                return {k: clean_value(v) for k, v in value.items()}
            elif isinstance(value, list):
                return [clean_value(item) for item in value]
            else:
                return value

        cleaned_obj = clean_value(obj)
        return json.dumps(cleaned_obj, ensure_ascii=False)

    def _resolve_tool_references(self, arguments: dict, tool_results: dict, current_idx: int) -> dict:
        """
        解析工具参数中的引用占位符，替换为前面工具的实际结果

        支持的占位符格式：
        - {result_N}  - 引用第N个工具的完整结果
        - {result_N.content.xxx} - 引用第N个工具结果中的特定字段（JSON路径）
        - {result_1} 到 {result_N-1}  - 只能引用当前工具之前的结果

        Args:
            arguments: 工具的原始参数字典
            tool_results: 已执行工具的结果字典 {idx: result}
            current_idx: 当前工具的索引（从1开始）

        Returns:
            替换后的参数字典
        """
        import re
        from tools.result_references import (
            resolve_result_path,
            result_primary_content,
            stringify_result_value,
        )

        def replace_placeholder(match):
            """替换单个占位符"""
            full_match = match.group(0)  # 完整的 {{...}}
            ref_expr = match.group(1)     # {{}} 内的内容

            # 解析引用：result_N 或 result_N.path.to.field
            parts = ref_expr.split('.', 1)
            base_ref = parts[0]  # result_N
            json_path = parts[1] if len(parts) > 1 else None  # path.to.field

            # 提取索引 N
            if not base_ref.startswith('result_'):
                self.logger.warning(f"[链式调用] 无效的占位符格式: {full_match}")
                return full_match  # 保持原样

            try:
                ref_idx = int(base_ref.replace('result_', ''))
            except ValueError:
                self.logger.warning(f"[链式调用] 无法解析索引: {full_match}")
                return full_match

            # 检查是否引用了后面的工具（不允许）
            if ref_idx >= current_idx:
                self.logger.warning(
                    f"[链式调用] 工具 {current_idx} 不能引用后面的工具 {ref_idx}"
                )
                return full_match

            # 检查引用的工具是否已执行
            if ref_idx not in tool_results:
                self.logger.warning(
                    f"[链式调用] 工具 {current_idx} 引用的工具 {ref_idx} 尚未执行"
                )
                return full_match

            # 获取引用的结果
            result = tool_results[ref_idx]

            # 如果有 JSON 路径，提取特定字段
            if json_path:
                try:
                    value = resolve_result_path(result, json_path)
                    if value is None:
                        self.logger.warning(f"[链式调用] 无法访问路径 {json_path}")
                        return full_match

                    # 如果提取的值是字符串，直接返回；否则序列化为 JSON
                    return stringify_result_value(value)
                except Exception as e:
                    self.logger.warning(
                        f"[链式调用] 提取 JSON 路径失败: {json_path}, 错误: {e}"
                    )
                    return full_match
            else:
                # 没有 JSON 路径，返回完整结果
                primary_content = result_primary_content(result)
                if primary_content is not None:
                    return stringify_result_value(primary_content)

                # 兜底：返回整个 result 的 JSON 序列化
                return self._safe_json_dumps(result)

        # 递归处理参数字典中的所有字符串值
        def process_value(value):
            if isinstance(value, str):
                # 查找所有占位符 {result_N} 或 {result_N.path} 并替换
                # 使用单层花括号，更简洁直观
                pattern = r'\{(result_\d+(?:\.[a-zA-Z0-9_\.]+)?)\}'
                return re.sub(pattern, replace_placeholder, value)
            elif isinstance(value, dict):
                return {k: process_value(v) for k, v in value.items()}
            elif isinstance(value, list):
                return [process_value(item) for item in value]
            else:
                return value

        resolved = process_value(arguments)

        # 如果有替换发生，记录日志
        if resolved != arguments:
            self.logger.info(
                f"[链式调用] 工具 {current_idx} 的参数中发现占位符，已替换"
            )

        return resolved
