<template>
  <main class="pet-view">
    <PetSurface
      v-if="ready && available"
      :available="available"
      :notice="notice"
      :display="displayId"
      :display-rect="displayRect"
      :quick-ask-open="Boolean(quickAsk)"
      :size="stageSize"
      :initial-anim="settings.defaultAnimation"
      @quick-ask="openQuickAsk"
    />
    <div v-if="quickAsk" class="pet-quick" :style="quickStyle">
      <input
        ref="quickInputRef"
        v-model="quickText"
        type="text"
        placeholder="问点什么…（回车发送到主窗口聊天）"
        @keydown.enter.prevent="submitQuickAsk"
        @keydown.esc="closeQuickAsk"
      />
      <button type="button" title="发送" @click="submitQuickAsk">➤</button>
    </div>
  </main>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import PetSurface from './PetSurface.vue';

const STATE_POLL_MS = 4000;
const NOTICE_MS = 5000;
const BASE_STAGE_SIZE = 462;
const DEFAULT_SETTINGS = { default_animation: 'idle', scale: 1, notice_enabled: true };
/** 系统通知正文截断长度（对齐 dsh-pet 上游 MAX_BODY）。 */
const NOTIFY_BODY_LIMIT = 80;

/**
 * 桌宠 view（插件 bundle 版，由宿主 PluginViewHost 挂载）。
 * - 页面背景透明；manifest 自门控（插件未启用/素材未安装时不渲染）
 * - 场景配置经 GET /api/pet/settings 读取（缩放/默认动画/状态气泡）；
 *   独立宠物窗无登录态（401）或读取失败时回退默认值
 * - SSE 订阅 /api/pet/events 驱动 mood（busy）、一次性脉冲（error/done）、工具提示（hint）
 * - 双击宠物弹快速输入框：文本经 IPC 送主窗口聊天输入框（桌面端）
 * - Electron 下按命中检测切换"点击穿透"（宠物/输入框区域内可交互）
 */
const props = defineProps({
  /** 宿主注入的插件上下文（plugin-ui-sdk 契约）；独立窗打开时由 entry 兜底构造 */
  pluginHost: { type: Object, default: null },
});

const available = ref(null);
const ready = ref(false);
const notice = ref(null);
const settings = ref(DEFAULT_SETTINGS);
const quickAsk = ref(false);
const quickAskPos = ref({ x: 0, y: 0 });
const quickText = ref('');
const quickInputRef = ref(null);

// 独立宠物窗不经宿主路由：display 从地址栏读（多显示器每窗一个）。
// standalone=1 + dx/dy/dw/dh（主进程注入的显示器工作区）标示独立小窗模式：
// PetSurface 据此切换为"虚拟显示器坐标 + 窗口跟随"定位；宿主页内嵌时全部缺省。
const searchParams = new URLSearchParams(window.location.search);
const displayId = searchParams.get('display') ?? '0';
const displayRect = (() => {
  if (searchParams.get('standalone') !== '1') return null;
  const rect = {
    x: Number(searchParams.get('dx')),
    y: Number(searchParams.get('dy')),
    w: Number(searchParams.get('dw')),
    h: Number(searchParams.get('dh')),
  };
  return [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ? rect : null;
})();
const stageSize = computed(() => Math.round(BASE_STAGE_SIZE * clampScale(settings.value.scale)));

let eventSource = null;
let stateTimer = null;
let noticeTimer = null;
let seenErrorAt = null;
let seenCompletedAt = null;
let seenInteractionId = null;
let statePrimed = false;
const restoredStyles = [];

function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 0.5), 2);
}

/** 通知正文截断（对齐上游 MAX_BODY）。 */
function truncate(text) {
  const t = String(text ?? '').trim();
  return t.length > NOTIFY_BODY_LIMIT ? `${t.slice(0, NOTIFY_BODY_LIMIT)}…` : t;
}

const showNotice = (kind, icon, text) => {
  notice.value = { kind, icon, text };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
  }, NOTICE_MS);
};

/**
 * 任务事件 → 系统桌面通知（经 IPC 由 Electron 主进程弹出，主窗口失焦时才弹）。
 * 宠物本体不承载任务提示（回归纯桌宠），仅 quick-ask 交互反馈用头顶气泡。
 */
const notifyDesktop = (title, body = '') => {
  if (settings.value.notice_enabled === false) return;
  window.ragsystemDesktop?.notify?.(title, truncate(body));
};

const applyState = (state) => {
  if (!state || typeof state !== 'object') return;
  // 首帧只建立基线，不触发历史 error/done/交互的通知
  if (!statePrimed) {
    statePrimed = true;
    seenErrorAt = state.lastErrorAt ?? null;
    seenCompletedAt = state.lastCompletedAt ?? null;
    seenInteractionId = state.lastInteraction?.id ?? null;
    return;
  }
  if (state.lastErrorAt && state.lastErrorAt !== seenErrorAt) {
    seenErrorAt = state.lastErrorAt;
    notifyDesktop('生成失败', state.lastSummary ?? '');
  } else if (state.lastCompletedAt && state.lastCompletedAt !== seenCompletedAt) {
    seenCompletedAt = state.lastCompletedAt;
    notifyDesktop('对话完成');
  }
  const interaction = state.lastInteraction;
  if (interaction && interaction.id !== seenInteractionId) {
    seenInteractionId = interaction.id;
    if (interaction.kind === 'approval') {
      notifyDesktop('正在申请权限', [interaction.tool ? `工具「${interaction.tool}」` : '', interaction.reason ?? ''].filter(Boolean).join('：'));
    } else {
      notifyDesktop('模型在等你回答', interaction.prompt ?? '');
    }
  }
};

