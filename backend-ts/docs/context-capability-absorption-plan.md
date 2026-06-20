# 上下文能力吸收计划：Python → TS

> 状态：方案已定（能力吸收，非模块替换）
> 基准日期：2026-06-20
> 关联代码：`backend-ts/src/services/agent/context*`、`backend-ts/src/services/agent/kernel/`

## 1. 背景与决策

TS 现役上下文子系统（`AgentContextService` 门面 + `beforeModel` 压缩 hook + store 落库）在重构后已收敛到合约驱动架构。对比已废弃的 Python `ContextPipeline`（`backend-fastapi/agents/context/pipeline.py`），Python 仍有 **4 项 TS 缺失的能力**值得吸收。

**决策：吸收能力，不搬模块。**

理由：
- TS 刚把 context 收归门面 + 职责分离，正踩在合约驱动路线上；Python `ContextPipeline` 是 1088 行大类（压缩/KV cache/prompt 组装/缓存全揉一起），整体移植是架构倒退。
- Python 压缩**不入库**（原地改写内存 `context.conversation_history`），TS **落 store**（`insertCompressionMessage`）。整体移植意味着退回不落库，破坏持久化契约。
- Python 是 duck typing + 全局 `get_config()` + 可变 dict；TS 是强类型 + 依赖注入 + contracts。移植实为重写。

## 2. 原则

- **合约优先**：context 门面接口（`prepare`/`recompact`/`forceCompact`/`buildUsage`/`snapshotContext`）签名不变，只换/补实现。
- **零技术债**：每项能力连根接入，禁补丁/双写/legacy 尾巴。
- **数据落地契约不变**：压缩结果仍走 `insertCompressionMessage` 落 store，绝不学 Python 内存写回。
- **独立可交付**：每阶段独立分支、可验收、可回滚。

## 3. 能力缺口与落点映射

| # | 能力 | Python 位置 | TS 现状 | TS 落点 | 阶段 |
|---|---|---|---|---|---|
| 1 | LLM 摘要 tier fallback | `_try_llm_summary` (fast→default→系统) | `summarizeSegment` 单 provider（default）；`llm_tiers` 只消费 default | `context-compression` 摘要路径 + tier resolver | 1 |
| 2 | 9 章节摘要 prompt | `_COMPACT_PROMPT_BODY`（含完整保留用户消息 + analysis 草稿） | `COMPACT_PROMPT_BODY` 6 章节 | `context-compression` prompt 常量 | 2 |
| 3 | observation 治理层 | `observation_formatters/` + `observation_policy` | 仅 `microcompactRuntimeHistoryMessages` 粗粒度清理 | `context-builder` 新增 formatter 层 | 3 |
| 4 | KV cache 利用与保活 | `_apply_prompt_cache_policy` + hidden keepalive | 前缀已逐字稳定（记忆快照按 scope 配置打指纹，记忆内容回写不进前缀）；但 **provider payload 从不打 `cache_control`**，keepalive 配置已落地却**无执行代码** | 4a：`llm-chat-client` Anthropic 路径打标；4b：新增 `kernel-plugins/keepalive/`（ToolProvider 装饰器） | 4 |

## 4. 分阶段实施

### 阶段 1：LLM 摘要 tier fallback（可靠性·低风险）

- **现状**：`generateSummary`（`context-compression/index.ts:355`）用调用方传入的单一 `provider`/`modelName`（来自 default tier）。TS 已有 `llm_tiers: z.record(...)`（`contracts/agent-config.ts:19`）支持任意 tier 名，但全代码只读 `default`。
- **做法**：新增 tier resolver，按 `fast → default → 系统配置` 逐级解析 `llm_tiers`，`summarizeSegment` 逐级尝试、前级失败（非 abort）降级。对齐 Python `_try_llm_summary` 去重逻辑。
- **落点**：`context-compression/index.ts`（`generateSummary` 改造 + 新增 resolver）；依赖 `systemConfig.llm` 兜底。
- **验收**：fast tier 不可用时自动降 default；单测覆盖逐级 fallback 与去重；`summarizeSegment` 的 fallback 截断语义不变。

