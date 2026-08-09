<template>
  <div class="rag-root" :style="rootStyle">
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
          <button class="rag-icon-btn rag-icon-btn--reset" @click="newSession" title="新会话" aria-label="新会话">
            <span v-html="rotateCcwIcon"></span>
          </button>
          <button class="rag-icon-btn rag-icon-btn--close" @click="toggleOpen" aria-label="关闭">
            <span v-html="xIcon"></span>
          </button>
        </header>

        <!-- 消息流：含折叠工具调用 + 打字三点 + 流内审批/输入卡片 -->
        <div class="rag-messages" ref="messagesEl" @scroll="onMessagesScroll">
          <div v-if="!messages.length && !approvalQueueView.length && !pendingUserInputView" class="rag-empty">
            输入消息开始对话
          </div>

          <template v-for="msg in messages" :key="msg.id">
            <div v-if="msg.role === 'user'" class="rag-msg rag-msg--user">
              <div v-if="msg.uiContext?.entries?.length" class="rag-ui-context" style="display:flex;flex-direction:column;gap:2px;padding:6px 8px;margin-bottom:4px;border-radius:8px;background:rgba(125,125,125,0.08);border:1px solid rgba(125,125,125,0.18);font-size:13px;line-height:1.5">
                <div v-for="e in msg.uiContext.entries" :key="e.key" class="rag-ui-entry" style="display:flex;gap:6px;align-items:baseline">
                  <span class="rag-ui-label" style="opacity:0.6;flex-shrink:0">{{ e.label }}</span>
                  <span class="rag-ui-value" style="opacity:0.85;word-break:break-word">{{ e.value }}<span v-if="e.detail" class="rag-ui-detail" style="opacity:0.6"> · {{ e.detail }}</span></span>
                </div>
              </div>
              <div class="rag-user-text">{{ msg.content }}</div>
            </div>
            <div v-else class="rag-msg rag-msg--assistant">
              <!-- 工具调用折叠（N 个工具调用）——grid 0fr→1fr 展开动画，padding 下沉到裁剪区内层 -->
              <div class="rag-exec-section" v-if="msg.executionTree && msg.executionTree.root">
                <button
                  class="rag-exec-toggle"
                  @click="msg.execOpen = !msg.execOpen"
                >
                <span class="rag-exec-label">{{ toolCallCount(msg.executionTree) }} tool calls</span>
                <span class="rag-exec-chevron" v-html="msg.execOpen ? chevronUpIcon : chevronDownIcon"></span>
              </button>
              <div class="rag-exec-list-outer" :class="{ 'is-open': msg.execOpen }">
                <div class="rag-exec-list-clip">
                  <div class="rag-exec-list" v-if="msg.executionTree">
                    <ExecutionTreeNode
                      v-for="(child, idx) in buildTree(msg.executionTree)"
                      :key="child.foldId || (child.tool && child.tool.callId) || idx"
                      :node="child"
                    />
                    <div v-if="!buildTree(msg.executionTree).length" class="rag-exec-empty">
                      {{ msg.finished ? "无工具调用" : "等待中…" }}
                    </div>
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

        </div>

        <!-- 审批 / 用户输入：悬浮卡片（独立于消息列表，浮于输入栏上方）-->
        <div v-if="pendingUserInputView || approvalQueueView.length" class="rag-interaction-overlay">
          <WorkPanelUserInput
            v-if="pendingUserInputView"
            :input-data="pendingUserInputView.data"
            :response-allowed="canRespondInteraction"
            @submit="onUserInputSubmit"
            @cancel="onUserInputCancel"
          />
          <WorkPanelApproval
            v-if="approvalQueueView.length"
            :queue="approvalQueueView"
            :submitting-id="submittingApprovalId"
            :response-allowed="canRespondInteraction"
            @submit="onApprovalSubmit"
          />
        </div>

        <div v-if="connectionStatus.state === 'disconnected'" class="rag-conn-bar">
          <span>连接已断开</span>
          <button class="rag-reconnect" @click="reconnect">重新连接</button>
        </div>

        <!-- 输入栏：胶囊容器 + Plus + 输入框 + Mic + 圆形 Send/Stop -->
        <footer class="rag-input-bar">
          <!-- 宿主自定义工具按钮（输入框上方一行，如地图选点/框选/画线） -->
          <div v-if="inputTools.length" class="rag-input-tools">
            <button
              v-for="tool in inputTools"
              :key="tool.id"
              class="rag-input-tool"
              :title="tool.title || tool.label"
              :aria-label="tool.title || tool.label"
              @click="onInputToolClick(tool)"
            >
              <span v-if="tool.icon" class="rag-input-tool-icon" v-html="tool.icon"></span>
              <span v-else class="rag-input-tool-icon">{{ tool.label }}</span>
              <span v-if="tool.title" class="rag-input-tool-text">{{ tool.title }}</span>
            </button>
          </div>
          <div class="rag-input-pill">
            <!-- contentEditable 富文本：文字 + chip（坐标）混排，chip 嵌在文字流（mention 风格），×整体删。 -->
            <div class="rag-input-wrap">
              <!-- placeholder 绝对定位脱离编辑流：避免 contentEditable 内 ::before 与残留 <br> 叠加、光标穿透导致占位删不掉/错乱。 -->
              <span v-show="isEmpty" class="rag-input-ph">Send a message...</span>
              <div
                ref="inputEl"
                class="rag-input"
                contenteditable="true"
                @input="onInput"
                @focus="onInputFocus"
                @keydown.enter.exact.prevent="send"
              ></div>
            </div>
            <button
              v-if="canStopRun"
              class="rag-send rag-stop"
              @click="stop"
              aria-label="停止"
            >
              <span v-html="stopIcon"></span>
            </button>
            <button
              v-if="canResumeRun"
              class="rag-send"
              :disabled="sending"
              @click="resume"
              aria-label="恢复"
            >
              <span v-html="rotateCcwIcon"></span>
            </button>
            <button
              v-if="!canStopRun && !canResumeRun"
              class="rag-send"
              :disabled="isEmpty || sending || !canSendMessage"
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
import { ref, computed, provide, onBeforeUnmount, onMounted, watch } from "vue";
import { WidgetAgentClient } from "../adapter/widget-agent-client.js";
import { renderMarkdown } from "../utils/markdown.js";
import WorkPanelApproval from "./workpanel/WorkPanelApproval.vue";
import WorkPanelUserInput from "./workpanel/WorkPanelUserInput.vue";
import ExecutionTreeNode from "./ExecutionTreeNode.vue";

