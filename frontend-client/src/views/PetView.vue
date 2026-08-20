<template>
  <main class="pet-view">
    <PetSurface
      v-if="ready && available"
      :available="available"
      :mood="mood"
      :pulse="pulse"
      :hint="hint"
      :notice="notice"
      :display="displayId"
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
import { useRoute } from 'vue-router';

import PetSurface from '../components/pet/PetSurface.vue';

const STATE_POLL_MS = 4000;
const NOTICE_MS = 5000;

/**
 * 桌宠专用页面（Electron 宠物窗口加载 /pet；浏览器打开时为透明空页）。
 * - 页面背景透明；manifest 自门控（插件未启用/素材未安装时不渲染）
 * - SSE 订阅 /api/pet/events 驱动 mood（busy）、一次性脉冲（error/done）、工具提示（hint）
 * - run 终态/快速对话回执时宠物头顶冒状态气泡（只报状态，不展示内容；
 *   气泡挂在 PetSurface 根元素内，拖拽/漫游时自动跟随）
 * - 双击宠物弹快速输入框：文本经 IPC 送主窗口聊天输入框（桌面端）
 * - Electron 下按命中检测切换“点击穿透”（宠物/输入框区域内可交互）
 */
const route = useRoute();
const available = ref(null);
const ready = ref(false);
const mood = ref('idle');
const pulse = ref(null);
const hint = ref(null);
const notice = ref(null);
const quickAsk = ref(false);
const quickAskPos = ref({ x: 0, y: 0 });
const quickText = ref('');
const quickInputRef = ref(null);

const displayId = computed(() => String(route.query.display ?? '0'));

let cleanupClickThrough = null;
let eventSource = null;
let stateTimer = null;
let noticeTimer = null;
let seenErrorAt = null;
let seenCompletedAt = null;
let statePrimed = false;
const restoredStyles = [];

const showNotice = (kind, text) => {
  notice.value = { kind, text };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
  }, NOTICE_MS);
};

const applyState = (state) => {
  if (!state || typeof state !== 'object') return;
  mood.value = state.activeRuns > 0 ? 'busy' : 'idle';
  hint.value = state.busyHint ?? null;
  // 首帧只建立基线，不触发历史 error/done 的脉冲
  if (!statePrimed) {
    statePrimed = true;
    seenErrorAt = state.lastErrorAt ?? null;
    seenCompletedAt = state.lastCompletedAt ?? null;
    return;
  }
  if (state.lastErrorAt && state.lastErrorAt !== seenErrorAt) {
    seenErrorAt = state.lastErrorAt;
    pulse.value = { kind: 'error', at: state.lastErrorAt };
    showNotice('error', '任务出错');
  } else if (state.lastCompletedAt && state.lastCompletedAt !== seenCompletedAt) {
    seenCompletedAt = state.lastCompletedAt;
    pulse.value = { kind: 'done', at: state.lastCompletedAt };
    showNotice('done', '任务完成');
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

const quickStyle = computed(() => ({
  left: `${Math.min(Math.max(quickAskPos.value.x - 160, 12), window.innerWidth - 340)}px`,
  top: `${Math.max(quickAskPos.value.y - 64, 12)}px`,
}));

const submitQuickAsk = async () => {
  const text = quickText.value.trim();
  if (!text) return;
  const desktop = window.ragsystemDesktop;
  if (!desktop?.quickAsk) {
    closeQuickAsk();
    showNotice('info', '仅桌面端可用');
    return;
  }
  const sent = await desktop.quickAsk(text);
  closeQuickAsk();
  showNotice(sent ? 'done' : 'error', sent ? '已发送' : '发送失败');
};

const setupClickThrough = () => {
  const desktop = window.ragsystemDesktop;
  if (!desktop?.setPetClickThrough) return; // 浏览器环境无此能力
  let interactive = false;
  const apply = (value) => {
    if (value === interactive) return;
    interactive = value;
    desktop.setPetClickThrough(value);
  };
  const onMouseMove = (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    apply(Boolean(element?.closest?.('.pet-hit, .pet-quick')));
  };
  const onMouseLeave = () => apply(false);
  document.addEventListener('mousemove', onMouseMove);
  document.documentElement.addEventListener('mouseleave', onMouseLeave);
  apply(false); // 初始整体穿透，命中宠物/输入框后再恢复交互
  cleanupClickThrough = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.documentElement.removeEventListener('mouseleave', onMouseLeave);
  };
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
  setupClickThrough();
  void loadCatalog();
  startEvents();
});

onBeforeUnmount(() => {
  cleanupClickThrough?.();
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
