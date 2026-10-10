<template>
  <!-- 缝即分隔条：与对话卡之间不留 gap，这条 6px 的带子既是留白也是拖拽区。 -->
  <div
    v-if="workbenchOpen"
    class="run-workbench-resize"
    :class="{ 'is-dragging': resizing }"
    role="separator"
    aria-orientation="vertical"
    aria-label="调整运行工作台宽度"
    @pointerdown="startResize"
  />

  <aside
    class="run-workbench"
    :class="{ 'is-open': workbenchOpen, 'is-resizing': resizing }"
    :style="{ '--workbench-width': `${width}px` }"
    :aria-hidden="workbenchOpen ? undefined : 'true'"
    aria-label="运行工作台"
  >
    <div class="run-workbench__card">
      <header class="run-workbench__head">
        <div class="rw-tabs" role="tablist" aria-label="运行工作台页签">
          <button
            type="button"
            role="tab"
            class="rw-tab"
            :class="{ 'is-active': isOverviewTab }"
            :aria-selected="isOverviewTab ? 'true' : 'false'"
            @click="selectTab(WORKBENCH_OVERVIEW_TAB)"
          >
            <Activity class="rw-tab__icon" aria-hidden="true" />
            <span class="rw-tab__name">运行概览</span>
          </button>

          <button
            v-for="tabId in workbenchTabs"
            :key="tabId"
            type="button"
            role="tab"
            class="rw-tab"
            :class="{ 'is-active': tabId === workbenchTab }"
            :style="{ '--participant-accent': accentOf(tabId) }"
            :title="tabTitleOf(tabId)"
            :aria-selected="tabId === workbenchTab ? 'true' : 'false'"
            @click="selectTab(tabId)"
          >
            <FileText v-if="fileTabOf(tabId)" class="rw-tab__icon" aria-hidden="true" />
            <GitBranch v-else class="rw-tab__icon" aria-hidden="true" />
            <span class="rw-tab__name">{{ tabNameOf(tabId) }}</span>
            <span
              class="rw-tab__close"
              role="button"
              tabindex="-1"
              :aria-label="`关闭 ${tabNameOf(tabId)} 页签`"
              @click.stop="closeWorkbenchTab(tabId)"
            >
              <X aria-hidden="true" />
            </span>
          </button>
        </div>

        <button
          type="button"
          class="rw-collapse"
          title="收起运行工作台"
          aria-label="收起运行工作台"
          @click="closeWorkbench"
        >
          <PanelRightClose aria-hidden="true" />
        </button>
      </header>

      <div class="run-workbench__body">
        <!-- 概览页签：智能体清单（点谁就把谁的线程开成页签）+ 目标/后台任务 -->
        <div v-if="isOverviewTab" class="rw-overview">
          <section class="rw-agents" aria-label="智能体">
            <header class="rw-section-head">
              <span class="rw-section-label">智能体</span>
              <span class="rw-section-count">{{ orderedParticipants.length }}</span>
            </header>
            <ul v-if="orderedParticipants.length" class="rw-agents__list">
              <li v-for="participant in orderedParticipants" :key="participant.participant_id">
                <button
                  type="button"
                  class="rw-agent"
                  :class="{ 'is-selected': participant.participant_id === selectedParticipantId }"
                  :style="{ '--participant-accent': participantAccentColor(participant) }"
                  @click="emit('select-participant', participant.participant_id)"
                >
                  <span class="rw-agent__avatar" aria-hidden="true">
                    <Bot v-if="participant.scope === 'root'" />
                    <GitBranch v-else />
                  </span>
                  <span class="rw-agent__main">
                    <span class="rw-agent__name">{{ participantName(participant) }}</span>
                    <span class="rw-agent__meta">{{ participantMeta(participant) }}</span>
                  </span>
                  <span class="rw-agent__status">
                    <span v-if="participantStatusText(participant)" class="rw-agent__status-text">
                      {{ participantStatusText(participant) }}
                    </span>
                    <span
                      class="rw-dot"
                      :class="{ 'is-live': isLiveParticipant(participant) }"
                      :style="{ '--dot-color': statusToneColor(participantStatus(participant)) }"
                      :title="statusLabel(participantStatus(participant))"
                    />
                  </span>
                </button>
              </li>
            </ul>
            <p v-else class="rw-agents__empty">暂无参与者</p>
          </section>

          <RuntimeOverviewPanel :task-state="taskState" :goal-state="goalState" />
        </div>

        <!-- 文件页签：项目文件查看器（左侧文件导航点开的文件）。 -->
        <div v-else-if="activeFileTab" class="rw-file">
          <WorkbenchFilePanel :file="activeFileTab" />
        </div>

        <!-- 子智能体页签：这条线程自己的消息与执行过程（主对话列始终是根会话）。
             身份与状态都交给上面的页签承载：页签名就是这条线程的名字，图标在异常态换色，
             正文区不再重复一行表头。 -->
        <div v-else class="rw-thread">
          <div ref="threadScrollRef" class="rw-thread__scroll" @scroll="handleScroll">
            <ChatMessageList :messages="threadMessages" :visible-messages="visibleMessages">
              <template #empty>
                <ParticipantThreadEmpty :participant="activeParticipant" />
              </template>
            </ChatMessageList>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { Activity, Bot, FileText, GitBranch, PanelRightClose, X } from 'lucide-vue-next';
