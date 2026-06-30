<template>
  <div class="rag-root">
    <!-- 对话面板（打开时位于触发按钮上方） -->
    <Transition name="rag-panel">
      <section v-if="open" class="rag-panel">
        <!-- Header -->
        <header class="rag-header">
          <div class="rag-avatar">
            <span class="rag-avatar-icon" v-html="sparklesIcon"></span>
            <span class="rag-status-dot" :class="`tone-${statusTone}`"></span>
          </div>
          <div class="rag-header-titles">
            <span class="rag-title">AI 助手</span>
            <span v-if="connBadgeText" class="rag-conn-badge">{{ connBadgeText }}</span>
          </div>
          <button class="rag-icon-btn rag-icon-btn--reset" @click="reset" title="重置对话" aria-label="重置对话">
            <span v-html="rotateCcwIcon"></span>
          </button>
          <button class="rag-icon-btn rag-icon-btn--close" @click="toggleOpen" aria-label="关闭">
            <span v-html="xIcon"></span>
          </button>
        </header>

        <!-- 消息流：含折叠工具调用 + 打字三点 + 流内审批/输入卡片 -->
        <div class="rag-messages" ref="messagesEl" @scroll="onMessagesScroll" @wheel="onMessagesWheel">
          <div v-if="!messages.length && !approvalQueueView.length && !pendingUserInputView" class="rag-empty">
            输入消息开始对话
          </div>

          <template v-for="msg in messages" :key="msg.id">
            <div v-if="msg.role === 'user'" class="rag-msg rag-msg--user">
              <div class="rag-user-text">{{ msg.content }}</div>
            </div>
            <div v-else class="rag-msg rag-msg--assistant">
              <!-- 工具调用折叠（N 个工具调用）——grid 0fr→1fr 展开动画，padding 下沉到裁剪区内层 -->
              <button
                v-if="msg.executionTree && msg.executionTree.root"
                class="rag-exec-toggle"
                @click="msg.execOpen = !msg.execOpen"
              >
                <span class="rag-exec-label">{{ toolCallCount(msg.executionTree) }} tool calls</span>
                <span v-if="!msg.finished" class="rag-exec-running">进行中</span>
                <span class="rag-exec-chevron" v-html="msg.execOpen ? chevronUpIcon : chevronDownIcon"></span>
              </button>
              <div class="rag-exec-list-outer" :class="{ 'is-open': msg.execOpen }">
                <div class="rag-exec-list-clip">
                  <div class="rag-exec-list" v-if="msg.executionTree">
                <template v-for="(node, idx) in extractNodes(msg.executionTree)" :key="idx">
                  <!-- 节点行可见 = 祖先容器（intent/agent）全展开 -->
                  <template v-if="nodeVisible(node)">
                    <!-- intent：容器，折叠隐藏该轮工具（文本始终显示）-->
                    <div
                      v-if="node.type === 'intent'"
                      class="rag-exec-node rag-exec-intent"
                      :style="{ paddingLeft: node.depth * 22 + 'px' }"
                      @click="toggleFold(node.foldId)"
                    >
                      <span class="rag-exec-icon" v-html="TOOL_ICONS.lightbulb"></span>
                      <span class="rag-exec-intent-text">{{ node.text }}</span>
                      <span class="rag-exec-tail" :class="{ open: isFoldOpen(node.foldId) }" v-html="chevronDownIcon"></span>
                    </div>
                    <!-- agent：容器，折叠隐藏 task/子节点树/result -->
                    <div
                      v-else-if="node.type === 'agent'"
                      class="rag-exec-node"
                      :class="[`st-${node.status}`]"
                      :style="{ paddingLeft: node.depth * 22 + 'px' }"
                      @click="toggleFold(node.foldId)"
                    >
                      <span class="rag-exec-icon" v-html="getToolIcon(node.name, 'bot')"></span>
                      <span class="rag-exec-name">{{ node.name }}</span>
                      <span class="rag-exec-status">{{ agentSummary(node) }}</span>
                      <span class="rag-exec-tail" :class="{ open: isFoldOpen(node.foldId) }" v-html="chevronDownIcon"></span>
                    </div>
                    <!-- tool：叶子，折叠隐藏参数/结果 -->
                    <div
                      v-else
                      class="rag-exec-node"
                      :class="[`st-${node.tool.status}`]"
                      :style="{ paddingLeft: node.depth * 22 + 'px' }"
                      @click="toggleFold(node.tool.callId)"
                    >
                      <span class="rag-exec-icon" v-html="getToolIcon(node.tool.toolName)"></span>
                      <span class="rag-exec-name">{{ node.tool.toolName }}</span>
                      <span class="rag-exec-status">{{ toolSummary(node.tool) }}</span>
                      <span class="rag-exec-tail" :class="{ open: isFoldOpen(node.tool.callId) }" v-html="chevronDownIcon"></span>
                    </div>
                  </template>
                  <!-- tool 展开详情：参数 + 结果（grid 0fr→1fr；marginLeft 对齐工具名起始）-->
                  <div
                    v-if="node.type === 'tool' && nodeVisible(node)"
                    class="rag-exec-detail-wrap"
                    :class="{ 'is-open': isFoldOpen(node.tool.callId) }"
                    :style="{ marginLeft: (node.depth * 22 + 22) + 'px' }"
                  >
                    <div class="rag-exec-detail">
                      <div class="rag-exec-detail-block">
                        <span class="rag-exec-detail-label">参数</span>
                        <pre class="rag-exec-detail-pre">{{ formatArgs(node.tool.arguments) }}</pre>
                      </div>
                      <div class="rag-exec-detail-block">
                        <span class="rag-exec-detail-label">结果</span>
                        <div class="rag-exec-detail-text" :class="{ 'is-error': node.tool.status === 'failed' }">{{ formatResult(node.tool) }}</div>
                      </div>
                    </div>
                  </div>
                  <!-- agent 展开详情：任务 + 结果（子节点树由后续节点的 nodeVisible 自然显隐）-->
                  <div
                    v-if="node.type === 'agent' && nodeVisible(node) && (node.task || node.result)"
                    class="rag-exec-detail-wrap"
                    :class="{ 'is-open': isFoldOpen(node.foldId) }"
                    :style="{ marginLeft: (node.depth * 22 + 22) + 'px' }"
                  >
                    <div class="rag-exec-detail">
                      <div v-if="node.task" class="rag-exec-detail-block">
                        <span class="rag-exec-detail-label">任务</span>
                        <div class="rag-exec-detail-text">{{ node.task }}</div>
                      </div>
                      <div v-if="node.result" class="rag-exec-detail-block">
                        <span class="rag-exec-detail-label">结果</span>
                        <div class="rag-exec-detail-text" :class="{ 'is-error': node.status === 'failed' }">{{ cleanObservation(node.result) }}</div>
                      </div>
                    </div>
                  </div>
                </template>
                <div v-if="!extractNodes(msg.executionTree).length" class="rag-exec-empty">
                  {{ msg.finished ? "无工具调用" : "等待中…" }}
                </div>
                  </div>
                </div>
              </div>
              <!-- 助手正文（结论）置于工具调用之下 -->
              <div v-if="msg.content" class="rag-assistant-text" v-html="renderMarkdown(msg.content)"></div>
            </div>
          </template>

          <!-- 打字三点：运行中且末尾助手消息尚无内容 -->
          <div v-if="showTyping" class="rag-typing">
            <span></span><span></span><span></span>
          </div>

          <!-- 审批 / 用户输入：消息流内卡片 -->
          <WorkPanelUserInput
            v-if="pendingUserInputView"
            :input-data="pendingUserInputView.data"
            class="rag-msg rag-msg--interaction"
            @submit="onUserInputSubmit"
            @cancel="onUserInputCancel"
          />
          <WorkPanelApproval
            v-if="approvalQueueView.length"
            :queue="approvalQueueView"
            :submitting-id="submittingApprovalId"
            class="rag-msg rag-msg--interaction"
            @submit="onApprovalSubmit"
          />
        </div>

        <div v-if="connectionStatus.state === 'disconnected'" class="rag-conn-bar">
          <span>连接已断开</span>
          <button class="rag-reconnect" @click="reconnect">重新连接</button>
        </div>

        <!-- 输入栏：胶囊容器 + Plus + 输入框 + Mic + 圆形 Send/Stop -->
        <footer class="rag-input-bar">
          <div class="rag-input-pill">
            <button class="rag-input-btn" aria-label="附件" tabindex="-1" disabled>
              <span v-html="plusIcon"></span>
            </button>
            <textarea
              v-model="draft"
              class="rag-input"
              rows="1"
              :placeholder="isConnected ? 'Send a message...' : '等待连接…'"
              :disabled="!isConnected"
              @keydown.enter.exact.prevent="send"
            ></textarea>
            <button class="rag-input-btn" aria-label="语音" tabindex="-1" disabled>
              <span v-html="micIcon"></span>
            </button>
            <button
              v-if="isActiveRun"
              class="rag-send rag-stop"
              @click="stop"
              aria-label="停止"
            >
              <span v-html="stopIcon"></span>
            </button>
            <button
              v-else
              class="rag-send"
              :disabled="!draft.trim() || sending"
              @click="send"
              aria-label="发送"
            >
              <span v-html="sendIcon"></span>
            </button>
          </div>
        </footer>
      </section>
    </Transition>

    <!-- 触发按钮：始终可见，关闭=Sparkles(+蓝点)，打开=X -->
    <button class="rag-fab" @click="toggleOpen" :aria-label="open ? '关闭' : '打开助手'">
      <span class="rag-fab-icon" :class="{ open }">
        <span class="rag-fab-spark" v-html="sparklesIcon"></span>
        <span class="rag-fab-x" v-html="xIcon"></span>
      </span>
      <span v-if="!open" class="rag-fab-dot"></span>
    </button>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { WidgetAgentClient } from "../adapter/widget-agent-client.js";
