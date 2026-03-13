# Tool Observation 协议化迁移步骤

> 状态更新：2026-03-12
>
> 2026-03-13 补充说明：
>
> 1. 当前运行时仍保留 `inline / summarize / artifact_ref` 三种模式。
> 2. 但 `summarize` 物化已不再按 `snippet_limit` 对正文做截断。
> 3. `no_truncate` / `snippet_limit` 已不再是当前主链的有效运行时接口，本文相关内容应视为迁移记录，而不是现行实现约束。
>
> 当前真实进度不是“准备开始迁移”，而是：
>
> 1. `ToolExecutionResult` / `ToolResultNormalizer` 已落地。
> 2. `ObservationPolicy` / `PromptMaterializer` 已落地，并接入 Agent 主链路。
> 3. `ArtifactStore` 已独立，并补充了 artifact 元数据索引、`session_id` 跟踪、TTL 清理。
> 4. `ObservationWindowCollector` 已可输出 materialization / spill / compression / trim 指标。
> 5. `ObservationFormatter` 已删除，Agent 已直接走 `normalize -> decide -> materialize`。
> 6. 多桶预算与 artifact 生命周期治理联动已落地保守版本：
>    - `inline / summarize / artifact_ref`
>    - session 级 artifact 跟踪
>    - bucket 驱动的 artifact TTL

建议阅读方式：

1. `Phase A`、`Phase B` 可视为已完成或基本完成的迁移记录。
2. 当前真正的下一步应优先转向：
   - 基于真实 observation window 数据微调 bucket 阈值
   - 如有必要，再引入更细粒度的 summarize / drop 策略
3. 不应再按本文早期表述，把 `ArtifactStore` 视为“待抽离”组件，也不应再把 `ObservationFormatter` 视为现存运行时入口。

## 1. 目标

当前系统中，工具执行结果进入上下文已经收敛为：

`ToolExecutionResult -> ObservationPolicy -> PromptMaterializer`

这套方式的问题是：

1. 工具返回协议不稳定。
2. 格式化、落盘、副作用、提示词拼装耦合在一起。
3. 新工具类型越多，`if/elif` 越膨胀。
4. token 预算控制只能后置，不能前置决策。

同时文件落盘、副作用治理已抽到独立 `ArtifactStore`。

这里的模块归属做如下调整：

1. 工具结果协议属于 `tools/`
2. 上下文化决策属于 `agents/context/`
3. artifact 存储属于独立域，不放在 `context/`

这份计划基于当前实际代码补充三条硬约束：

1. Phase A 的 normalizer 必须显式覆盖当前已知工具返回形态，不能只依赖通用字段探测。
2. Phase B 的 artifact 路径规则必须与当前 `./static/temp_data/data_{uuid}.json` 保持兼容。
3. Phase B 与 Phase C 之间必须加入观察窗口，先收集真实分布，再配置 policy。

---

## 2. 目标架构

建议形成四层结构：

### 2.1 Tool Result Schema

职责：

1. 统一工具执行结果协议。
2. 消除“有的工具返回字符串，有的返回 dict，有的返回 markdown”的混乱状态。

建议新增模块：

1. `tools/result_schema.py`

建议核心结构：

```python
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class ArtifactRef:
    artifact_type: str
    path: str
    mime_type: Optional[str] = None
    size: Optional[int] = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolExecutionResult:
    success: bool
    tool_name: str
    summary: str = ""
    answer: Optional[str] = None
    output_type: str = "text"  # text/json/table/file/chart/map/markdown/error
    content: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)
    artifacts: list[ArtifactRef] = field(default_factory=list)
    llm_hint: Optional[str] = None
```

字段约束：

1. `answer`
   Phase A 仅从 `data.answer` 映射。
2. `llm_hint`
   Phase A 先统一置为 `None`，暂不做来源推断。
3. `output_type`
   必须在 Phase A 就固化推断规则，不能拖到 Phase C。

### 2.2 Artifact Store

职责：

1. 处理大结果落盘。
2. 负责 artifact 的路径、TTL、元数据、清理。
3. formatter 不再直接 `open()` 写文件。

建议新增模块：

1. `agents/artifacts/artifact_store.py`

建议接口：

```python
class ArtifactStore:
    def save_json(self, *, session_id: str | None, tool_name: str, data: Any) -> ArtifactRef: ...
    def save_text(self, *, session_id: str | None, tool_name: str, content: str) -> ArtifactRef: ...
    def cleanup(self, max_age_seconds: int) -> int: ...
```

兼容要求：