/**
 * widget 主面板：FAB + 对话框（Figma「Assistance widget design」浅色极简风）。
 *
 * 形态：对话面板纯对话；工具调用折叠挂在 agent 消息内（N 个工具调用，状态图标一行一工具）；
 * 审批/用户输入作为消息流内卡片；打字三点指示助手思考中。
 */
const props = defineProps({
  backendBase: { type: String, required: true },
  sessionId: { type: String, default: undefined },
  token: { type: String, required: false },
  publishableKey: { type: String, required: false },
  hostTools: { type: Array, default: () => [] },
  inputTools: { type: Array, default: () => [] },
  fabPosition: { type: Object, default: () => ({ bottom: 24, right: 24 }) },
  /** 宿主组件状态采集函数（发消息时调，返回 entries 随消息进上下文）。 */
  uiState: { type: Function, required: false },
  /** 会话生命周期回调：session 创建/切换时通知宿主（懒建首次发送触发 sid、newSession 触发 null）。 */
  onSessionChange: { type: Function, required: false },
});

let client = null;
let clientUnsub = [];
// 懒连接前动态注册的 hostTool（宿主经 el.registerHostTool 提前注册，但 client 尚未创建）。
let pendingHostTools = [];
// 已注册 hostTool 的注销句柄（name → unsubscribe）；覆盖/注销时调用。
const hostToolUnsubs = new Map();
// 当前会话 id：null=未建（懒建，首次发送时 POST 创建）；宿主传入 sessionId 则直接用。
const sessionId = ref(props.sessionId || null);
// session 创建/切换时通知宿主（宿主据此联动按 session 绑定的外部资源，如 MCP 执行端注册）。
watch(sessionId, (sid) => { props.onSessionChange?.(sid ?? null); });
// 并发 send 复用同一连接建立 promise，避免重复建会话/连 WS。
let connectingPromise = null;

const open = ref(false);
const messages = ref([]);
// contentEditable 富文本输入：chip（坐标）作为 inline 整体单元嵌在文字流中（mention 风格）。
// Vue 不响应式管理内容；isEmpty 控制 placeholder（空 = 无文字无 chip）+ send 可用态。
const inputEl = ref(null);
const isEmpty = ref(true);
const messagesEl = ref(null);

const sessionRuntime = ref({
  state: "idle",
  load_strategy: "history",
  allowed_actions: [],
  active_run: null,
  last_run: null,
  pending_interactions: [],
  resume_interaction_id: null,
  maintenance: null,
  observed_at: "",
});
const pendingInteractions = computed(() => sessionRuntime.value.pending_interactions.map((item) => ({
  interactionId: item.interaction_id,
  kind: item.kind,
  status: item.status,
  toolName: item.payload?.tool,
  riskLevel: item.payload?.risk_level,
  arguments: item.payload?.input,
  prompt: item.payload?.prompt || item.payload?.message,
})));
const connectionStatus = ref({ state: "idle" });
const sending = ref(false);
const submittingApprovalId = ref("");
// 单工具展开态：按 callId 记录，展开显示参数 + 完整结果。
const expanded = ref(new Set());
// 折叠状态 provide 给递归 ExecutionTreeNode（全树共享一个 expanded Set）。
provide("execExpanded", expanded);
provide("execToggle", toggleFold);

