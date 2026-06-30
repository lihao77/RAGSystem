<template>
  <div class="rag-root">
    <!-- 浮动按钮 -->
    <button v-if="!open" class="rag-fab" @click="toggleOpen" aria-label="打开 Agent">
      <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
        <path d="M12 3a9 9 0 0 0-9 9c0 1.5.4 2.9 1 4.1L3 21l4.9-1c1.2.6 2.6 1 4.1 1a9 9 0 0 0 0-18z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <circle cx="8.5" cy="12" r="1" fill="currentColor"/>
        <circle cx="12" cy="12" r="1" fill="currentColor"/>
        <circle cx="15.5" cy="12" r="1" fill="currentColor"/>
      </svg>
    </button>

    <!-- 对话框 -->
    <Transition name="rag-panel">
      <section v-if="open" class="rag-panel">
        <header class="rag-header">
          <span class="rag-title">
            <span class="rag-dot" :class="`dot-${statusTone}`"></span>
            Agent
          </span>
          <span v-if="connBadgeText" class="rag-conn-badge" :class="`conn-${connectionStatus.state}`">{{ connBadgeText }}</span>
          <button class="rag-close" @click="toggleOpen" aria-label="关闭">×</button>
        </header>

        <!-- 纯对话面板：消息流（含折叠执行步骤 + 流内审批卡片） -->
        <div class="rag-messages" ref="messagesEl" @scroll="onMessagesScroll">
          <div v-if="!messages.length && !approvalQueueView.length && !pendingUserInputView" class="rag-empty">
            输入消息开始对话
          </div>

          <template v-for="msg in messages" :key="msg.id">
            <div v-if="msg.role === 'user'" class="rag-msg rag-msg--user">
              <div class="rag-user-text">{{ msg.content }}</div>
            </div>
            <div v-else class="rag-msg rag-msg--assistant">
              <div class="rag-assistant-text" v-html="renderMarkdown(msg.content || (msg.finished ? '' : '思考中…'))"></div>
              <!-- 执行步骤折叠在消息内（极简：一行一工具） -->
              <button
                v-if="msg.executionTree && msg.executionTree.root"
                class="rag-exec-toggle"
                @click="msg.execOpen = !msg.execOpen"
              >
                <span class="rag-exec-chevron" :class="{ open: msg.execOpen }">›</span>
                <span class="rag-exec-label">执行步骤</span>
                <span v-if="!msg.finished" class="rag-exec-running">进行中</span>
              </button>
              <div v-if="msg.execOpen && msg.executionTree" class="rag-exec-list">
                <template v-for="(node, idx) in extractNodes(msg.executionTree)" :key="idx">
                  <div
                    v-if="node.type === 'agent'"
                    class="rag-exec-agent"
                    :style="{ paddingLeft: node.depth * 16 + 'px' }"
                  >
                    <span class="rag-exec-agent-icon" v-html="agentIconSvg"></span>
                    <span class="rag-exec-agent-name">{{ node.name }}</span>
                    <span v-if="agentStatusText(node.status)" class="rag-exec-agent-status">{{ agentStatusText(node.status) }}</span>
                  </div>
                  <div
                    v-else
                    class="rag-exec-row"
                    :class="`st-${node.tool.status}`"
                    :style="{ paddingLeft: node.depth * 16 + 'px' }"
                  >
                    <span class="rag-exec-icon" v-html="statusIconSvg(node.tool.status)"></span>
                    <span class="rag-exec-name">{{ node.tool.toolName }}</span>
                    <span class="rag-exec-status">{{ toolSummary(node.tool) }}</span>
                  </div>
                </template>
                <div v-if="!extractNodes(msg.executionTree).length" class="rag-exec-empty">
                  {{ msg.finished ? "无工具调用" : "等待中…" }}
                </div>
              </div>
            </div>
          </template>

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

        <footer class="rag-input-bar">
          <textarea
            v-model="draft"
            class="rag-input"
            rows="1"
            :placeholder="isConnected ? '输入消息，Enter 发送' : '等待连接…'"
            :disabled="!isConnected"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button v-if="isActiveRun" class="rag-send rag-stop" @click="stop">停止</button>
          <button v-else class="rag-send" :disabled="!draft.trim() || sending" @click="send">发送</button>
        </footer>
      </section>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { WidgetAgentClient } from "../adapter/widget-agent-client.js";
import { renderMarkdown } from "../utils/markdown.js";
import WorkPanelApproval from "./workpanel/WorkPanelApproval.vue";
import WorkPanelUserInput from "./workpanel/WorkPanelUserInput.vue";