1. 默认目录保持 `./static/temp_data`
2. 文件名格式保持 `data_{uuid}.json`
3. observation 文本中的文件路径格式不变

### 2.3 Observation Policy

职责：

1. 决定工具结果如何进入上下文。
2. 判断内联、摘要、落盘、丢弃。
3. 为后续 token budget 前置控制做准备。

建议新增模块：

1. `agents/context/observation_policy.py`

建议接口：

```python
@dataclass
class ObservationDecision:
    mode: str  # inline / summarize / artifact_ref / drop
    reason: str = ""


class ObservationPolicy:
    def decide(self, result: ToolExecutionResult) -> ObservationDecision: ...
```

### 2.4 Prompt Materializer

职责：

1. 把已经决策好的 observation 物化为 LLM 可读文本。
2. 只负责输出文本，不负责做业务判断。

建议新增模块：

1. `agents/context/prompt_materializer.py`

建议接口：

```python
class PromptMaterializer:
    def materialize_tool_observation(
        self,
        result: ToolExecutionResult,
        decision: ObservationDecision,
    ) -> str:
        ...
```

---

## 3. 与当前代码的对应关系

当前对应点：

1. 工具执行入口在 [react/agent.py](E:\Python\RAGSystem\backend-fastapi\agents\implementations\react\agent.py) 和 [orchestrator/agent.py](E:\Python\RAGSystem\backend-fastapi\agents\implementations\orchestrator\agent.py)。
2. 当前 observation 文本生成由 [observation_formatter.py](E:\Python\RAGSystem\backend-fastapi\agents\context\observation_formatter.py) 完成。
3. 大结果文件清理由 [conversation_store.py](E:\Python\RAGSystem\backend-fastapi\services\conversation_store.py) 负责。

迁移后的对应关系：

1. Agent 不再依赖“大而全”的 formatter。
2. Agent 只做三步：
   - normalize
   - decide
   - materialize
3. 落盘由 `ArtifactStore` 负责。
4. `ObservationFormatter` 已删除。

---

## 4. 可执行迁移步骤

## Phase A：先引入协议，不改行为

目标：

1. 先把内部模型建起来。
2. 保持现有输出文本不变。

任务：

1. 新增 `tools/result_schema.py`
2. 新增 `tools/result_normalizer.py`
3. 把当前 `ObservationFormatter.format()` 的输入先统一转成 `ToolExecutionResult`
4. 保留 `ObservationFormatter`，但内部第一步改为 `normalize(raw_result)`
5. 按工具名分组，显式覆盖当前已知返回形态，不靠模糊字段探测兜底

建议文件：

1. 新增 [result_schema.py](E:\Python\RAGSystem\backend-fastapi\tools\result_schema.py)
2. 新增 `tools/result_normalizer.py`
3. 修改 [observation_formatter.py](E:\Python\RAGSystem\backend-fastapi\agents\context\observation_formatter.py)

验收标准：

1. Agent 输出文本与当前版本一致。
2. 现有工具无需修改即可运行。
3. 所有旧格式结果都能被 normalize。

风险控制：

1. Phase A 不动 Agent 主流程结构。
2. 不修改工具返回协议，只做内部适配。

### Phase A 必须固化的归一化规则

当前工具返回至少分为四类：

1. 标准格式
   形态：`{success, data: {results, summary, metadata}}`
2. 直接 dict
   形态：`{success, content/chunks/data, ...}`，没有 `data` 包装层
3. 混合格式
   形态：`{success, data: {results, summary}}`，有 `data` 层但字段不完整
4. 特殊格式
   形态：`approval_message` 在外层，而不是 `data` 内部

因此 normalizer 应遵循：

1. 先按工具名命中分组
2. 再走该分组对应的 normalize 方法
3. 最后才允许极小范围兜底

### Phase A 的 output_type 推断规则

建议按工具名优先映射：

```python
TOOL_OUTPUT_TYPE_MAP = {
    "generate_chart": "chart",
    "generate_map": "map",
    "activate_skill": "markdown",
    "load_skill_resource": "markdown",
    "execute_skill_script": "text",
    "read_document": "text",
    "chunk_document": "json",
    "write_file": "text",
    "read_file": "text",
}
```

工具名命中不到时，再按内容兜底：

1. `str` -> `text`
2. `list/dict` -> `json`
3. error -> `error`

### Phase A 的文档工具单独处理

`document_executor.py` 中以下工具返回扁平 dict，而不是标准 `data.results` 结构：