// SSE 优先（短 run 也不漏拍）；连接被服务端关闭时降级为轮询
const startEvents = () => {
  if (typeof EventSource === 'undefined') {
    startPolling();
    return;
  }
  eventSource = new EventSource('/api/pet/events');
  eventSource.onmessage = (event) => {
    try {
      applyState(JSON.parse(event.data));
    } catch {
      // 坏帧忽略，等下一帧
    }
  };
  eventSource.onerror = () => {
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      eventSource.close();
      eventSource = null;
      startPolling();
    }
  };
};

const pollState = async () => {
  try {
    const response = await fetch('/api/pet/state');
    if (!response.ok) return;
    applyState(await response.json());
  } catch {
    // 轮询失败保持上次状态
  }
};

function startPolling() {
  void pollState();
  if (stateTimer === null) stateTimer = setInterval(() => void pollState(), STATE_POLL_MS);
}

// ---- 场景配置：主应用内经宿主 API（带登录态）；独立窗直连（401 → 默认值） ----
const loadSettings = async () => {
  try {
    let data;
    if (props.pluginHost?.api) {
      data = await props.pluginHost.api.get('/api/pet/settings');
    } else {
      const response = await fetch('/api/pet/settings');
      if (!response.ok) return; // 无登录态/插件未启用：保持默认
      data = await response.json();
    }
    if (data && typeof data === 'object') {
      settings.value = {
        default_animation: typeof data.default_animation === 'string' ? data.default_animation : 'idle',
        scale: clampScale(data.scale),
        notice_enabled: data.notice_enabled !== false,
      };
    }
  } catch {
    // 配置读取失败：默认值
  }
};

// ---- 快速对话：双击宠物 → 输入框 → IPC 送主窗口聊天 ----
const openQuickAsk = async (position) => {
  const x = position?.x ?? window.innerWidth / 2;
  const y = position?.y ?? window.innerHeight / 2;
  quickAskPos.value = { x, y };
  quickAsk.value = true;
  quickText.value = '';
  window.ragsystemDesktop?.setPetFocus?.(true); // 宠物窗口默认不抢焦点，输入前临时可聚焦
  await nextTick();
  quickInputRef.value?.focus();
};

const closeQuickAsk = () => {
  quickAsk.value = false;
  quickText.value = '';
  window.ragsystemDesktop?.setPetFocus?.(false);
};

// 输入框定位在窗口坐标系内：quick-ask 打开时窗口已向左上扩展（PetSurface 的
// quickAskOpen 预留），340px 宽的输入框始终有落位
const quickStyle = computed(() => ({
  left: `${Math.min(Math.max(quickAskPos.value.x - 160, 12), Math.max(window.innerWidth - 352, 12))}px`,
  top: `${Math.max(quickAskPos.value.y - 64, 8)}px`,
}));

const submitQuickAsk = async () => {
  const text = quickText.value.trim();
  if (!text) return;
  const desktop = window.ragsystemDesktop;
  if (!desktop?.quickAsk) {
    closeQuickAsk();
    showNotice('error', 'error', '仅桌面端可用');
    return;
  }
  const sent = await desktop.quickAsk(text);
  closeQuickAsk();
  showNotice(sent ? 'done' : 'error', sent ? 'done' : 'error', sent ? '已发送' : '发送失败');
};

const loadCatalog = async () => {
  try {
    const response = await fetch('/api/pet/manifest');
    if (!response.ok) return; // 插件未启用：保持空白
    const data = await response.json();
    if (Array.isArray(data?.animations) && data.animations.length > 0) available.value = data.animations;
  } catch {
    // 后端不可达：不渲染
  } finally {
    ready.value = true;
  }
};

onMounted(() => {
  for (const element of [document.documentElement, document.body]) {
    restoredStyles.push([element, element.style.background]);
    element.style.background = 'transparent';
  }
  document.body.classList.add('pet-page');
  void loadCatalog();
  void loadSettings();
  startEvents();
});

onBeforeUnmount(() => {
  eventSource?.close();
  clearTimeout(noticeTimer);
  if (stateTimer !== null) clearInterval(stateTimer);
  document.body.classList.remove('pet-page');
  for (const [element, background] of restoredStyles) element.style.background = background;
});
</script>

<style scoped>
.pet-view {
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: transparent;
}

.pet-quick {
  position: fixed;
  display: flex;
  gap: 6px;
  padding: 6px;
  border-radius: 10px;
  background: rgba(30, 32, 38, 0.94);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  z-index: 61;
}

.pet-quick input {
  width: 250px;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #f2f4f8;
  font-size: 13px;
  outline: none;
}

.pet-quick input:focus {
  border-color: rgba(120, 180, 255, 0.65);
}

.pet-quick button {
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: rgba(90, 140, 235, 0.9);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
</style>

<style>
/* 宠物页面需要完全透明：压掉全局环境光背景（body::before 光晕） */
body.pet-page::before {
  display: none;
}
</style>
