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
          <button class="rag-close" @click="toggleOpen" aria-label="关闭">×</button>
        </header>

        <!-- 纯对话面板：消息流（含折叠执行步骤 + 流内审批卡片） -->
        <div class="rag-messages" ref="messagesEl">
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
            :submitting-id="''"
            class="rag-msg rag-msg--interaction"
            @submit="onApprovalSubmit"
          />
        </div>

        <footer class="rag-input-bar">
          <textarea
            v-model="draft"
            class="rag-input"
            rows="1"
            placeholder="输入消息，Enter 发送"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button v-if="isActiveRun" class="rag-send rag-stop" @click="stop">停止</button>
          <button v-else class="rag-send" :disabled="!draft.trim()" @click="send">发送</button>
        </footer>
      </section>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
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

onMounted(async () => {
  client = new WidgetAgentClient({
    backendBase: props.backendBase,
    sessionId: props.sessionId,
    token: props.token,
    hostTools: props.hostTools,
  });
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
  client?.disconnect();
});

function toggleOpen() {
  open.value = !open.value;
}

function handleEvent(env) {
  if (env.type === "run_started") {
    messages.value.push({
      id: env.run_id || `a${Date.now()}`,
      role: "assistant",
      content: "",
      finished: false,
      executionTree: null,
      execOpen: false,
    });
    scrollToBottom();
    return;
  }
  if (env.type === "stream_output") {
    const payload = env.payload || {};
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "assistant") {
      if (payload.phase === "final") {
        last.content = payload.content || last.content;
      } else if (payload.phase === "first_token" || payload.phase === "delta") {
        last.content += payload.content || "";
      }
      if (payload.phase === "final") last.finished = true;
      scrollToBottom();
    }
    return;
  }
  if (env.type === "run_ended") {
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "assistant") last.finished = true;
    return;
  }
  if (env.type === "error") {
    const payload = env.payload || {};
    messages.value.push({ id: `e${Date.now()}`, role: "assistant", content: `⚠️ ${payload.message || "错误"}`, finished: true, executionTree: null, execOpen: false });
    scrollToBottom();
    return;
  }
}

async function send() {
  const text = draft.value.trim();
  if (!text || !client || isActiveRun.value) return;
  messages.value.push({ id: `u${Date.now()}`, role: "user", content: text });
  draft.value = "";
  scrollToBottom();
  await client.send({ task: text });
}

function stop() {
  client?.stop();
}

function onApprovalSubmit({ approvalId, approved, message }) {
  client?.approve(approvalId, approved, message);
}
function onUserInputSubmit({ inputId, value }) {
  client?.respondInput(inputId, value);
}
function onUserInputCancel() {
  // 一期不取消。
}

const isActiveRun = computed(() => runStatus.value.state === "running");

const statusTone = computed(() => {
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

/** 工具状态 SVG 图标：成功=实心圆勾/失败=实心圆叉/运行=脉冲点（currentColor 取色）。 */
function statusIconSvg(status) {
  if (status === "succeeded") {
    return `<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5 8.5l2 2 4-4.5" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (status === "failed") {
    return `<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="3" fill="currentColor" class="rag-pulse"/></svg>`;
}

/** 子 agent 分组图标（嵌套分支）。 */
const agentIconSvg = `<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4v5a2 2 0 0 0 2 2h5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><circle cx="4" cy="3.6" r="1.6" fill="currentColor"/><circle cx="11.5" cy="11" r="1.6" fill="currentColor"/></svg>`;

/** 单工具一行摘要：运行中→运行中；失败→失败；成功→简短结果。 */
function toolSummary(tool) {
  if (tool.status === "running") return "运行中";
  if (tool.status === "failed") return "失败";
  const obs = tool.observation || tool.summary || "";
  if (!obs) return "完成";
  const text = String(obs).replace(/\s+/g, " ").trim();
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
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
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-brand-accent, #0a84ff);
  padding: 4px 0 2px;
}
.rag-exec-agent-icon { display: inline-flex; opacity: 0.85; }
.rag-pulse { animation: rag-pulse 1.4s ease-in-out infinite; }
@keyframes rag-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.rag-exec-agent-name { font-family: var(--font-mono, monospace); }
.rag-exec-agent-status { color: var(--color-text-muted, #636366); font-weight: 400; }
.rag-exec-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-secondary, #98989d);
  padding: 2px 0;
}
.rag-exec-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  flex-shrink: 0;
}
.rag-exec-name {
  font-family: var(--font-mono, monospace);
  color: var(--color-text-primary, #fff);
  flex-shrink: 0;
}
.rag-exec-status {
  color: var(--color-text-muted, #636366);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.st-running .rag-exec-icon { color: var(--color-brand-accent, #0a84ff); }
.st-succeeded .rag-exec-icon { color: var(--color-success, #30d158); }
.st-failed .rag-exec-icon { color: var(--color-error, #ff453a); }
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