import ChatMessageList from '../chat/ChatMessageList.vue';
import ParticipantThreadEmpty from '../chat/ParticipantThreadEmpty.vue';
import RuntimeOverviewPanel from './RuntimeOverviewPanel.vue';
import WorkbenchFilePanel from './WorkbenchFilePanel.vue';
import { useSessionRunStore, WORKBENCH_OVERVIEW_TAB } from '../../stores/session-run.js';
import { useChatScrolling } from '../../composables/useChatScrolling.js';
import { useMessageListView } from '../../composables/useMessageListView.js';
import { useToast } from '../../composables/useToast.js';
import {
  isLiveParticipant,
  orderParticipants,
  participantAccentColor,
  participantMeta,
  participantName,
  participantStatus,
  participantStatusText,
  statusLabel,
  statusToneColor,
} from '../../utils/participantVisual.js';

defineProps({
  taskState: { type: Object, required: true },
  goalState: { type: Object, required: true },
});

const emit = defineEmits(['select-participant']);

const sessionRunStore = useSessionRunStore();
const {
  participants,
  selectedParticipantId,
  workbenchOpen,
  workbenchTab,
  workbenchTabs,
  workbenchFiles,
  workbenchThreadMessages,
} = storeToRefs(sessionRunStore);
const { setWorkbenchTab, closeWorkbenchTab, closeWorkbench } = sessionRunStore;

const toast = useToast();

// 线程宽度记忆：与侧栏折叠态同一套本地偏好，跨刷新保留用户调过的宽度。
const WORKBENCH_WIDTH_KEY = 'runWorkbenchWidth';
const DEFAULT_WIDTH = 440;
const MIN_WIDTH = 360;
// 对话卡的最小可用宽度：工作台再怎么拉，也不能把主对话列压到不可读。
const CONVERSATION_MIN_WIDTH = 560;
const RESIZE_HANDLE_WIDTH = 6;

const isOverviewTab = computed(() => workbenchTab.value === WORKBENCH_OVERVIEW_TAB);
const orderedParticipants = computed(() => orderParticipants(participants.value));
const threadMessages = workbenchThreadMessages;

// 文件页签：页签 id 以 'file:' 前缀登记在 workbenchFiles（含 workspaceId/path/name）。
const fileTabOf = (tabId) => workbenchFiles.value[tabId] || null;
const activeFileTab = computed(() => fileTabOf(workbenchTab.value));

const activeParticipant = computed(() => participants.value.find(
  item => item?.participant_id === workbenchTab.value,
) || null);

const participantOf = (participantId) => participants.value.find(
  item => item?.participant_id === participantId,
) || null;
const nameOf = (participantId) => participantName(participantOf(participantId)) || '子智能体';
const tabNameOf = (tabId) => fileTabOf(tabId)?.name || nameOf(tabId);
// 页签图标染色：正常态用身份色（与概览列表、执行树 agent 行同色），异常态换成状态色——
// 面板里没有第二处地方能说明"这条线程挂了"，而页签永远可见。文件页签用品牌色。
const accentOf = (tabId) => {
  if (fileTabOf(tabId)) return 'var(--color-brand-accent)';
  const participant = participantOf(tabId);
  if (!participant) return 'var(--color-brand-accent)';
  return participantStatusText(participant)
    ? statusToneColor(participantStatus(participant))
    : participantAccentColor(participant);
};
const tabTitleOf = (tabId) => {
  const file = fileTabOf(tabId);
  if (file) return file.path;
  const participant = participantOf(tabId);
  if (!participant) return '子智能体';
  const status = participantStatusText(participant);
  return [participantName(participant), participantMeta(participant), status].filter(Boolean).join(' · ');
};