> **已落地**：tier resolver `resolveSummaryTierCandidates`（`context-compression/index.ts`）按 fast→default→系统(`systemConfig.llm`) 逐级解析去重。tier 语义与运行选模一致：**`default` 层 = 调用方传入的运行已解析模型（`provider`/`modelName`，即 selectedLlm 覆盖 `llm_tiers.default` 后的结果）**，摘要恒以它为基准候选，故 selectedLlm-only 的 agent 也能正常 LLM 压缩；`fast` 等其它层 `llm_tiers` 配了且能解析就用配置的，没配 / 解析失败则回落到 `default`（去重后合并）；`system` 仅在显式配置且可解析时作末位兜底。每条候选经共享 `findProviderByRef`（抽取到 `runtime/provider-lookup.ts`，runtime-core 与压缩服务共用、禁双写）解析成 `ModelProviderConfig`，按 `(provider key, provider_type, model_name)` 三元组归一化去重。`summarizeSegment` 改候选循环（成功即返回 / 异常降级 / 空内容算失败 / `abort` 立即抛）。**压缩只走大模型摘要，已彻底移除有损截断兜底**：全候选失败时 `summarizeSegment` 返回 `null`，调用方据此跳过本轮压缩（`compressIfNeeded`→`skipped("summary_unavailable")`、`forceCompactSession`→`forceSkipped("summary_unavailable")`、`/compact` 如实回报失败），保留完整历史等下轮重试。摘要长度统一用 `summarizeMaxTokens`（tier 只决定用哪个模型）。门面靠注入 `RuntimeModelProviderPort` 解析 fast/system 候选。单测覆盖：fast 失败降 default、同模型去重只试一次、selectedLlm 覆盖 default、全失败返回 null、`abort` 不降级。

### 阶段 2：摘要 prompt 升级（质量·低风险）

- **现状**：`COMPACT_PROMPT_BODY`（`context-compression/index.ts:76`）6 章节；`formatCompactResponse` 已剥 `<analysis>`。
- **做法**：替换为 Python 的 9 章节结构（主要请求和意图 / 关键技术概念 / 文件和代码片段 / 错误与修复 / 问题解决 / **所有用户消息（完整保留）** / 待办任务 / 当前工作 / 可选的下一步），保留 `<analysis>` 草稿区。
- **落点**：`context-compression/index.ts` 的 `COMPACT_PROMPT_BODY` 常量。
- **验收**：摘要含"所有用户消息"章节；`formatCompactResponse` 正确剥 analysis 取 summary；回归测试。

### 阶段 3：observation 治理层（体积治理·中风险）

- **现状**：`microcompactRuntimeHistoryMessages`（`context-builder/history-view.ts:122`）只做"保留最近 N 条 observation、余者替换占位"的粗粒度清理，无 per-tool 结构化裁剪。
- **Python**：`observation_formatters/`（bash/grep/glob/json/web_fetch/chart… 按工具类型格式化）+ `observation_policy`（体积策略）。
- **做法**：新增 observation formatter 层（按 `msg_type`/工具类型裁剪与格式化），`microcompact` 降级为兜底。先接入高频工具（bash/grep/glob/read），其余走 fallback。
- **落点**：`context-builder/` 新增 `observation-formatters/` + policy；接入点在 `recent-messages-source.ts`。
- **验收**：各工具输出按策略裁剪且不丢关键信息；microcompact 行为不回归；单测 per-tool formatter。

> **已落地（独立于本阶段）**：循环内压缩已改为 **micro-first**（对齐 Python `pipeline.py:489-511` 的 microcompact→重判→压缩顺序）。`AgentContextService.recompact`（`context/index.ts`）现先 microcompact 廉价裁剪、按裁剪后 token 重判，仅当仍 ≥ 压缩阈值才走 `compressIfNeeded`（LLM 摘要）；micro 能压下去时不触发 LLM 压缩。微压缩门控（fingerprint 变 / TTL 过期）与落地契约（压缩仍落 store）不变。本阶段的 observation formatter 仍接 `recent-messages-source` 的 microcompact 这一步，二者互补。

### 阶段 4：KV cache 利用与保活（成本·新模块）

> **前置事实（已具备，勿当缺口）**：TS 的记忆前缀已逐字稳定——`MemoryIndexContextSource`（`context-builder/memory-index-source.ts:78-97`）把前缀块快照进 `memory_prefix_states`，指纹只对 **scope 配置**（`memory.ts:81-102`）哈希、**不含记忆内容**。agent 自己更新记忆是会话里的 tool 消息，**不进前缀**；前缀仅在 scope 配置变或 `forceMemoryPrefixRefresh`（压缩路径）时重建。
>
> 因此本阶段**不需要**"防记忆回写打掉缓存"——前缀本就不会因记忆内容变化而动。缺的只是两件：让 provider **真去缓存**这段稳定前缀（4a），以及空闲等待时**别让它过期**（4b）。

#### 4a：`cache_control` 打标（Anthropic 路径）

- **现状**：稳定前缀已有，但发给 provider 的 payload **从不带 `cache_control`**（全代码 grep 零命中），稳定性白白浪费。
- **做法**：在 `llm-chat-client.ts` 的 `buildAnthropicBody`（`:183`）里，对稳定前缀消息（system / 记忆索引块 / 压缩摘要）尾部打 `cache_control` 标注。**按 `provider_type` 分流**：
  - `anthropic`：打标。
  - OpenAI 类（`openai_chat/openai_resp/openai_proxy/deepseek/openrouter/modelscope`）：**不打、也无此字段**——其缓存为自动前缀缓存，只需前缀稳定（已具备），无需任何动作（可选传 `prompt_cache_key` 提命中，本阶段不做）。