1. `read_document`
2. `chunk_document`
3. `extract_structured_data`
4. `merge_extracted_data`

建议 normalizer 中单独提供私有方法：

1. `_normalize_document_result()`
2. `_normalize_document_chunk_result()`
3. `_normalize_document_extract_result()`
4. `_normalize_document_merge_result()`

需要把这类扁平 dict 提升成统一协议，而不是混到通用兜底分支。

## Phase B：抽离 ArtifactStore

目标：

1. 把副作用从 formatter 中拿走。
2. 统一大结果文件治理。

任务：

1. 新增 `agents/artifacts/artifact_store.py`
2. 把当前 `ObservationFormatter` 中的 `os.makedirs + open/json.dump` 迁移到 `ArtifactStore`
3. `ToolResultNormalizer` 或 `ObservationPolicy` 只生成“需要 artifact”的决策
4. `conversation_store.py` 中的临时文件清理逻辑改成调用 `ArtifactStore.cleanup()`

建议文件：

1. 新增 `agents/artifacts/artifact_store.py`
2. 修改 [observation_formatter.py](E:\Python\RAGSystem\backend-fastapi\agents\context\observation_formatter.py)
3. 修改 [conversation_store.py](E:\Python\RAGSystem\backend-fastapi\services\conversation_store.py)

验收标准：

1. formatter 中不再直接写文件。
2. artifact 路径规则统一。
3. 大结果 observation 仍与当前功能一致。
4. 前端和 LLM 看到的文件路径格式保持兼容。

### Phase B 的兼容要求

迁移到 `ArtifactStore` 后，不改变以下外部可见行为：

1. 路径前缀仍然是 `./static/temp_data/`
2. 文件名仍然是 `data_{uuid}.json`
3. observation 文本中的文件引用格式不变

### Phase B 的清理改造方式

迁移后建议改成：

1. `ArtifactStore.cleanup(max_age_seconds)` 负责目录扫描和命名规则
2. `ConversationStore._cleanup_temp_data_files()` 不再自己 `glob`
3. `ConversationStore` 只调用 `ArtifactStore.cleanup()`

这样后续如果路径规则调整，只改 `ArtifactStore` 一处。

## Observation Window：B 与 C 之间的观察窗口

目标：

1. 让 Phase C 的 policy 阈值基于真实数据，而不是拍脑袋配置。

观察项：

1. `output_type` 实际命中分布
2. 8000 字符阈值的触发频率
3. artifact 文件平均大小分布
4. 各工具命中的 normalize 分支分布

产出：

1. 一版真实工具结果类型覆盖率报告
2. 一版建议的 observation bucket 阈值
3. 一版是否需要分级 artifact 存储的结论

## Phase C：引入 ObservationPolicy

目标：

1. 把“如何进入上下文”的决策从 formatter 中拿走。

任务：

1. 新增 `agents/context/observation_policy.py`
2. 按以下规则先实现一个保守版本：
   - `str` 小文本：`inline`
   - `dict/list` 小结构：`inline`
   - 大结构：`artifact_ref`
   - skills markdown：`inline`
   - 错误：`inline`
3. `ObservationFormatter` 改成：
   - normalize
   - decide
   - render

建议文件：

1. 新增 `agents/context/observation_policy.py`
2. 修改 [observation_formatter.py](E:\Python\RAGSystem\backend-fastapi\agents\context\observation_formatter.py)

验收标准：

1. policy 可单测。
2. 是否落盘不再写死在 formatter 内部条件分支中。
3. observation bucket 阈值和 artifact 阈值来自观察窗口结果，而不是固定猜测。

## Phase D：引入 PromptMaterializer

目标：

1. 让“文本渲染”成为最后一步。
2. 为多种 observation 视图预留空间。

任务：

1. 新增 `agents/context/prompt_materializer.py`
2. 把当前 observation 的字符串拼接逻辑迁过去
3. 当前先实现一个 `LLMObservationMaterializer`
4. `ObservationFormatter` 退化为 facade，或改名为 `ObservationService`

建议文件：

1. 新增 `agents/context/prompt_materializer.py`
2. 修改 [observation_formatter.py](E:\Python\RAGSystem\backend-fastapi\agents\context\observation_formatter.py)
3. 修改 Agent 调用点：[react/agent.py](E:\Python\RAGSystem\backend-fastapi\agents\implementations\react\agent.py)、[orchestrator/agent.py](E:\Python\RAGSystem\backend-fastapi\agents\implementations\orchestrator\agent.py)

验收标准：