const selectTab = (tabId) => {
  const changed = setWorkbenchTab(tabId);
  // 切到一条还没拉过内容的线程时请上层取一次消息；已有内容就直接切，不重复请求。
  // 文件页签的内容由面板自取，不经这条消息通路。
  if (changed && tabId !== WORKBENCH_OVERVIEW_TAB && !fileTabOf(tabId) && !threadMessages.value.length) {
    emit('select-participant', tabId);
  }
};

// 线程自己的视图：压缩横线只属于根会话，这里始终按子视图过滤。
const { visibleMessages } = useMessageListView({
  messages: threadMessages,
  showToast: (message, type) => toast.show(message, type),
  isRootView: computed(() => false),
});

// 线程自己的滚动容器：吸附/未读/回到底部都由这一份状态机驱动，与主对话列互不影响。
const threadTopScrolled = ref(false);
const {
  messagesRef: threadScrollRef,
  handleScroll,
  stickToBottom,
} = useChatScrolling({ messages: threadMessages, topControlsBarScrolled: threadTopScrolled });

// 换页签或刚展开面板：线程从底部开始看（跟新到的内容，而不是停在旧位置的顶部）。
// 文件页签没有线程滚动容器，跳过。
watch([workbenchTab, workbenchOpen], async () => {
  if (!workbenchOpen.value || activeFileTab.value) return;
  await nextTick();
  stickToBottom();
});

// ── 宽度拖拽 ───────────────────────────────────────────────
const width = ref(readStoredWidth());
const resizing = ref(false);
let dragState = null;

function readStoredWidth() {
  try {
    const stored = Number(localStorage.getItem(WORKBENCH_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampWidth(stored);
  } catch {
    // 存储不可用时用默认宽度。
  }
  return DEFAULT_WIDTH;
}

function maxWidth() {
  const host = document.querySelector('.chat-main');
  const hostWidth = host?.clientWidth || window.innerWidth;
  return Math.max(MIN_WIDTH, hostWidth - RESIZE_HANDLE_WIDTH - CONVERSATION_MIN_WIDTH);
}

function clampWidth(value) {
  return Math.min(Math.max(Math.round(value), MIN_WIDTH), maxWidth());
}

function startResize(event) {
  if (event.button !== 0) return;
  dragState = { startX: event.clientX, startWidth: width.value };
  resizing.value = true;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', endResize);
  window.addEventListener('pointercancel', endResize);
}

function onResizeMove(event) {
  if (!dragState) return;
  // 拖拽把手在卡片左沿：向左拖是变宽。
  width.value = clampWidth(dragState.startWidth - (event.clientX - dragState.startX));
}

function endResize() {
  if (!dragState) return;
  dragState = null;
  resizing.value = false;
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', endResize);
  window.removeEventListener('pointercancel', endResize);
  try {
    localStorage.setItem(WORKBENCH_WIDTH_KEY, String(width.value));
  } catch {
    // 存储不可用：宽度只在本次会话内有效。
  }
}

// 窗口变窄时把宽度收回到可用范围内，避免对话卡被挤没。
const onWindowResize = () => { width.value = clampWidth(width.value); };

onMounted(() => window.addEventListener('resize', onWindowResize));
onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize);
  endResize();
});
</script>

<style scoped>
/* ===== 分隔条：缝的宽度就是它，与外壳内边距同源 ===== */
.run-workbench-resize {
  display: flex;
  width: var(--shell-gap, 4px);
  flex: 0 0 var(--shell-gap, 4px);
  align-items: stretch;
  justify-content: center;
  cursor: col-resize;
  touch-action: none;
}

/* 悬停只是"这里可以拖"的提示，取边框的亮一档色就够；拖拽中才略微提亮。
   不用品牌强调色——缝一直在鼠标路径上，亮蓝线在卡片之间过于抢眼。 */
.run-workbench-resize::after {
  content: '';
  width: 2px;
  border-radius: var(--radius-full);
  background: transparent;
  transition: background var(--duration-fast) var(--ease-default);
}

.run-workbench-resize:hover::after {
  background: var(--color-border-hover);
}