// 流式渲染节流：delta 累积到 streamBuffer，定时 flush 到当前 assistant message，
// 限制 markdown-it 全量重渲频率（长回复避免每 token 重算叠加成 O(n²) 卡顿）。
const STREAM_FLUSH_MS = 80;
let streamTarget = null;
let streamBuffer = "";
// 当前 root run 的 run_id（run_started 登记）。stream_output/run_ended 的 run_id 与之不同
// 即为子智能体（agent/委托）的子 run，其输出不进 root 正文（由 executionTree 投影到 agent.output）。
let rootRunId = null;
// 当前 run 产生的 assistant message 引用（run_started 绑定）。
// executionTree 挂它而非 messages 末尾：abort 期间后端可能补 error envelope → pushError 推一条
// assistant 错误卡到末尾，若挂末尾会把同一棵工具树再挂到错误卡上，导致同一 tool call 渲染两次。
let currentRunMsg = null;
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

/** 订阅 client 各 observable → 本地响应式状态；返回 cleanup。 */
function bindClient(c) {
  const u = [];
  u.push(c.status.subscribe((s) => { connectionStatus.value = s; }));
  u.push(c.runtime.subscribe((snapshot) => { sessionRuntime.value = snapshot; }));
  // executionTree 挂到当前 run 的 assistant message（run_started 绑定 currentRunMsg）。
  // 工具调用属该回复；error 等后续消息不承载工具树，避免同一 tool call 在原消息与错误卡上各渲染一次。
  u.push(c.executionTree.subscribe((t) => {
    if (currentRunMsg) currentRunMsg.executionTree = t;
  }));
  u.push(c.events.subscribe((env) => handleEvent(env)));
  return () => u.forEach((fn) => { try { fn(); } catch {} });
}

/** widget 内部建会话（懒）：有 token→/api/widget/sessions，无 token→/api/agent/sessions 零鉴权。 */
async function createSession() {
  const base = props.backendBase.replace(/\/$/, "");
  const hostToolNames = (props.hostTools ?? []).map((t) => t.name);
  const res = props.token
    ? await fetch(`${base}/api/widget/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${props.token}` },
        body: JSON.stringify({ host_tools: hostToolNames }),
      })
    : props.publishableKey
      ? await fetch(`${base}/api/widget/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-widget-key": props.publishableKey },
          body: JSON.stringify({ host_tools: hostToolNames }),
        })
      : await fetch(`${base}/api/agent/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
  if (!res.ok) throw new Error(`会话创建失败: ${res.status} ${await res.text().catch(() => "")}`);
  const json = await res.json();
  const sid = json.data?.session_id;
  if (!sid) throw new Error("会话创建失败: 响应缺 session_id");
  return sid;
}

