// @ts-check

import {
  reconcileMessageContentParts,
} from '../utils/messageContentParts.js';

/** @typedef {Record<string, any>} AnyRecord */

/**
 * 移除"正在压缩…"瞬态横线（context_compression_pending）；
 * 按删除位置修正活动 assistant 消息索引，避免后续流式写入错位。
 * 同时导出给 dispatcher 的 command_result 终态兜底使用。
 * @param {{ value: AnyRecord[] }} messages @param {{ assistantMsgIndex: number }} activeRun
 */
export const removeCompactPendingMessages = (messages, activeRun) => {
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    if (messages.value[i]?.metadata?.msg_type !== 'context_compression_pending') continue;
    messages.value.splice(i, 1);
    if (activeRun.assistantMsgIndex > i) activeRun.assistantMsgIndex -= 1;
  }
};

/** @param {AnyRecord} model */
const retryStateForModel = (model) => {
  const parsedRetryAt = model.retry_at ? Date.parse(model.retry_at) : Number.NaN;
  const fallbackWaitMs = Number(model.retry_delay_ms);
  const waitMs = Number.isFinite(parsedRetryAt)
    ? Math.max(0, parsedRetryAt - Date.now())
    : Number.isFinite(fallbackWaitMs) ? Math.max(0, fallbackWaitMs) : 0;
  return {
    scope: 'model_attempt',
    callId: model.call_id,
    agentId: model.agent_id || '',
    nextAttempt: (model.attempt || 0) + 1,
    maxAttempts: model.max_attempts || 1,
    waitMs,
    nextRetryAt: Number.isFinite(parsedRetryAt) ? parsedRetryAt : Date.now() + waitMs,
    error: model.error || '',
    provider: model.provider || '',
    model: model.model || '',
  };
};