/**
 * widget 主面板：FAB + 对话框（ChatGPT 风格）。
 *
 * 形态：对话面板纯对话；执行步骤折叠挂在 agent 消息内（极简一行一工具，不用重型 workpanel 组件）；
 * 审批/用户输入作为消息流内卡片。
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

// 流式渲染节流：delta 累积到 streamBuffer，定时 flush 到当前 assistant message，
// 限制 markdown-it 全量重渲频率（长回复避免每 token 重算叠加成 O(n²) 卡顿）。
const STREAM_FLUSH_MS = 80;
let streamTarget = null;
let streamBuffer = "";
let streamFlushTimer = null;

// 滚动跟随：用户上滑阅读时不强制拉底；scrollToBottom 用 rAF 合并高频调用。
let stickToBottom = true;
let scrollRafScheduled = false;

onMounted(async () => {
  client = new WidgetAgentClient({
    backendBase: props.backendBase,
    sessionId: props.sessionId,
    token: props.token,
    hostTools: props.hostTools,
  });
  unsub.push(client.status.subscribe((s) => { connectionStatus.value = s; }));
  unsub.push(client.runStatus.subscribe((s) => { runStatus.value = s; }));
  // executionTree 挂到当前 run 产生的最新 assistant message（执行步骤属该回复）。
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
  // 若改成 await 后再 push，run_started 事件会在 await 期间先把 assistant（"思考中…"）入列，
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

/** 从 executionTree 提取带层级的节点（工具 + 子 agent 分组），子 agent 工具按 depth 缩进。 */
function extractNodes(tree) {
  const nodes = [];
  const walk = (agent, depth) => {
    if (!agent) return;
    for (const round of agent.rounds || []) {
      for (const tc of round.toolCalls || []) {
        // call_agent/send_message 用子 agent 分组节点代替，避免重复
        if (tc.toolName === "call_agent" || tc.toolName === "send_message") continue;
        nodes.push({ type: "tool", depth, tool: tc });
      }
    }
    for (const child of agent.children || []) {
      nodes.push({ type: "agent", depth, name: child.displayName || child.agentId, status: child.status });
      walk(child, depth + 1);
    }
  };
  walk(tree?.root, 0);
  return nodes;
}

function agentStatusText(status) {
  if (status === "running") return "进行中";
  if (status === "failed") return "失败";
  return "";
}