/** 懒连接：首次发送时建会话 + new client + connect；并发 send 复用同一 promise。 */
async function ensureConnected() {
  if (client && isConnected.value) return;
  if (connectingPromise) return connectingPromise;
  connectingPromise = (async () => {
    if (!sessionId.value) sessionId.value = await createSession();
    const c = new WidgetAgentClient({
      backendBase: props.backendBase,
      sessionId: sessionId.value,
      token: props.token,
      publishableKey: props.publishableKey,
      hostTools: props.hostTools,
    });
    clientUnsub.forEach((fn) => { try { fn(); } catch {} });
    clientUnsub = [bindClient(c)];
    client = c;
    // flush 懒连接前动态注册的 hostTool（构造函数已收 props.hostTools，此处补动态部分）。
    if (pendingHostTools.length) {
      const toFlush = pendingHostTools;
      pendingHostTools = [];
      for (const { spec } of toFlush) {
        if (hostToolUnsubs.has(spec.name)) { try { hostToolUnsubs.get(spec.name)(); } catch {} }
        hostToolUnsubs.set(spec.name, c.registerTool(spec));
      }
    }
    await client.connect();
  })();
  try {
    await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

/**
 * 运行时动态注册宿主工具（透出给宿主：el.registerHostTool）。
 * 复用 WidgetAgentClient.registerTool（已支持已连接时立即重发 tools.register）；
 * client 未创建（懒连接前）则缓存，ensureConnected 时一并 flush。
 */
function registerHostTool(spec) {
  if (client) {
    if (hostToolUnsubs.has(spec.name)) { try { hostToolUnsubs.get(spec.name)(); } catch {} }
    hostToolUnsubs.set(spec.name, client.registerTool(spec));
  } else {
    pendingHostTools = pendingHostTools.filter((s) => s.spec.name !== spec.name);
    pendingHostTools.push({ spec });
  }
  return () => unregisterHostTool(spec.name);
}

function unregisterHostTool(name) {
  if (hostToolUnsubs.has(name)) {
    try { hostToolUnsubs.get(name)(); } catch {}
    hostToolUnsubs.delete(name);
  } else {
    pendingHostTools = pendingHostTools.filter((s) => s.spec.name !== name);
  }
}

defineExpose({ registerHostTool, unregisterHostTool });

onBeforeUnmount(() => {
  clientUnsub.forEach((fn) => { try { fn(); } catch {} });
  if (streamFlushTimer) { clearTimeout(streamFlushTimer); streamFlushTimer = null; }
  client?.disconnect();
});

onMounted(() => {
  if (sessionId.value) {
    void ensureConnected().catch((error) => pushError(`连接失败：${error?.message || "请稍后重试"}`));
  }
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
    rootRunId = env.run_id || null;
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
    // 绑定执行树挂载目标：整个 run 的 executionTree 都挂到这条消息。
    // 取 reactive proxy（messages.value[length-1]）而非原始 msg——直接改原始对象属性不触发 Vue 响应式
    //（executionTree 赋值不 trigger，工具节点不实时显示；纯工具调用无文本流时尤为明显）。
    currentRunMsg = messages.value[messages.value.length - 1];
    streamBuffer = "";
    scrollToBottom();
    return;
  }
  if (env.type === "stream_output") {
    const payload = env.payload || {};
    // 子智能体（子 run）的输出不进 root 正文，由 executionTree 投影到 agent.output。
    if (env.run_id && rootRunId && env.run_id !== rootRunId) {
      return;
    }
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
    // 子 run 结束不应 mark root finished。
    if (env.run_id && rootRunId && env.run_id !== rootRunId) {
      return;
    }
    flushStream(); // 收尾：刷掉残留 buffer，避免最后一段 delta 丢失
    streamTarget = null;
    streamBuffer = "";
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === "assistant") last.finished = true;
    return;
  }
  if (env.type === "state_sync" && env.payload?.category === "command_result") {
    flushStream();
    streamTarget = null;
    streamBuffer = "";
    const detail = env.payload.detail || {};
    messages.value.push({
      id: env.payload.ref?.message_id || `a${Date.now()}`,
      role: "assistant",
      content: detail.content || "",
      finished: true,
      executionTree: null,
      execOpen: false,
    });
    scrollToBottom();
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
  const text = getInputText();
  if (!text || !canSendMessage.value || sending.value) return;
  sending.value = true;
  try {
    // 懒连接：首次发送时建会话 + 连 WS（未发送不建会话，避免加载即建空会话）。
    await ensureConnected();
    if (!isConnected.value) {
      pushError("发送失败：连接未就绪");
      return;
    }
    // 乐观先入用户消息：保证 user 在 run_started 投影出的 assistant 消息之前。
    // ensureConnected 先于 push：连接期间无 assistant 消息（尚未 send），connect 完成后再入 user，顺序仍稳。
    // 采集宿主组件状态（同源 custom element，直接调宿主注入的 uiState；失败静默不阻断发送）
    let uiContext = null;
    if (typeof props.uiState === "function") {
      try {
        const entries = await props.uiState();
        if (Array.isArray(entries) && entries.length) {
          uiContext = { captured_at: new Date().toISOString(), entries };
        }
      } catch (e) {
        console.warn("[widget] uiState 采集失败:", e?.message || e);
      }
    }
    messages.value.push({ id: `u${Date.now()}`, role: "user", content: text, uiContext });
    if (inputEl.value) inputEl.value.innerHTML = "";
    isEmpty.value = true;
    scrollToBottom();
    const result = await client.send({ task: text, ...(uiContext ? { uiContext } : {}) });
    if (!result.started) {
      pushError(`发送失败：${result.error || "请稍后重试"}`);
    }
  } catch (e) {
    pushError(`发送失败：${e?.message || "请稍后重试"}`);
  } finally {
    sending.value = false;
  }
}

/**
 * 宿主输入工具按钮（如地图选点）点击入口。
 * 注入 setDraft/sendMessage，宿主在 onClick 里启动选点交互、完成后预填或直接发送。
 */
/** contentEditable：插入 chip（整体单元，×整体删，mention 风格嵌在文字流）。 */
function addAttachment(chip) {
  const el = inputEl.value;
  if (!el || !chip || !chip.text) return;
  const node = document.createElement("span");
  node.className = "rag-chip";
  node.contentEditable = "false";
  node.dataset.text = chip.text;
  if (chip.icon) {
    const ic = document.createElement("span");
    ic.className = "rag-chip-icon";
    ic.innerHTML = chip.icon;
    node.appendChild(ic);
  }
  const label = document.createElement("span");
  label.className = "rag-chip-label";
  label.textContent = chip.label || chip.text;
  const close = document.createElement("button");
  close.className = "rag-chip-close";
  close.type = "button";
  close.setAttribute("aria-label", "删除");
  close.innerHTML = xIcon;
  close.addEventListener("click", () => { node.remove(); onInput(); });
  node.appendChild(label);
  node.appendChild(close);
  el.appendChild(node);
  el.appendChild(document.createTextNode(" ")); // 尾随空格，光标可在 chip 后
  el.focus();
  placeCaretAtEnd(el);
  onInput();
}

/** 提取输入为消息文本：文字节点取 textContent，chip 取 dataset.text，拼一起。 */
function getInputText() {
  const el = inputEl.value;
  if (!el) return "";
  let text = "";
  // 递归遍历后代：TEXT_NODE 取文本，rag-chip 取 dataset.text（值与显示 label 可能不同），
  // 其他元素（粘贴的 div/span 等）继续下钻——原仅遍历直接子节点会漏掉粘贴内容导致发不出。
  const walk = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent || "";
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.classList?.contains("rag-chip")) {
          text += " " + (child.dataset.text || "") + " ";
        } else {
          walk(child);
        }
      }
    });
  };
  walk(el);
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** contentEditable input 事件：更新 isEmpty（控制 placeholder + send 可用态）。
 *  删空时主动清掉浏览器残留的 <br>/空块，避免占位与空行叠加、光标错乱。 */