.run-workbench-resize.is-dragging::after {
  background: var(--color-text-muted);
}

/* ===== 卡片：外层只管宽度动画，内层才是看得见的那张卡（收起时被外层裁掉） ===== */
.run-workbench {
  display: flex;
  width: var(--workbench-width, 440px);
  min-width: 0;
  flex: 0 0 auto;
  overflow: hidden;
  transition: width var(--duration-base) var(--ease-out-expo);
}

.run-workbench:not(.is-open) {
  width: 0;
}

.run-workbench.is-resizing {
  transition: none;
}

.run-workbench__card {
  position: relative;
  z-index: 1;
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-2xl);
  background: var(--surface-shell);
}

.run-workbench__head {
  display: flex;
  min-height: 44px;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  /* 右侧并入桌面端自绘窗口控件组宽度（--window-controls-width），
     收起按钮落在最小化/最大化/关闭左侧不被覆盖；浏览器回退为 6px */
  padding: 0 calc(6px + var(--window-controls-width, 0px)) 0 10px;
  border-bottom: 1px solid var(--color-border);
}

.rw-tabs {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}

.rw-tabs::-webkit-scrollbar {
  display: none;
}

.rw-tab {
  display: inline-flex;
  min-width: 0;
  max-width: 172px;
  height: 28px;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 550;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.rw-tab:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.rw-tab.is-active {
  background: var(--color-active-bg);
  color: var(--color-text-primary);
  font-weight: 650;
}

.rw-tab__icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--participant-accent, var(--color-text-muted));
}

.rw-tab__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rw-tab__close {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.rw-tab__close:hover {
  background: var(--color-hover-overlay-lg);
  color: var(--color-text-primary);
}

.rw-tab__close svg {
  width: 12px;
  height: 12px;
}

.rw-collapse {
  display: inline-flex;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.rw-collapse:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.rw-collapse svg {
  width: 16px;
  height: 16px;
}

.run-workbench__body {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

/* ===== 概览：智能体清单 + 目标/后台任务 ===== */
.rw-overview {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow-y: auto;
}

.rw-agents {
  display: flex;
  flex-direction: column;
  padding: 12px 8px 4px;
}

.rw-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 6px 8px;
}

.rw-section-label {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 650;
  letter-spacing: 0.06em;
}

.rw-section-count {
  min-width: 20px;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--color-hover-overlay-md);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 650;
  line-height: 1.5;
  text-align: center;
}

.rw-agents__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}

.rw-agent {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

.rw-agent:hover {
  background: var(--color-hover-overlay-md);
}

.rw-agent.is-selected {
  background: color-mix(in srgb, var(--participant-accent) 11%, transparent);
}

.rw-agent__avatar {
  display: inline-flex;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--participant-accent) 14%, transparent);
  color: var(--participant-accent, var(--color-text-muted));
}

.rw-agent__avatar svg {
  width: 13px;
  height: 13px;
}

.rw-agent__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}

.rw-agent__name {
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: 550;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rw-agent__meta {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rw-agent__status {
  display: inline-flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.rw-agent__status-text {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1;
}

.rw-agents__empty {
  padding: 4px 6px 12px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.rw-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: var(--dot-color, var(--color-text-muted));
}

.rw-dot.is-live {
  animation: rw-dot-pulse 1.6s var(--ease-default) infinite;
}

/* ===== 子智能体线程 ===== */
.rw-thread {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.rw-file {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.rw-thread__scroll {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* 线程比主对话列窄：内边距收一档，正文不贴边也不至于被挤成窄条。 */
.rw-thread__scroll :deep(.chat-messages) {
  padding: var(--spacing-md) var(--spacing-md) var(--spacing-lg);
}

@keyframes rw-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dot-color, var(--color-text-muted)) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px transparent; }
}

/* 窄屏：工作台退化为右侧抽屉，不参与三列布局（分隔条同时收起）。 */
@media (max-width: 900px) {
  .run-workbench-resize {
    display: none;
  }

  .run-workbench {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: var(--z-sidebar);
    width: min(100vw - 32px, 420px);
    box-shadow: var(--shadow-elevated);
  }

  .run-workbench:not(.is-open) {
    width: 0;
  }

  .run-workbench__card {
    border-top: none;
    border-right: none;
    border-bottom: none;
    border-radius: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .run-workbench {
    transition-duration: 1ms;
  }

  .rw-dot.is-live {
    animation: none;
  }
}
</style>