import { renderMarkdown } from "../utils/markdown.js";
import WorkPanelApproval from "./workpanel/WorkPanelApproval.vue";
import WorkPanelUserInput from "./workpanel/WorkPanelUserInput.vue";

/**
 * widget 主面板：FAB + 对话框（Figma「Assistance widget design」浅色极简风）。
 *
 * 形态：对话面板纯对话；工具调用折叠挂在 agent 消息内（N 个工具调用，状态图标一行一工具）；
 * 审批/用户输入作为消息流内卡片；打字三点指示助手思考中。
 */
const props = defineProps({
  backendBase: { type: String, required: true },
  sessionId: { type: String, required: true },
  token: { type: String, required: true },
  hostTools: { type: Array, default: () => [] },
});

let client = null;
const unsub = [];

const open = ref(false);
const messages = ref([]);
const draft = ref("");
const messagesEl = ref(null);

const runStatus = ref({ runId: null, state: "idle" });
const pendingInteractions = ref([]);
const connectionStatus = ref({ state: "idle" });
const sending = ref(false);
const submittingApprovalId = ref("");
// 单工具展开态：按 callId 记录，展开显示参数 + 完整结果。
const expanded = ref(new Set());

// 流式渲染节流：delta 累积到 streamBuffer，定时 flush 到当前 assistant message，
// 限制 markdown-it 全量重渲频率（长回复避免每 token 重算叠加成 O(n²) 卡顿）。
const STREAM_FLUSH_MS = 80;
let streamTarget = null;
let streamBuffer = "";
let streamFlushTimer = null;