function onInput() {
  const el = inputEl.value;
  if (!el) return;
  const hasChip = !!el.querySelector(".rag-chip");
  const empty = !hasChip && !el.textContent.trim();
  if (empty && el.innerHTML !== "") el.innerHTML = "";
  isEmpty.value = empty;
}

/** 光标移到 contentEditable 末尾（chip 插入后聚焦）。 */
function placeCaretAtEnd(el) {
  const sel = window.getSelection?.();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function onInputToolClick(tool) {
  const api = {
    setDraft: (text) => { if (inputEl.value) { inputEl.value.textContent = text; onInput(); } },
    addAttachment,
    sendMessage: async (text) => { if (inputEl.value) inputEl.value.textContent = text; await send(); },
  };
  Promise.resolve(tool.onClick(api)).catch((e) => console.error("[inputTool]", tool.id, e));
}

/* FAB 位置：宿主 props.fabPosition 配置（默认右下），生成 .rag-root 内联定位覆盖 CSS。 */
const rootStyle = computed(() => {
  const p = props.fabPosition || {};
  const fmt = (v) => (typeof v === "number" ? v + "px" : v);
  return [
    p.top != null ? `top:${fmt(p.top)}` : "top:auto",
    p.right != null ? `right:${fmt(p.right)}` : "right:auto",
    p.bottom != null ? `bottom:${fmt(p.bottom)}` : "bottom:auto",
    p.left != null ? `left:${fmt(p.left)}` : "left:auto",
  ].join(";");
});

/* contentEditable 空（placeholder 态）聚焦时强制光标到头部 */
function placeCaretAtStart(el) {
  const sel = window.getSelection?.();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
function onInputFocus() {
  if (isEmpty.value && inputEl.value) placeCaretAtStart(inputEl.value);
}

function stop() {
  client?.stop();
}

async function resume() {
  if (!client || sending.value || !canResumeRun.value) return;
  sending.value = true;
  try {
    if (!await client.resume()) pushError("恢复失败：当前会话无法恢复");
  } catch (error) {
    pushError(`恢复失败：${error?.message || "请稍后重试"}`);
  } finally {
    sending.value = false;
  }
}

function reconnect() {
  client?.connect();
}

/** 开启新会话：断开当前 client、丢弃 sessionId，清空消息与状态；下次发送时懒建新会话。 */
function newSession() {
  if (isActiveRun.value) return; // 运行中禁止
  connectingPromise = null;
  clientUnsub.forEach((fn) => { try { fn(); } catch {} });
  clientUnsub = [];
  client?.disconnect();
  client = null;
  sessionId.value = null;
  // 重置流式与 UI 状态
  flushStream();
  streamTarget = null;
  streamBuffer = "";
  rootRunId = null;
  currentRunMsg = null;
  if (streamFlushTimer) { clearTimeout(streamFlushTimer); streamFlushTimer = null; }
  messages.value = [];
  sessionRuntime.value = {
    state: "idle", load_strategy: "history", allowed_actions: [], active_run: null,
    last_run: null, pending_interactions: [], resume_interaction_id: null,
    maintenance: null, observed_at: "",
  };
  connectionStatus.value = { state: "idle" };
  expanded.value = new Set();
  isEmpty.value = true;
  if (inputEl.value) inputEl.value.innerHTML = "";
  stickToBottom = true;
  scrollToBottom();
}

async function onApprovalSubmit({ approvalId, approved, message }) {
  if (!client || submittingApprovalId.value || !canRespondInteraction.value) return;
  submittingApprovalId.value = approvalId;
  try {
    await client.approve(approvalId, approved, message);
  } catch (error) {
    pushError(`审批提交失败：${error?.message || "请稍后重试"}`);
  } finally {
    submittingApprovalId.value = "";
  }
}
function onUserInputSubmit({ inputId, value }) {
  if (canRespondInteraction.value) {
    void client?.respondInput(inputId, value)
      .catch((error) => pushError(`输入提交失败：${error?.message || "请稍后重试"}`));
  }
}
function onUserInputCancel() {
  // 一期不取消。
}

const isConnected = computed(() => connectionStatus.value.state === "connected");
const runtimeActions = computed(() => new Set(sessionRuntime.value.allowed_actions || []));
const canSendMessage = computed(() => !sessionId.value
  || (isConnected.value && (runtimeActions.value.has("send_message")
    || runtimeActions.value.has("send_followup"))));
const canStopRun = computed(() => isConnected.value && runtimeActions.value.has("stop_run"));
const canResumeRun = computed(() => isConnected.value && runtimeActions.value.has("resume_run"));
const canRespondInteraction = computed(() => isConnected.value && runtimeActions.value.has("respond_interaction"));
const isActiveRun = computed(() => Boolean(sessionRuntime.value.active_run));

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
  if (sessionRuntime.value.state === "running" || sessionRuntime.value.state === "resuming") return "running";
  if (sessionRuntime.value.last_run?.status === "failed") return "error";
  if (sessionRuntime.value.last_run?.status === "completed") return "success";
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
  if (sessionRuntime.value.state !== "running" && sessionRuntime.value.state !== "resuming") return false;
  const last = messages.value[messages.value.length - 1];
  return !!last && last.role === "assistant" && !last.content;
});