1. 渲染器不再关心原始工具返回结构。
2. 所有原始 result 都先被协议化。
3. `PromptMaterializer` 的输入只接受 `ToolExecutionResult + ObservationDecision`，不直接接受任何原始 `dict`。

## Phase E：删除 ObservationFormatter

目标：

1. 完成最终收敛。

任务：

1. 删除 `ObservationFormatter`
2. Agent 直接依赖：
   - `ToolResultNormalizer`
   - `ObservationPolicy`
   - `PromptMaterializer`
   - `ArtifactStore`
3. 调整 `agents/context/__init__.py` 导出
4. 删除 `ObservationFormatter` 的导出，并确认仓库内不存在 `from agents.context import ObservationFormatter` 的残留引用

验收标准：

1. 仓库内不再存在对 `ObservationFormatter` 的业务依赖。
2. 整个链路完全协议化。

---

## 5. 每一步的代码改动顺序

推荐按以下顺序实施，风险最低：

1. 先新增 schema，不删旧代码。
2. 再让 formatter 内部先 normalize。
3. 再抽 artifact 写文件逻辑。
4. 再加入 policy。
5. 再加入 materializer。
6. 最后删除旧 formatter。

不要反过来先删 `ObservationFormatter`，否则调用面会一下扩散到 Agent 层。

---

## 6. 测试迁移步骤

每个阶段都应该补测试，而不是最后一次性补。

### Phase A 测试

新增：

1. `test_tool_result_normalizer.py`

覆盖：

1. 标准 success dict
2. 非标准字符串返回
3. skills 结果
4. error dict
5. 文档工具扁平返回提升
6. approval_message 外层映射
7. `output_type` 映射规则

### Phase B 测试

新增：

1. `test_artifact_store.py`

覆盖：

1. JSON 落盘
2. 文本落盘
3. 路径命名
4. TTL/清理目录一致性
5. 与当前 `./static/temp_data/data_{uuid}.json` 兼容

### Phase C 测试

新增：

1. `test_observation_policy.py`

覆盖：

1. 小文本内联
2. 小 JSON 内联
3. 大 JSON 走 artifact
4. markdown 保持内联

### Phase D 测试

新增：

1. `test_prompt_materializer.py`

覆盖：

1. inline text 输出
2. artifact reference 输出
3. answer + data detail 输出

### 端到端回归

保留一组 end-to-end 测试，至少覆盖：

1. 普通工具返回小 JSON
2. 技能工具返回 markdown
3. 大数据工具返回文件路径引用

---

## 7. 建议的最小首批落地范围

如果只做第一轮迁移，建议只做到 Phase B，不要一口气做到 Phase E。

推荐首批范围：

1. `ToolExecutionResult`
2. `ToolResultNormalizer`
3. `ArtifactStore`
4. 让 `ObservationFormatter` 内部使用这两个组件
5. 加入一个短观察窗口再进入 Phase C

这样收益已经很明显：

1. 输入协议统一了。
2. 副作用隔离了。
3. 后续再做 policy 和 materializer 时，不需要推翻前面的工作。
4. Phase C 的策略阈值可以基于真实数据而不是猜测。

---

## 8. 迁移后目录建议

建议最终目录形态：

```text
tools/
  result_schema.py
  result_normalizer.py

agents/context/
  config.py
  pipeline.py
  compression_view.py
  token_counter.py
  observation_policy.py
  prompt_materializer.py

agents/artifacts/
  artifact_store.py
```

这套目录划分的语义是：

1. `tools/` 负责“工具产出协议”
2. `agents/context/` 负责“如何进入上下文”
3. `agents/artifacts/` 负责“落盘与引用”

---

## 9. 关键约束

迁移过程中建议坚持以下约束：

1. 工具层暂时不强推改协议，先由 normalizer 兼容现状。
2. policy 不直接写文件。
3. materializer 不做业务判断。
4. Agent 不直接操作 artifact 文件。
5. 所有大结果阈值统一收敛到 policy 或 artifact 配置，不要散落在多个类里。
6. 结果 schema 只放在 `tools/`，不要回流到 `context/`

---

## 10. 最终建议

最可实现、最稳妥的迁移路径不是“立刻推翻 ObservationFormatter”，而是：

1. 先协议化。
2. 再拆副作用。
3. 先观察真实分布。
4. 再拆决策。
5. 最后拆渲染。

也就是：

1. 先做 Phase A
2. 紧接着做 Phase B
3. 进入 Observation Window
4. 再推进 Phase C / D / E

这条路线实现成本低，风险可控，而且每一步都能独立验收。