// 滚动跟随：用户上滑阅读时不强制拉底；scrollToBottom 用 rAF 合并高频调用。
let stickToBottom = true;
let scrollRafScheduled = false;

import { getToolIcon, TOOL_ICONS } from '../icons/toolIcons';

// ── 内联 SVG 图标（lucide 风格，stroke=currentColor，尺寸由 CSS 控制）──
const sparklesIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>`;
const xIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
const plusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;
const micIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>`;
const sendIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.1 1.1z"/><path d="m21.686 14.536-9.536-9.536"/></svg>`;
const stopIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`;
const rotateCcwIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
const chevronDownIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const chevronUpIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>`;

onMounted(async () => {
  client = new WidgetAgentClient({
    backendBase: props.backendBase,
    sessionId: props.sessionId,
    token: props.token,
    hostTools: props.hostTools,
  });
  unsub.push(client.status.subscribe((s) => { connectionStatus.value = s; }));
  unsub.push(client.runStatus.subscribe((s) => { runStatus.value = s; }));
  // executionTree 挂到当前 run 产生的最新 assistant message（工具调用属该回复）。
  unsub.push(client.executionTree.subscribe((t) => {
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "assistant") {
      last.executionTree = t;
    }
  }));
  unsub.push(client.pendingInteractions.subscribe((list) => { pendingInteractions.value = list; }));
  unsub.push(client.events.subscribe((env) => handleEvent(env)));
  await client.connect();
});

onBeforeUnmount(() => {
  unsub.forEach((fn) => { try { fn(); } catch {} });
  if (streamFlushTimer) { clearTimeout(streamFlushTimer); streamFlushTimer = null; }
  client?.disconnect();
});

function toggleOpen() {
  open.value = !open.value;
  if (open.value) {
    stickToBottom = true;
    scrollToBottom();
  }
}