/** 从 executionTree 提取带层级的节点（工具 + 子 agent 分组），子 agent 工具按 depth 缩进。 */
/** 读取 agent 工具调用的目标 agent 名（input.agent_name 等）。*/
function readCallAgentTarget(tc) {
  const args = tc.arguments || {};
  return args.agent_name || args.agent || args.agentId || null;
}

function buildTree(tree) {
  if (!tree?.root) return [];
  // intentDepth = 该 agent 子项的缩进基准：root（自身不渲染）从 depth 起；
  // 子 agent（自身渲染一行）从 depth+1 起，保证 intent 缩进在所属 agent 之下而非与之平级。
  const build = (agent, depth, isRoot) => {
    const intentDepth = isRoot ? depth : depth + 1;
    const agentKey = agent.callId || agent.agentId || "root";
    const consumed = new Set();
    const children = [];
    for (const round of agent.rounds || []) {
      const roundChildren = [];
      for (const tc of round.toolCalls || []) {
        if (tc.toolName === "agent") {
          // 委托工具：用对应子 agent 节点代替，挂在该轮 intent 下。
          const target = readCallAgentTarget(tc);
          const child = (agent.children || []).find(
            (c) => !consumed.has(c.callId) && (target == null || c.agentId === target),
          );
          if (child) {
            consumed.add(child.callId);
            roundChildren.push(build(child, intentDepth + 1, false));
          }
          continue;
        }
        roundChildren.push({ type: "tool", tool: tc, depth: intentDepth + 1, foldId: tc.callId });
      }
      const hasIntent = !!(round.intent && round.intent.trim());
      if (hasIntent) {
        children.push({
          type: "intent", depth: intentDepth, foldId: `intent:${agentKey}:r${round.round}`,
          text: round.intent, complete: !!round.intentComplete, children: roundChildren,
        });
      } else {
        children.push(...roundChildren);
      }
    }
    for (const child of agent.children || []) {
      if (consumed.has(child.callId)) continue;
      children.push(build(child, intentDepth + 1, false));
    }
    return {
      type: "agent", depth, foldId: `agent:${agent.callId || agent.agentId}`,
      name: agent.displayName || agent.agentId, status: agent.status,
      task: agent.task, result: agent.result, children,
    };
  };
  // root agent 不显示（它是 orchestrator 容器），渲染其 children。
  return build(tree.root, 0, true).children;
}