/** @param {import('./sessionCoreTypes.js').EventReducerOptions} options */
export function createSessionEventReducer({
  deps,
  runtime,
  activeRun,
  messages,
  isCompressing,
  contextUsage,
  llmRetryState,
  handleApprovalRequired,
  handleUserInputRequired,
}) {
  const syncLlmRetryState = () => {
    const retryModels = Object.values(activeRun.runningModelCalls || {}).filter(
      model => model.status === 'retry_wait',
    );
    const current = llmRetryState.value;
    const selected = retryModels.find(
      model => model.call_id === current?.callId && (model.agent_id || '') === (current?.agentId || ''),
    ) || retryModels[0];
    if (selected) {
      deps.setLlmRetryState(retryStateForModel(selected));
    } else if (current) {
      deps.clearLlmRetryState();
    }
  };

  // 各 run 的缓存累计基线（run_id → 累计值）：context_usage 事件携带的是单个 run 的累计值，
  // 与基线 diff 出每轮增量后并入会话级累计。root/child 的累计不同源，必须按 run 独立基线。
  const RUN_BASELINE_EMPTY = { cached: 0, creation: 0, input: 0 };
  const runCacheBaselines = new Map();

  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {import('./sessionCoreTypes.js').SessionMessage} currentMsg @param {string} sessionId */
  return (event, currentMsg, sessionId) => {
    const eventType = event.type;
    const payload = event.payload || {};

    if (eventType === 'state_sync') {
      const category = payload.category;
      if (category === 'context_usage') {
        const detail = payload.detail || {};
        if (detail.compressing) isCompressing.value = true;
        const isRoot = deps.isRootEvent(event);
        // Estimates are internal compression telemetry. The user-facing value only
        // changes after a provider has reported this round's real input and output.
        if (detail.token_source !== 'provider') return;
        if (!Number.isFinite(detail.used_tokens) || !Number.isFinite(detail.budget_tokens)) return;
        // 实时增量并入 session 累计：detail 是单个 run 的累计值，与该 run 的独立基线 diff 出本轮新增。
        const cu = contextUsage.value || {};
        const runCached = Number.isFinite(detail.cached_input_tokens) ? detail.cached_input_tokens : 0;
        const runCreation = Number.isFinite(detail.cache_creation_input_tokens) ? detail.cache_creation_input_tokens : 0;
        const runInput = Number.isFinite(detail.input_tokens) ? detail.input_tokens : 0;
        const runKey = typeof event.run_id === 'string' && event.run_id
          ? event.run_id
          : (isRoot ? 'root' : `child:${event.agent_id || 'unknown'}`);
        const baseline = runCacheBaselines.get(runKey) || RUN_BASELINE_EMPTY;
        // 回放（刷新/断线重连进行中的 run；active_run_snapshot 与 durable_outbox 两种模式都经
        // session.reconnect 括号把 isReplaying 置 true）只推进基线、不做累计：进会话时快照已载入
        // persisted 累计（含进行中 run 已完成轮次），再加一遍会把命中量放大到约两倍。回放结束后
        // 基线与 run 累计对齐，后续实时事件正常 diff（快照读取到回放结束之间完成的轮次会漏算，
        // 有界且下次进会话自愈，优于确定性的翻倍）。
        const isReplay = Boolean(activeRun.isReplaying)
          || (typeof runtime.isDurableReplayActive === 'function' && runtime.isDurableReplayActive());
        const deltaCached = !isReplay && runInput > 0 ? Math.max(0, runCached - baseline.cached) : 0;
        const deltaCreation = !isReplay && runInput > 0 ? Math.max(0, runCreation - baseline.creation) : 0;
        const deltaInput = !isReplay && runInput > 0 ? Math.max(0, runInput - baseline.input) : 0;
        runCacheBaselines.set(runKey, { cached: runCached, creation: runCreation, input: runInput });
        const sessionCached = (cu.cachedInputTokens || 0) + deltaCached;
        const sessionCreation = (cu.cacheCreationInputTokens || 0) + deltaCreation;
        const sessionInput = (cu.inputTokens || 0) + deltaInput;
        // 会话级缓存累计（命中或写入 >0 才携带，命中率 >0 才显示）。
        const sessionCacheFields = sessionInput > 0 && (sessionCached > 0 || sessionCreation > 0)
          ? {
              cachedInputTokens: sessionCached,
              ...(sessionCreation > 0 ? { cacheCreationInputTokens: sessionCreation } : {}),
              inputTokens: sessionInput,
            }
          : {};
        const baseCtx = {
          used: detail.used_tokens,
          max: detail.budget_tokens,
          source: 'provider',
          providerUsed: detail.used_tokens,
          ...(Number.isFinite(detail.system_prompt_tokens) ? { systemPromptTokens: detail.system_prompt_tokens } : {}),
          ...(Number.isFinite(detail.history_tokens) ? { historyTokens: detail.history_tokens } : {}),
          // 上下文构成占比（本轮请求估算，仅展示用）。
          ...(Number.isFinite(detail.tool_schema_tokens)
            ? {
                toolSchemaTokens: detail.tool_schema_tokens,
                mcpToolTokens: detail.mcp_tool_tokens ?? 0,
                skillToolTokens: detail.skill_tool_tokens ?? 0,
              }
            : {}),
        };
        if (isRoot) {
          contextUsage.value = { ...baseCtx, ...sessionCacheFields };
        } else {
          // 子 agent：used/max/构成是各自 run 的上下文，只挂 agent.ctx；会话级缓存增量折入
          // root 的 contextUsage（与后端落库口径一致：root+child 全部 run），但不碰 used/max
          // 等 root 展示态。无增量时不写，避免响应式抖动。
          const agent = deps.findRunningExecutionAgentByAgentId(currentMsg.executionTree, event.agent_id);
          if (agent) {
            agent.ctx = {
              ...baseCtx,
              ...(runInput > 0 && (runCached > 0 || runCreation > 0)
                ? {
                    cachedInputTokens: runCached,
                    ...(runCreation > 0 ? { cacheCreationInputTokens: runCreation } : {}),
                    inputTokens: runInput,
                  }
                : {}),
            };
          }
          if (deltaCached > 0 || deltaCreation > 0 || deltaInput > 0) {
            contextUsage.value = { ...(contextUsage.value || {}), ...sessionCacheFields };
          }
        }
      } else if (category === 'compression') {
        const detail = payload.detail || {};
        // 摘要正文不进消息流：压缩只影响发给 LLM 的上下文，列表完整渲染原始对话；
        // 手动 /compact 的"压缩完成：N 条"由 command_result 消息承载。
        const clearsIndicator = detail.type === 'compression_finished'
          || detail.type === 'compression_summary'
          || Boolean(detail.content);
        isCompressing.value = !clearsIndicator;
        // 自动/手动压缩都在消息流尾部挂"正在压缩…"瞬态横线（光拂过）；终态区别只在收尾：
        // 手动（forced）压缩完成后由 command_result 横线（"压缩完成：N 条"）接管，
        // 自动压缩直接移除、不留终态标记。防御性只认 root 线程帧——当前两个发布方
        // （runtime-adapter isRootThread 门控 / slash handler 硬编码 root）都只发 root，
        // 一旦未来放开子线程压缩，不应把根会话横线挂错。移除不设门（防御性清理）。
        // 不提前 return：插入横线后要走尾部 scrollToBottom 让用户看到。
        const isRootThread = detail.thread_key == null || detail.thread_key === '' || detail.thread_key === 'root';
        if (!clearsIndicator && isRootThread) {
          if (!messages.value.some(message => message.metadata?.msg_type === 'context_compression_pending')) {
            messages.value.push({
              role: 'system',
              content: '正在压缩…',
              content_parts: [{ type: 'text', text: '正在压缩…' }],
              metadata: { msg_type: 'context_compression_pending' },
            });
          }
        } else {
          removeCompactPendingMessages(messages, activeRun);
        }
      }
    } else if (eventType === 'model_request') {
      runtime.markModelRequestStarted(event, deps.isMasterEvent(event));
      syncLlmRetryState();
    } else if (eventType === 'model_attempt_started') {
      runtime.markModelAttemptStarted(event);
      syncLlmRetryState();
    } else if (eventType === 'model_attempt_failed') {
      runtime.markModelAttemptFailed(event);
      syncLlmRetryState();
    } else if (eventType === 'model_attempt_completed') {
      runtime.markModelAttemptCompleted(event);
      syncLlmRetryState();
    } else if (eventType === 'stream_output') {
      const phase = payload.phase;
      if (phase === 'first_token') {
        runtime.markLlmFirstToken(event, payload);
        syncLlmRetryState();
      } else if (phase === 'delta') {
        runtime.markOutputChunk(event, payload.content || '');
        syncLlmRetryState();
        // 正文统一进执行树（轮 text 通道流式渲染）；消息槽只承接 final 落地的消息行。
        deps.applyEnvelopeToMessage(currentMsg, event);
      } else if (phase === 'part_added') {
        runtime.markOutputChunk(event, '');
        syncLlmRetryState();
        deps.applyEnvelopeToMessage(currentMsg, event);
      } else if (phase === 'final') {
        runtime.markModelAttemptCompleted(event);
        syncLlmRetryState();
        deps.applyEnvelopeToMessage(currentMsg, event);
        if (deps.isMasterEvent(event)) {
          if (typeof payload.content === 'string') currentMsg.content = payload.content;
          reconcileMessageContentParts(currentMsg, payload.content_parts);
          currentMsg.finished = true;
          runtime.markRecentSessionUpdated(sessionId, currentMsg);
          deps.cacheMessages(sessionId, messages.value);
        }
      } else if (phase === 'intent_complete') {
        runtime.markModelStreaming(event);
        syncLlmRetryState();
        deps.applyEnvelopeToMessage(currentMsg, event);
      } else if (phase === 'reasoning_delta' || phase === 'reasoning_complete') {
        runtime.markModelStreaming(event);
        syncLlmRetryState();
        deps.applyEnvelopeToMessage(currentMsg, event);
      } else if (phase === 'snapshot') {
        // 在飞轮全量取像（重连/切会话恢复）：执行树内覆盖式替换当前轮累积文本。
        // 标记用瘦身副本——快照 payload 携带全文，不原样进 runningModelCalls 响应式条目。
        runtime.markModelStreaming({ ...event, payload: { phase } });
        syncLlmRetryState();
        deps.applyEnvelopeToMessage(currentMsg, event);
      }
    } else if (eventType === 'tool_call') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      runtime.markToolStarted(event, payload);
      syncLlmRetryState();
    } else if (eventType === 'tool_result') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      runtime.markToolFinished(event);
      syncLlmRetryState();
    } else if (eventType === 'agent_started') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      if (deps.isMasterEvent(event)) {
        runtime.markRootAgentStarted(event);
      }
    } else if (eventType === 'agent_ended') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      runtime.markAgentFinished(event);
      // run 结束后基线不再使用（新 run 有新的 run_id，天然从零开始），及时清理避免积压。
      if (typeof event.run_id === 'string' && event.run_id) runCacheBaselines.delete(event.run_id);
      syncLlmRetryState();
      if (deps.isMasterEvent(event) && !currentMsg.finished) {
        currentMsg.finished = true;
        runtime.markRecentSessionUpdated(sessionId, currentMsg);
      }
    } else if (eventType === 'error') {
      runtime.markModelAttemptCompleted(event);
      syncLlmRetryState();
      currentMsg.status.push({ type: 'error', content: payload.message || '' });
    } else if (eventType === 'interaction' && payload.phase === 'required') {
      if (payload.kind === 'approval') handleApprovalRequired(event, payload, sessionId);
      else if (payload.kind === 'user_input') handleUserInputRequired(event, payload);
    }

    deps.scrollToBottom();
  };
}