function handleEvent(env) {
  if (env.type === "run_started") {
    const msg = {
      id: env.run_id || `a${Date.now()}`,
      role: "assistant",
      content: "",
      finished: false,
      executionTree: null,
      execOpen: false,
    };
    messages.value.push(msg);
    // 绑定流式节流目标：后续 stream_output delta 累积进 streamBuffer。
    streamTarget = msg;
    streamBuffer = "";
    scrollToBottom();
    return;
  }
  if (env.type === "stream_output") {
    const payload = env.payload || {};
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "assistant") {
      // 切换/对齐流式目标（last 变化或重连重放时重新绑定）。
      if (streamTarget !== last) {
        streamTarget = last;
        streamBuffer = last.content || "";
      }
      if (payload.phase === "final") {
        streamBuffer = payload.content || streamBuffer;
        last.finished = true;
        flushStream(); // final 立即落盘，确保最终内容与渲染态准确
        streamTarget = null;
        streamBuffer = "";
      } else if (payload.phase === "first_token" || payload.phase === "delta") {
        streamBuffer += payload.content || "";
        scheduleStreamFlush();
      }
    }
    return;
  }
  if (env.type === "run_ended") {
    flushStream(); // 收尾：刷掉残留 buffer，避免最后一段 delta 丢失
    streamTarget = null;
    streamBuffer = "";
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "assistant") last.finished = true;
    return;
  }
  if (env.type === "error") {
    const payload = env.payload || {};
    pushError(payload.message || "错误");
    return;
  }
}

function flushStream() {
  if (streamFlushTimer) {
    clearTimeout(streamFlushTimer);
    streamFlushTimer = null;
  }
  if (streamTarget) {
    streamTarget.content = streamBuffer;
    scrollToBottom();
  }
}

function scheduleStreamFlush() {
  if (streamFlushTimer) return;
  streamFlushTimer = setTimeout(() => {
    streamFlushTimer = null;
    flushStream();
  }, STREAM_FLUSH_MS);
}

function pushError(message) {
  flushStream(); // 先收尾可能进行中的流式，再插入错误卡片
  streamTarget = null;
  streamBuffer = "";
  messages.value.push({ id: `e${Date.now()}`, role: "assistant", content: `⚠️ ${message}`, finished: true, executionTree: null, execOpen: false });
  scrollToBottom();
}

async function send() {
  const text = draft.value.trim();
  if (!text || !client || isActiveRun.value || sending.value) return;
  // 未连接直接报错，不污染消息流。
  if (!isConnected.value) {
    pushError("发送失败：连接未就绪");
    return;
  }
  // 乐观先入用户消息：保证 user 在 run_started 投影出的 assistant 消息之前。
  // 若改成 await 后再 push，run_started 事件会在 await 期间先把 assistant（空内容 + 打字点）入列，
  // 导致 assistant 排到 user 之上，且 stream_output 取末尾消息会错指 user 而丢掉整路流式。
  messages.value.push({ id: `u${Date.now()}`, role: "user", content: text });
  draft.value = "";
  sending.value = true;
  scrollToBottom();
  try {
    const result = await client.send({ task: text });
    if (!result.started) {
      pushError(`发送失败：${result.error || "请稍后重试"}`);
    }
  } finally {
    sending.value = false;
  }
}

function stop() {
  client?.stop();
}

function reconnect() {
  client?.connect();
}

/** 本地重置：清空消息流回到空状态（会话/client 保持，不重启会话）。 */
function reset() {
  flushStream();
  streamTarget = null;
  streamBuffer = "";
  messages.value = [];
  draft.value = "";
  stickToBottom = true;
  scrollToBottom();
}

async function onApprovalSubmit({ approvalId, approved, message }) {
  if (!client || submittingApprovalId.value) return;
  submittingApprovalId.value = approvalId;
  try {
    await client.approve(approvalId, approved, message);
  } finally {
    submittingApprovalId.value = "";
  }
}
function onUserInputSubmit({ inputId, value }) {
  client?.respondInput(inputId, value);
}
function onUserInputCancel() {
  // 一期不取消。
}

const isActiveRun = computed(() => runStatus.value.state === "running");

const isConnected = computed(() => connectionStatus.value.state === "connected");

const connBadgeText = computed(() => {
  const s = connectionStatus.value.state;
  if (s === "connecting") return "连接中";
  if (s === "reconnecting") {
    const n = connectionStatus.value.replayCount;
    return n ? `重连中(${n})` : "重连中";
  }
  if (s === "disconnected") return "已断开";
  return "";
});

const statusTone = computed(() => {
  if (connectionStatus.value.state === "disconnected") return "error";
  if (connectionStatus.value.state === "reconnecting" || connectionStatus.value.state === "connecting") return "running";
  if (pendingInteractions.value.some((p) => p.kind === "user_input")) return "input";
  if (pendingInteractions.value.some((p) => p.kind === "approval")) return "warning";
  if (runStatus.value.state === "failed") return "error";
  if (runStatus.value.state === "running") return "running";
  if (runStatus.value.state === "completed") return "success";
  return "idle";
});

const approvalQueueView = computed(() =>
  pendingInteractions.value
    .filter((p) => p.kind === "approval")
    .map((p) => ({
      approval_id: p.interactionId,
      tool_name: p.toolName,
      risk_level: p.riskLevel,
      agent_name: "",
      approval_reason: p.prompt,
      arguments: p.arguments,
    })),
);