- **落点**：`llm-chat-client.ts`（`buildAnthropicBody`）；稳定前缀边界由现成的记忆快照 / stable-prefix fingerprint 提供。
- **验收**：anthropic 请求 payload 带 `cache_control`；OpenAI 类 payload 无变化、无报错；前缀逐字稳定性不回归。

#### 4b：空闲保活（统一，不分 provider）

- **场景**：agent 在等某项任务完成（工具长跑 / `waitForToolResult` 后台等待），这段空闲里 provider KV cache 会过期，需定时保活续上。
- **现状**：keepalive 配置已落地（`system-config-service.ts:147-151`：`keepalive_interval_seconds: 240` / `keepalive_grace_seconds` / `max_keepalive_rounds: 20` / `allow_provider_keepalive` / `hidden_keepalive_token_budget: 8`），monitoring 有 `total_keepalive_rounds`，但**执行代码不存在**（僵尸配置，性质同 checkpoint）。本阶段是**接线现存配置**，非从零移植。
- **做法**：新增 `kernel-plugins/keepalive/`：
  - **`KeepaliveController`**：给定 `(llmChatClient, provider, modelName, prefixMessages, keepaliveConfig)`，每 `keepalive_interval_seconds` 若仍在等待，用 `ctx.requestMessages` 稳定前缀发一个 `hidden_keepalive_token_budget` 上限的极小请求续 cache；`max_keepalive_rounds` 封顶，任务完成 / abort 即停。
  - **`KeepaliveToolProvider implements ToolProvider`**：装饰器，包住真正的 `RuntimeToolProvider`，在 `executeRound` 进入前 `controller.start(ctx)`、`finally` 里 `controller.stop()`。**包整个 `executeRound`**——定时器未到间隔不发请求，本地快工具自然不触发，无需侵入 `tool-round-executor` 内部。
- **落点**：装配在 `create-runtime-kernel.ts:39`，按 `allow_provider_keepalive` 决定是否用装饰器包 `RuntimeToolProvider`（关则原样返回）；需把 keepalive 配置 thread 进 `RuntimeKernelDeps`（其已含 `llmChatClient` + `provider`）。
- **统一口径**：不分 provider、不做 TTL 分流——一律按配置定时保活。
- **设计约束**：**内核零改动**（不新增 hook 点，hook 只包在模型调用两侧、够不着工具执行段）；**`RuntimeToolProvider` 零改动**（装饰器保其单一职责铁律）。
- **验收**：长等待期按间隔产生 keepalive 请求、受 `max_keepalive_rounds` 封顶、`allow_provider_keepalive` 关时零额外请求；`total_keepalive_rounds` 监控有数；缓存命中率分 provider 观测（OpenAI 类自动缓存为 best-effort，保活效果不保证）。
- **风险**：keepalive 产生额外 LLM 请求与成本，默认可关、带轮数 / token 预算上限（配置已具备）。

## 5. 明确不做（防跑偏）

- ❌ 不整体移植 `ContextPipeline`（架构倒退）。
- ❌ 不改压缩数据落地方式（不退回 Python 内存写回）。
- ❌ 不照搬 Python 双源默认值瑕疵（`summarize_max_tokens` config=2000 / budget fallback=300 不一致）。
- ❌ 不引入 Python 的 `prepared_messages` session 缓存复用——TS 用 store+hook 模型，缓存语义不同；若需要单独立项评估，不混入本计划。
- ❌ 阶段 4 不做"防记忆回写打掉前缀缓存"——TS 记忆指纹只对 scope 配置哈希、记忆内容不进前缀，前缀本就稳定，无此问题。
- ❌ 4b 不分 provider、不做 Anthropic 1h TTL 等分流优化——一律按配置统一定时保活。
- ❌ 4b 不侵入 `tool-round-executor` 内部精确到 `waitForToolResult` 分支——装饰器包整个 `executeRound`，靠定时器间隔天然过滤短工具。

## 6. 依赖与建议顺序

- 阶段 1、2 相互独立，可并行，风险最低，**建议先行**。
- 阶段 3 独立。
- 阶段 4 内核与 `RuntimeToolProvider` 均零改动（4a 在 `llm-chat-client`、4b 在 ToolProvider 装饰器 + 装配层），但属新模块 + 成本敏感，建议最后做并配套可观测。
- 推荐顺序：**1 → 2 → 3 → 4**（先可靠性与质量，再体积治理，最后高成本新模块）。

## 7. 验收总则

- 每阶段：单测 + 相关回归（`agent-execution-service.test.ts` / `runtime-core-execution.test.ts`）。
- 数据契约不变：压缩仍落 store，`replacesUpToSeq` 语义不变。
- 行为契约不变：`AgentContextService` 门面签名不变。