/** 工具状态图标：纯线条（对勾 / 叉 / 旋转弧），无圆底，currentColor 取状态色。 */
function statusIconSvg(status) {
  if (status === "succeeded") {
    return `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M3.2 8.4l3 3 6.6-7.2" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (status === "failed") {
    return `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" width="15" height="15" class="rag-spin"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

/** 子智能体图标：AI 双火花（sparkle），直观表达"智能体"语义。 */
const agentIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M6 2L7.1 4.4L9.5 5.5L7.1 6.6L6 9L4.9 6.6L2.5 5.5L4.9 4.4Z" fill="currentColor"/><path d="M11.5 9.2L12.1 10.4L13.3 11L12.1 11.6L11.5 12.8L10.9 11.6L9.7 11L10.9 10.4Z" fill="currentColor" opacity="0.6"/></svg>`;

/** 单工具一行摘要：运行中→运行中；失败→失败；成功→简短结果。 */
function toolSummary(tool) {
  if (tool.status === "running") return "运行中";
  if (tool.status === "failed") return "失败";
  const obs = tool.observation || tool.summary || "";
  if (!obs) return "完成";
  const text = String(obs).replace(/\s+/g, " ").trim();
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
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
</script>

<style scoped>
.rag-root {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 9999;
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 14px;
  color: var(--color-text-primary, #fff);
}

.rag-fab {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-full, 9999px);
  border: none;
  background: var(--color-brand-accent, #0a84ff);
  color: var(--color-on-color, #fff);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}
.rag-fab:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.34);
}

.rag-panel {
  position: absolute;
  bottom: 0;
  right: 0;
  width: min(400px, 92vw);
  height: min(600px, 82vh);
  background: var(--color-bg-primary, #1c1c1e);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: var(--radius-xl, 14px);
  box-shadow: var(--shadow-xl, 0 18px 48px rgba(0, 0, 0, 0.4));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.rag-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  background: var(--color-bg-elevated, #1c1c1e);
}
.rag-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--color-text-primary, #fff);
}
.rag-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-text-muted, #636366);
}
.dot-running { background: var(--color-brand-accent, #0a84ff); }
.dot-warning { background: var(--color-warning, #ffd60a); }
.dot-error { background: var(--color-error, #ff453a); }
.dot-success { background: var(--color-success, #30d158); }
.dot-input { background: var(--color-brand-accent, #0a84ff); }

.rag-close {
  background: none;
  border: none;
  color: var(--color-text-secondary, #98989d);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}

.rag-conn-badge {
  margin-left: auto;
  margin-right: 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted, #636366);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--color-bg-secondary, #2c2c2e);
}
.rag-conn-badge.conn-connecting,
.rag-conn-badge.conn-reconnecting { color: var(--color-brand-accent, #0a84ff); }
.rag-conn-badge.conn-disconnected { color: var(--color-error, #ff453a); }

.rag-conn-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(var(--color-error-rgb, 255, 69, 58), 0.12);
  border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  color: var(--color-error, #ff453a);
  font-size: 12px;
}
.rag-reconnect {
  background: var(--color-error, #ff453a);
  color: var(--color-on-color, #fff);
  border: none;
  border-radius: var(--radius-md, 10px);
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.rag-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rag-empty {
  color: var(--color-text-muted, #636366);
  text-align: center;
  margin-top: 40px;
}

.rag-msg--user {
  align-self: flex-end;
  max-width: 85%;
}
.rag-user-text {
  background: var(--color-bg-message-user, #2c2c2e);
  color: var(--color-text-primary, #fff);
  padding: 9px 13px;
  border-radius: var(--radius-lg, 12px);
  white-space: pre-wrap;
  word-break: break-word;
}
.rag-msg--assistant {
  align-self: stretch;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rag-assistant-text {
  color: var(--color-text-primary, #fff);
  line-height: 1.6;
  word-break: break-word;
}
.rag-assistant-text pre {
  background: var(--color-bg-secondary, #2c2c2e);
  padding: 10px 12px;
  border-radius: var(--radius-sm, 8px);
  overflow-x: auto;
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
.rag-assistant-text a { color: var(--color-link, #0a84ff); }

/* 消息内折叠执行步骤（极简一行一工具） */
.rag-exec-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text-muted, #636366);
  font-family: inherit;
  padding: 2px 0;
  align-self: flex-start;
}
.rag-exec-toggle:hover { color: var(--color-text-secondary, #98989d); }
.rag-exec-chevron {
  display: inline-block;
  font-size: 14px;
  transition: transform 0.2s ease;
}
.rag-exec-chevron.open { transform: rotate(90deg); }
.rag-exec-label { font-weight: 500; }
.rag-exec-running { color: var(--color-brand-accent, #0a84ff); font-size: 11px; }

.rag-exec-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
}
.rag-exec-agent {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-brand-accent, #0a84ff);
  padding: 6px 0 3px;
  letter-spacing: 0.01em;
}
.rag-exec-agent-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-brand-accent, #0a84ff);
  opacity: 0.9;
}
.rag-exec-agent-name { font-family: var(--font-mono, monospace); }
.rag-exec-agent-status { color: var(--color-text-muted, #636366); font-weight: 400; }

/* running：旋转环加载指示（替代原脉冲点，更清晰现代） */
.rag-spin { animation: rag-spin 0.7s linear infinite; transform-origin: 50% 50%; }
@keyframes rag-spin { to { transform: rotate(360deg); } }

.rag-exec-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-secondary, #98989d);
  padding: 3px 0;
}
.rag-exec-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.rag-exec-name {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--color-text-secondary, #98989d);
  flex-shrink: 0;
  transition: color var(--transition-fast, 160ms);
}
.rag-exec-status {
  color: var(--color-text-muted, #636366);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  transition: color var(--transition-fast, 160ms);
}

/* 状态分层着色：图标/工具名/摘要随状态变化，运行中·成功·失败一眼可辨 */
.st-running .rag-exec-icon,
.st-running .rag-exec-name { color: var(--color-brand-accent, #0a84ff); }
.st-succeeded .rag-exec-icon { color: var(--color-success, #30d158); }
.st-succeeded .rag-exec-name { color: var(--color-text-secondary, #98989d); }
.st-failed .rag-exec-icon,
.st-failed .rag-exec-name,
.st-failed .rag-exec-status { color: var(--color-error, #ff453a); }
.st-failed .rag-exec-status { opacity: 0.85; }
.rag-exec-empty {
  font-size: 12px;
  color: var(--color-text-muted, #636366);
  padding: 2px 0 2px 20px;
}

.rag-msg--interaction {
  align-self: stretch;
}

.rag-input-bar {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  background: var(--color-bg-elevated, #1c1c1e);
}
.rag-input {
  flex: 1;
  min-height: 40px;
  max-height: 120px;
  resize: none;
  background: var(--color-bg-secondary, #2c2c2e);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: var(--radius-md, 10px);
  color: var(--color-text-primary, #fff);
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  outline: none;
}
.rag-input:focus { border-color: var(--color-border-focus, rgba(10, 132, 255, 0.5)); }
.rag-send {
  align-self: flex-end;
  padding: 10px 18px;
  border: none;
  border-radius: var(--radius-md, 10px);
  background: var(--color-brand-accent, #0a84ff);
  color: var(--color-on-color, #fff);
  font-weight: 600;
  cursor: pointer;
  font-size: 14px;
}
.rag-send:disabled { opacity: 0.4; cursor: not-allowed; }
.rag-send.rag-stop { background: var(--color-error, #ff453a); }

.rag-panel-enter-active,
.rag-panel-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.rag-panel-enter-from,
.rag-panel-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.98);
}
</style>