const pendingUserInputView = computed(() => {
  const ui = pendingInteractions.value.find((p) => p.kind === "user_input");
  if (!ui) return null;
  return { data: { input_id: ui.interactionId, prompt: ui.prompt, input_type: "text" } };
});

/** 打字三点：运行中且末尾助手消息尚无内容（首 token 到达后自动隐藏）。 */
const showTyping = computed(() => {
  if (!isActiveRun.value) return false;
  const last = messages.value[messages.value.length - 1];
  return !!last && last.role === "assistant" && !last.content;
});

/** 从 executionTree 提取带层级的节点（工具 + 子 agent 分组），子 agent 工具按 depth 缩进。 */
function extractNodes(tree) {
  const nodes = [];
  // ancestors：当前节点的容器祖先 foldId 链（intent/agent）。节点行可见 = 链上全部展开。
  const walk = (agent, depth, ancestors) => {
    if (!agent) return;
    const agentKey = agent.callId || agent.agentId || "root";
    let agentHasIntent = false;
    for (const round of agent.rounds || []) {
      const hasIntent = !!(round.intent && round.intent.trim());
      if (hasIntent) agentHasIntent = true;
      let toolAncestors = ancestors;
      if (hasIntent) {
        const intentId = `intent:${agentKey}:r${round.round}`;
        nodes.push({
          type: "intent", depth, foldId: intentId, ancestors,
          text: round.intent, complete: !!round.intentComplete,
        });
        toolAncestors = [...ancestors, intentId];
      }
      const toolDepth = hasIntent ? depth + 1 : depth;
      for (const tc of round.toolCalls || []) {
        // call_agent/send_message 用子 agent 分组节点代替，避免重复
        if (tc.toolName === "call_agent" || tc.toolName === "send_message") continue;
        nodes.push({ type: "tool", depth: toolDepth, tool: tc, foldId: tc.callId, ancestors: toolAncestors });
      }
    }
    // 子 agent 挂在 parent 的 intent 层下（parent 有 intent 则缩进一层）；其子节点 ancestors 含该 agent。
    const childDepth = agentHasIntent ? depth + 1 : depth;
    for (const child of agent.children || []) {
      const childId = `agent:${child.callId || child.agentId}`;
      nodes.push({
        type: "agent", depth: childDepth, foldId: childId, ancestors,
        name: child.displayName || child.agentId, status: child.status,
        task: child.task, result: child.result,
      });
      walk(child, childDepth + 1, [...ancestors, childId]);
    }
  };
  walk(tree?.root, 0, []);
  return nodes;
}

/** 工具调用计数（仅工具节点，不含子 agent 分组）。 */
function toolCallCount(tree) {
  return extractNodes(tree).filter((n) => n.type === "tool").length;
}

/** 清洗工具观察结果：剥 <tool_result> 信封 + 解 CDATA + 去标签 + 反转义实体，只留可读正文（保留换行）。 */
function cleanObservation(raw) {
  if (!raw) return "";
  let text = String(raw);
  // 1. 取 <tool_result …>内部</tool_result>
  const tr = text.match(/<tool_result[^>]*>([\s\S]*?)<\/tool_result>/i);
  if (tr) text = tr[1];
  // 2. 解 CDATA：<![CDATA[ … ]]>（真实结果常包在此）
  const cdata = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) text = cdata[1];
  // 3. 去剩余信封/标签（result/observation/output 等）
  text = text.replace(/<\/?(?:result|observation|output)[^>]*>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  // 4. 反转义常见实体（&amp; 最后解，避免二次解码）
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  // 5. 折叠水平空白（保留换行）、压多余空行
  text = text.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** 单工具一行摘要：运行中→运行中；失败→失败；成功→清洗后的简短结果（剥协议信封），空则「完成」。 */
function toolSummary(tool) {
  if (tool.status === "running") return "运行中";
  if (tool.status === "failed") return "失败";
  const obs = cleanObservation(tool.summary || tool.observation || "").replace(/\s+/g, " ").trim();
  if (!obs) return "完成";
  return obs.length > 36 ? `${obs.slice(0, 36)}…` : obs;
}

/** 切换节点展开（intent/tool/agent 统一按 foldId 折叠）。*/
function toggleFold(id) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}
function isFoldOpen(id) {
  return expanded.value.has(id);
}
/** 节点行可见 = 其所有容器祖先（intent/agent foldId）均展开。*/
function nodeVisible(node) {
  return (node.ancestors || []).every((id) => expanded.value.has(id));
}
/** agent 摘要：运行中/失败；成功留空（靠状态色，对齐 tool 摘要风格）。*/
function agentSummary(node) {
  if (node.status === "running") return "进行中";
  if (node.status === "failed") return "失败";
  return "";
}