/** 工具调用计数（递归遍历树，仅数 tool 节点）。 */
function toolCallCount(tree) {
  const count = (nodes) => nodes.reduce((sum, n) => {
    if (n.type === "tool") return sum + 1;
    if (n.children) return sum + count(n.children);
    return sum;
  }, 0);
  return count(buildTree(tree));
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
  height: min(560px, calc(100vh - 120px));
  max-height: min(560px, calc(100vh - 120px));
  background: var(--color-bg-panel, #fff);
  border-radius: var(--radius-xl, 16px);
  box-shadow: var(--shadow-panel);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
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
  gap: 10px;
}
.rag-assistant-text {
  color: var(--color-text-primary, #1a1b1e);
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}
.rag-assistant-text > *:first-child { margin-top: 0; }
.rag-assistant-text > *:last-child { margin-bottom: 0; }
.rag-assistant-text p { margin: 0.6em 0; }
.rag-assistant-text h1,
.rag-assistant-text h2,
.rag-assistant-text h3,
.rag-assistant-text h4,
.rag-assistant-text h5,
.rag-assistant-text h6 {
  margin: 1.15em 0 0.5em;
  font-weight: 600;
  line-height: 1.35;
  color: var(--color-text-primary, #1a1b1e);
}
.rag-assistant-text h1 { font-size: 1.3em; }
.rag-assistant-text h2 { font-size: 1.2em; }
.rag-assistant-text h3 { font-size: 1.1em; }
.rag-assistant-text h4,
.rag-assistant-text h5,
.rag-assistant-text h6 { font-size: 1em; }
.rag-assistant-text ul,
.rag-assistant-text ol { padding-left: 1.5em; margin: 0.6em 0; }
.rag-assistant-text li { margin: 0.25em 0; }
.rag-assistant-text li > ul,
.rag-assistant-text li > ol { margin: 0.25em 0; }
/* task-list 复选框 */
.rag-assistant-text input[type="checkbox"] { margin-right: 0.4em; transform: translateY(1px); }
.rag-assistant-text strong { font-weight: 600; }
.rag-assistant-text em { font-style: italic; }
.rag-assistant-text a {
  color: var(--color-link, #4b4c55);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.rag-assistant-text a:hover { opacity: 0.8; }
/* 行内 code */
.rag-assistant-text code {
  font-family: var(--font-mono, monospace);
  font-size: 0.88em;
  padding: 0.15em 0.4em;
  background: var(--color-bg-input, #f4f5f8);
  border-radius: 4px;
  color: var(--color-text-secondary, #4b4c55);
}
/* 代码块 */
.rag-assistant-text pre {
  margin: 0.7em 0;
  padding: 11px 13px;
  background: var(--color-bg-input, #f4f5f8);
  border-radius: var(--radius-sm, 8px);
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.55;
}
.rag-assistant-text pre code {
  padding: 0;
  background: none;
  border-radius: 0;
  color: inherit;
  font-size: inherit;
}
/* 引用 */
.rag-assistant-text blockquote {
  margin: 0.7em 0;
  padding: 0.2em 0 0.2em 0.9em;
  border-left: 3px solid var(--color-border-strong, rgba(0, 0, 0, 0.1));
  color: var(--color-text-secondary, #4b4c55);
}
.rag-assistant-text blockquote > *:first-child { margin-top: 0; }
.rag-assistant-text blockquote > *:last-child { margin-bottom: 0; }
/* 分隔线 */
.rag-assistant-text hr {
  border: none;
  border-top: 1px solid var(--color-border, rgba(0, 0, 0, 0.06));
  margin: 1.1em 0;
}
/* 表格 */
.rag-assistant-text table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.7em 0;
  font-size: 13px;
}
.rag-assistant-text th,
.rag-assistant-text td {
  padding: 6px 10px;
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.06));
  text-align: left;
}
.rag-assistant-text th {
  background: var(--color-bg-input, #f4f5f8);
  font-weight: 600;
}
.rag-assistant-text img { max-width: 100%; border-radius: var(--radius-sm, 8px); }

/* highlight.js token 配色（浅色，协调 widget 中性色调）*/
.rag-assistant-text .hljs-comment,
.rag-assistant-text .hljs-quote { color: var(--color-text-faint, #9ea0ab); font-style: italic; }
.rag-assistant-text .hljs-keyword,
.rag-assistant-text .hljs-selector-tag,
.rag-assistant-text .hljs-built_in,
.rag-assistant-text .hljs-name,
.rag-assistant-text .hljs-tag { color: #6f55d6; }
.rag-assistant-text .hljs-string,
.rag-assistant-text .hljs-title,
.rag-assistant-text .hljs-section,
.rag-assistant-text .hljs-attribute,
.rag-assistant-text .hljs-literal,
.rag-assistant-text .hljs-template-tag,
.rag-assistant-text .hljs-template-variable,
.rag-assistant-text .hljs-type,
.rag-assistant-text .hljs-addition { color: #16a34a; }
.rag-assistant-text .hljs-number,
.rag-assistant-text .hljs-symbol,
.rag-assistant-text .hljs-bullet,
.rag-assistant-text .hljs-meta { color: #d97706; }
.rag-assistant-text .hljs-attr,
.rag-assistant-text .hljs-variable,
.rag-assistant-text .hljs-link { color: #2563eb; }
.rag-assistant-text .hljs-deletion { color: var(--color-error, #e05252); }

/* ── 工具调用折叠（N 个工具调用）── */
/* section：toggle + 列表成一个视觉组（组内紧凑），与正文（结论）由 assistant gap 拉开。*/
.rag-exec-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rag-exec-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12.5px;
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
/* 工具调用列表内的节点字号比正文小一档（辅助信息）*/
.rag-exec-list .rag-exec-node,
.rag-exec-list .rag-exec-name,
.rag-exec-list .rag-exec-intent-text { font-size: 11.5px; }
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
.rag-exec-node:hover .rag-exec-icon,
.rag-exec-node:hover .rag-exec-intent-text { color: var(--color-text-primary, #1a1b1e); }
.rag-exec-node:hover .rag-exec-status { color: var(--color-text-secondary, #4b4c55); }
/* 失败/运行：hover 下保持状态色（优先级高于通用 hover，避免被加深盖掉）*/
.st-failed.rag-exec-node:hover .rag-exec-name,
.st-failed.rag-exec-node:hover .rag-exec-icon,
.st-failed.rag-exec-node:hover .rag-exec-status { color: var(--color-error, #e05252); }
.st-interrupted.rag-exec-node:hover .rag-exec-name,
.st-interrupted.rag-exec-node:hover .rag-exec-icon,
.st-interrupted.rag-exec-node:hover .rag-exec-status { color: var(--color-text-muted, #6e7280); }
.st-running.rag-exec-node:hover .rag-exec-name,
.st-running.rag-exec-node:hover .rag-exec-icon { color: var(--color-running, #3b82f6); }
/* 状态分层着色：名/图标/摘要随状态变化 */
.st-running .rag-exec-name,
.st-running .rag-exec-icon { color: var(--color-running, #3b82f6); }
.st-failed .rag-exec-name,
.st-failed .rag-exec-icon,
.st-failed .rag-exec-status { color: var(--color-error, #e05252); }
.st-failed .rag-exec-status { opacity: 0.9; }
.st-interrupted .rag-exec-name,
.st-interrupted .rag-exec-icon,
.st-interrupted .rag-exec-status { color: var(--color-text-muted, #6e7280); }
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

/* 审批 / 用户输入：悬浮卡片，绝对定位浮于输入栏上方，不占消息列表 */
.rag-interaction-overlay {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 76px; /* 输入栏（footer）高度 + 间隙 */
  z-index: 8;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.rag-interaction-overlay > * { pointer-events: auto; }

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
.rag-input-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 0 8px;
}
.rag-input-tool {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-pill, 14px);
  background: var(--color-bg-input, #f4f5f8);
  color: var(--color-text-secondary, #4b4c55);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.rag-input-tool:hover {
  background: var(--color-bg-hover, #ebedf2);
  color: var(--color-text-primary, #1a1b1e);
}
.rag-input-tool-icon { display: inline-flex; align-items: center; font-size: 14px; line-height: 1; }
.rag-input-tool-icon svg { width: 14px; height: 14px; display: block; }
.rag-input-tool-text { font-size: 12px; white-space: nowrap; }

/* ── 已选内容 chip（坐标等整体单元）── */
.rag-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 100%;
}
.rag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 4px 0 8px;
  border-radius: var(--radius-pill, 14px);
  background: var(--color-accent-soft, rgba(75, 76, 85, 0.08));
  color: var(--color-text-secondary, #4b4c55);
  font-size: 12px;
  line-height: 1;
  vertical-align: middle;
}
.rag-chip-icon { display: inline-flex; align-items: center; }
.rag-chip-icon svg { width: 12px; height: 12px; display: block; }
.rag-chip-close {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-faint, #9ea0ab);
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rag-chip-close svg { width: 11px; height: 11px; display: block; }
.rag-chip-close:hover {
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.08));
  color: var(--color-text-primary, #1a1b1e);
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
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  min-height: 28px;
  max-height: 160px;
  overflow-y: auto;
  background: transparent;
  border: none;
  color: var(--color-text-primary, #1a1b1e);
  padding: 4px 0;
  font-size: 13.5px;
  font-family: inherit;
  outline: none;
  line-height: 20px;
  word-break: break-word;
  white-space: pre-wrap;
}
.rag-input-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.rag-input-ph {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  color: var(--color-text-placeholder, #b0b3be);
  pointer-events: none;
}
.rag-input[contenteditable="false"] { opacity: 0.6; }

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