/** 展开详情：参数（arguments）格式化为可读文本。 */
function formatArgs(args) {
  if (args === undefined || args === null) return "（无）";
  if (typeof args === "string") return args.trim() || "（无）";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** 展开详情：完整结果（剥 <tool_result> 信封，保留全文）。运行中→执行中…；空→（无结果）。 */
function formatResult(tool) {
  if (tool.status === "running") return "执行中…";
  const obs = cleanObservation(tool.observation || tool.summary || "");
  if (obs) return obs;
  return tool.status === "failed" ? "失败（无结果）" : "（无结果）";
}

function onMessagesScroll() {
  const el = messagesEl.value;
  if (!el) return;
  // 距底部 > 阈值视为用户主动上滑阅读，停止自动跟随。
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  stickToBottom = distFromBottom < 48;
}

function scrollToBottom() {
  if (scrollRafScheduled) return;
  scrollRafScheduled = true;
  requestAnimationFrame(() => {
    scrollRafScheduled = false;
    const el = messagesEl.value;
    if (el && stickToBottom) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

// 阻止滚动透传：消息区滚到边界时吃掉 wheel，不让手势链式传播到宿主页面。
// overscroll-behavior:contain 已覆盖绝大多数情况，这里兜底老 Safari 等不支持该属性的浏览器。
function onMessagesWheel(e) {
  const el = messagesEl.value;
  if (!el) return;
  const maxScroll = el.scrollHeight - el.clientHeight;
  if (maxScroll <= 0) {
    e.preventDefault();
    return;
  }
  const atTop = el.scrollTop <= 0 && e.deltaY < 0;
  const atBottom = el.scrollTop >= maxScroll && e.deltaY > 0;
  if (atTop || atBottom) e.preventDefault();
}
</script>

<style scoped>
.rag-root {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  color: var(--color-text-primary, #1a1b1e);
}

/* ── 触发按钮 ── */
.rag-fab {
  position: relative;
  width: 52px;
  height: 52px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  border: none;
  background: var(--color-accent-strong, #1a1b1e);
  color: var(--color-on-accent, #fff);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-fab);
  transition: transform 0.16s var(--ease-default), box-shadow 0.16s var(--ease-default);
}
.rag-fab:hover { transform: scale(1.05); }
.rag-fab:active { transform: scale(0.93); }
.rag-fab :deep(svg) { width: 22px; height: 22px; }

.rag-fab-icon { position: relative; width: 22px; height: 22px; }
.rag-fab-spark,
.rag-fab-x {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s var(--ease-default), transform 0.15s var(--ease-default);
}
.rag-fab-spark { opacity: 1; transform: rotate(0); }
.rag-fab-x { opacity: 0; transform: rotate(-80deg); }
.rag-fab-icon.open .rag-fab-spark { opacity: 0; transform: rotate(80deg); }
.rag-fab-icon.open .rag-fab-x { opacity: 1; transform: rotate(0); }

.rag-fab-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full);
  background: var(--color-running, #3b82f6);
  border: 2px solid var(--color-accent-strong, #1a1b1e);
}

/* ── 面板 ── */
.rag-panel {
  width: min(360px, 92vw);
  max-height: min(560px, calc(100vh - 120px));
  background: var(--color-bg-panel, #fff);
  border-radius: var(--radius-xl, 16px);
  box-shadow: var(--shadow-panel);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Header ── */
.rag-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border, rgba(0, 0, 0, 0.06));
}
.rag-avatar {
  position: relative;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: var(--color-accent-strong, #1a1b1e);
  color: var(--color-on-accent, #fff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rag-avatar :deep(svg) { width: 14px; height: 14px; }
.rag-status-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border-radius: var(--radius-full);
  background: var(--color-text-faint, #9ea0ab);
  border: 2px solid var(--color-bg-panel, #fff);
}
.tone-running, .tone-input { background: var(--color-running, #3b82f6); }
.tone-warning { background: var(--color-warning, #d97706); }
.tone-error { background: var(--color-error, #e05252); }
.tone-success { background: var(--color-success, #16a34a); }

.rag-header-titles {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.rag-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary, #1a1b1e);
}
.rag-conn-badge {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted, #6e7280);
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--color-bg-hover, #f4f5f8);
}

.rag-icon-btn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-md, 10px);
  background: transparent;
  color: var(--color-text-faint, #9ea0ab);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.rag-icon-btn:hover {
  color: var(--color-text-secondary, #4b4c55);
  background: var(--color-bg-hover, #f4f5f8);
}
.rag-icon-btn--close :deep(svg) { width: 16px; height: 16px; }
.rag-icon-btn--reset :deep(svg) { width: 14px; height: 14px; }

/* ── 消息区 ── */
.rag-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scrollbar-width: none;
}
.rag-messages::-webkit-scrollbar { display: none; }
.rag-empty {
  color: var(--color-text-placeholder, #b0b3be);
  text-align: center;
  margin-top: 40px;
}

.rag-msg--user {
  align-self: flex-end;
  max-width: 80%;
}
.rag-user-text {
  background: var(--color-bg-message-user, #f0f1f5);
  color: var(--color-text-primary, #1a1b1e);
  padding: 8px 14px;
  border-radius: var(--radius-xl, 16px);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.55;
}
.rag-msg--assistant {
  align-self: stretch;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rag-assistant-text {
  color: var(--color-text-primary, #1a1b1e);
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}
.rag-assistant-text pre {
  background: var(--color-bg-input, #f4f5f8);
  padding: 10px 12px;
  border-radius: var(--radius-sm, 8px);
  overflow-x: auto;
  overscroll-behavior: contain;
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
}
.rag-assistant-text code {
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
}
.rag-assistant-text p { margin: 0.4em 0; }
.rag-assistant-text ul,
.rag-assistant-text ol { padding-left: 1.4em; margin: 0.4em 0; }
.rag-assistant-text a { color: var(--color-link, #4b4c55); }

/* ── 工具调用折叠（N 个工具调用）── */
.rag-exec-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text-muted, #6e7280);
  font-family: inherit;
  padding: 2px 0;
  align-self: flex-start;
  transition: color var(--transition-fast);
}
.rag-exec-toggle:hover { color: var(--color-text-secondary, #4b4c55); }
.rag-exec-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rag-exec-chevron :deep(svg) { width: 12px; height: 12px; }
.rag-exec-label { font-weight: 500; }
.rag-exec-running { color: var(--color-running, #3b82f6); font-size: 11px; }

.rag-exec-list-outer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.24s var(--ease-spring, ease);
}
.rag-exec-list-outer.is-open {
  grid-template-rows: 1fr;
}
.rag-exec-list-clip {
  overflow: hidden;
  min-height: 0;
}
.rag-exec-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0 0 6px;
}
/* 统一节点行（intent/tool/agent 同一骨架：图标 · 主文本 · 摘要 · chevron）。
   agent 不再特殊加粗/accent——只在图标(bot)与「能展开子树」上区别于 tool。*/
.rag-exec-node {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--color-text-secondary, #4b4c55);
  padding: 3px 0;
  cursor: pointer;
  transition: color var(--transition-fast);
}
.rag-exec-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--color-text-muted, #6e7280);
  transition: color var(--transition-fast);
}
.rag-exec-icon :deep(svg) { width: 14px; height: 14px; }
.rag-exec-name {
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--color-text-muted, #6e7280);
  flex-shrink: 0;
  transition: color var(--transition-fast);
}
.rag-exec-status {
  color: var(--color-text-faint, #9ea0ab);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  transition: color var(--transition-fast);
}
.rag-exec-tail {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-line, #c5c6cc);
  flex-shrink: 0;
  transition: transform var(--transition-fast);
}
.rag-exec-tail.open { transform: rotate(180deg); }
.rag-exec-tail :deep(svg) { width: 12px; height: 12px; }
/* intent：文本占主区（取代 name+status），顶部对齐图标 */
.rag-exec-intent { align-items: flex-start; }
.rag-exec-intent .rag-exec-icon { color: var(--color-text-faint, #9ea0ab); padding-top: 1px; }
.rag-exec-intent-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--color-text-muted, #6e7280);
  white-space: pre-wrap;
  word-break: break-word;
}
/* hover：字体加深（非彩色状态行）*/
.rag-exec-node:hover .rag-exec-name,
.rag-exec-node:hover .rag-exec-icon { color: var(--color-text-primary, #1a1b1e); }
.rag-exec-node:hover .rag-exec-status { color: var(--color-text-secondary, #4b4c55); }
/* 失败/运行：hover 下保持状态色（优先级高于通用 hover，避免被加深盖掉）*/
.st-failed.rag-exec-node:hover .rag-exec-name,
.st-failed.rag-exec-node:hover .rag-exec-icon,
.st-failed.rag-exec-node:hover .rag-exec-status { color: var(--color-error, #e05252); }
.st-running.rag-exec-node:hover .rag-exec-name,
.st-running.rag-exec-node:hover .rag-exec-icon { color: var(--color-running, #3b82f6); }
/* 状态分层着色：名/图标/摘要随状态变化 */
.st-running .rag-exec-name,
.st-running .rag-exec-icon { color: var(--color-running, #3b82f6); }
.st-failed .rag-exec-name,
.st-failed .rag-exec-icon,
.st-failed .rag-exec-status { color: var(--color-error, #e05252); }
.st-failed .rag-exec-status { opacity: 0.9; }
.rag-exec-empty {
  font-size: 12px;
  color: var(--color-text-muted, #6e7280);
  padding: 3px 0;
}

/* 单工具展开详情：grid 0fr→1fr 高度动画；标签无底，内容加底；失败时结果区红底 */
.rag-exec-detail-wrap {
  display: grid;
  grid-template-rows: 0fr;
  margin-bottom: 0;
  transition: grid-template-rows 0.24s var(--ease-spring, ease), margin-bottom 0.24s var(--ease-spring, ease);
}
.rag-exec-detail-wrap.is-open {
  grid-template-rows: 1fr;
  /* 展开时与下一个工具行拉开间隔（随高度动画一起渐变；折叠态收回 0 不占位）*/
  margin-bottom: 10px;
}
.rag-exec-detail {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rag-exec-detail-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.rag-exec-detail-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text-muted, #6e7280);
}
.rag-exec-detail-pre {
  margin: 0;
  padding: 7px 9px;
  background: var(--color-bg-input, #f4f5f8);
  border-radius: var(--radius-sm, 8px);
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  color: var(--color-text-secondary, #4b4c55);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.rag-exec-detail-text {
  padding: 7px 9px;
  background: var(--color-bg-input, #f4f5f8);
  border-radius: var(--radius-sm, 8px);
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-secondary, #4b4c55);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.rag-exec-detail-text.is-error {
  background: rgba(var(--color-error-rgb, 224, 82, 82), 0.1);
  color: var(--color-error, #e05252);
}

/* ── 打字三点 ── */
.rag-typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 2px;
}
.rag-typing span {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-line, #c5c6cc);
  animation: rag-typing-bounce 0.55s ease-in-out infinite;
}
.rag-typing span:nth-child(2) { animation-delay: 0.13s; }
.rag-typing span:nth-child(3) { animation-delay: 0.26s; }
@keyframes rag-typing-bounce {
  0%, 100% { transform: translateY(0); opacity: 0.6; }
  50% { transform: translateY(-4px); opacity: 1; }
}

.rag-msg--interaction {
  align-self: stretch;
}

/* ── 断连条 ── */
.rag-conn-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(var(--color-error-rgb, 224, 82, 82), 0.1);
  border-top: 1px solid var(--color-border, rgba(0, 0, 0, 0.06));
  color: var(--color-error, #e05252);
  font-size: 12px;
}
.rag-reconnect {
  background: var(--color-error, #e05252);
  color: var(--color-on-accent, #fff);
  border: none;
  border-radius: var(--radius-md, 10px);
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

/* ── 输入栏 ── */
.rag-input-bar {
  padding: 8px 12px 12px;
  border-top: 1px solid var(--color-border, rgba(0, 0, 0, 0.05));
}
.rag-input-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--color-bg-input, #f4f5f8);
  border-radius: var(--radius-pill, 14px);
  padding: 6px 10px;
}
.rag-input-btn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-md, 10px);
  background: transparent;
  color: var(--color-text-faint, #9ea0ab);
  cursor: default;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rag-input-btn :deep(svg) { width: 16px; height: 16px; }
.rag-input {
  flex: 1;
  min-width: 0;
  min-height: 24px;
  max-height: 120px;
  resize: none;
  background: transparent;
  border: none;
  color: var(--color-text-primary, #1a1b1e);
  padding: 4px 0;
  font-size: 13.5px;
  font-family: inherit;
  outline: none;
  line-height: 1.5;
}
.rag-input::placeholder { color: var(--color-text-placeholder, #b0b3be); }
.rag-input:disabled { opacity: 0.6; }

.rag-send {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-line, #c5c6cc);
  color: var(--color-on-accent, #fff);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--transition-fast), transform 0.12s var(--ease-default);
}
.rag-send :deep(svg) { width: 13px; height: 13px; }
.rag-send:not(:disabled) { background: var(--color-accent, #4b4c55); }
.rag-send:not(:disabled):hover { transform: scale(1.05); }
.rag-send:disabled { cursor: not-allowed; opacity: 0.5; }
.rag-send.rag-stop { background: var(--color-error, #e05252); }
.rag-send.rag-stop:hover { transform: scale(1.05); }

/* ── 面板开合动画（近似弹簧）── */
.rag-panel-enter-active,
.rag-panel-leave-active {
  transition: opacity 0.22s var(--ease-spring), transform 0.22s var(--ease-spring);
  transform-origin: bottom right;
}
.rag-panel-enter-from,
.rag-panel-leave-to {
  opacity: 0;
  transform: translateY(16px) scale(0.97);
}
</style>
