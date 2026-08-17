<template>
  <div class="bottom-dock" :class="{ 'bottom-dock--launching': newChatLaunching && hasMessages }">
    <Transition name="image-recognition-fade">
      <div v-if="imageRecognitionPending" class="image-recognition-hint" role="status">
        <span class="image-recognition-spinner" aria-hidden="true"></span>
        正在识别图片…<template v-if="imageRecognitionProgress">（{{ imageRecognitionProgress.done }}/{{ imageRecognitionProgress.total }}）</template>
      </div>
    </Transition>
    <div
      class="input-area-wrapper"
      :class="{ 'input-area-wrapper--new-chat': !hasMessages }"
    >
      <ChatInput
        ref="chatInputRef"
        :model-value="modelValue"
        :attachments="attachments"
        :session-id="sessionId"
        :can-send="canSend"
        :can-stop="canStop"
        :can-resume="canResume"
        :can-attach="canAttach"
        @update:model-value="emit('update:modelValue', $event)"
        @send="emit('send', $event)"
        @stop="emit('stop')"
        @resume="emit('resume')"
        @openAttachments="emit('openAttachments')"
        @removeAttachment="emit('removeAttachment', $event)"
        @pasteFiles="emit('pasteFiles', $event)"
      >
        <template v-if="!hasMessages" #context>
          <TaskLauncher
            :team="team"
            :team-options="teamOptions"
            :team-loading="teamLoading"
            :entry-agent="entryAgent"
            :workspace-root="workspaceRoot"
            :entry-agent-options="entryAgentOptions"
            :entry-agent-loading="entryAgentLoading"
            @update:team="emit('update:team', $event)"
            @update:entry-agent="emit('update:entryAgent', $event)"
            @update:workspace-root="emit('update:workspaceRoot', $event)"
          />
        </template>
        <template #footerMeta>
          <div class="composer-run-controls" role="group" aria-label="本次发送设置">
            <LLMSelector presentation="composer" />
            <ThinkingLevelSelector />
            <PermissionModeSelector :session-id="sessionId" :chat-sdk-client="chatSdkClient" />
          </div>
        </template>
        <template #rightActions>
          <Popover v-model:open="contextPopoverOpen">
            <!-- 用 Anchor 而非 Trigger：Trigger 的点击 toggle 不查 defaultPrevented，
                 会与"点击打开抽屉"叠加出悬挂弹层；open 完全交给 hover 控制。 -->
            <PopoverAnchor as-child>
              <div
                v-if="contextUsage && contextUsage.max > 0"
                class="context-usage-content"
                @click="emit('openContextDrawer')"
                title="点击查看上下文详情"
                @mouseenter="openContextPopover()"
                @mouseleave="scheduleContextPopoverClose()"
              >
                <svg width="16" height="16" viewBox="0 0 22 22" class="ctx-ring-master" :title="`上下文: ${formatTokenCount(contextUsage.used)} / ${formatTokenCount(contextUsage.max)} tokens`">
                  <circle cx="11" cy="11" r="9" fill="none" :stroke="'var(--ctx-ring-track)'" stroke-width="2.5" />
                  <circle
                    cx="11"
                    cy="11"
                    r="9"
                    fill="none"
                    :stroke="contextUsageClass === 'danger' ? 'var(--ctx-ring-danger)' : contextUsageClass === 'warning' ? 'var(--ctx-ring-warning)' : 'var(--ctx-ring-success)'"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    :stroke-dasharray="`${contextUsagePct * 0.5655} 56.55`"
                    stroke-dashoffset="0"
                    :style="{ transform: 'rotate(90deg) scaleX(-1)', transformOrigin: '50% 50%' }"
                  />
                </svg>
                <span class="context-usage-label">{{ formatTokenCount(contextUsage.used) }} / {{ formatTokenCount(contextUsage.max) }} tokens</span>
                <span v-if="isCompressing" class="compressing-indicator">
                  <span class="compressing-dot"></span>
                  压缩中
                </span>
              </div>
            </PopoverAnchor>
            <PopoverContent
              side="top"
              align="end"
              :side-offset="6"
              class="context-usage-popover"
              @mouseenter="cancelContextPopoverClose()"
              @mouseleave="scheduleContextPopoverClose()"
            >
              <div class="context-usage-popover-inner">
                <template v-if="contextCacheHit !== null || contextCacheDetail">
                  <div v-if="contextCacheHit !== null" class="cu-popover-cache">
                    <span class="cu-popover-cache-label">缓存命中</span>
                    <span class="cu-popover-cache-rate">{{ contextCacheHit }}%</span>
                  </div>
                  <div v-if="contextCacheDetail" class="cu-popover-cache-detail">{{ contextCacheDetail }}</div>
                </template>
                <template v-if="contextComposition.length">
                  <div class="cu-popover-composition-title">上下文构成 · 共 {{ formatTokenCount(contextUsage.used) }} tokens</div>
                  <div class="cu-popover-bar">
                    <div
                      v-for="item in contextComposition"
                      :key="item.key"
                      class="cu-popover-bar-seg"
                      :class="`cu-popover-bar-seg--${item.key}`"
                      :style="{ width: `${compositionPct(item)}%` }"
                    ></div>
                  </div>
                  <ul class="cu-popover-legend">
                    <li v-for="item in contextComposition" :key="item.key" class="cu-popover-legend-item">
                      <span class="cu-popover-legend-dot" :class="`cu-popover-legend-dot--${item.key}`"></span>
                      <span class="cu-popover-legend-label">{{ item.label }}</span>
                      <span class="cu-popover-legend-tokens">{{ compositionPct(item) }}%</span>
                    </li>
                  </ul>
                </template>
                <div v-if="contextCacheHit === null && !contextCacheDetail && !contextComposition.length" class="cu-popover-empty">
                  暂无上下文用量明细
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </template>
      </ChatInput>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref } from 'vue';
import ChatInput from '../ChatInput.vue';
import LLMSelector from '../LLMSelector.vue';
import ThinkingLevelSelector from '../ThinkingLevelSelector.vue';
import PermissionModeSelector from '../PermissionModeSelector.vue';
import TaskLauncher from './TaskLauncher.vue';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover/index';
import { formatTokenCount } from '../../utils/format.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
  attachments: { type: Array, default: () => [] },
  canSend: { type: Boolean, default: false },
  canStop: { type: Boolean, default: false },
  canResume: { type: Boolean, default: false },
  canAttach: { type: Boolean, default: false },
  hasMessages: { type: Boolean, default: false },
  newChatLaunching: { type: Boolean, default: false },
  imageRecognitionPending: { type: Boolean, default: false },
  // 多图识别进度（{ done, total }，仅进行中且总数 >1 时传入）。
  imageRecognitionProgress: { type: Object, default: null },
  sessionId: { type: String, default: '' },
  chatSdkClient: { type: Object, default: null },
  contextUsage: { type: Object, default: null },
  contextUsagePct: { type: Number, default: 0 },
  contextUsageClass: { type: String, default: '' },
  isCompressing: { type: Boolean, default: false },
  team: { type: String, default: '' },
  teamOptions: { type: Array, default: () => [] },
  teamLoading: { type: Boolean, default: false },
  entryAgent: { type: String, default: '' },
  workspaceRoot: { type: String, default: '' },
  entryAgentOptions: { type: Array, default: () => [] },
  entryAgentLoading: { type: Boolean, default: false },
});

const emit = defineEmits([
  'update:modelValue',
  'send',
  'stop',
  'resume',
  'openAttachments',
  'removeAttachment',
  'pasteFiles',
  'update:team',
  'update:entryAgent',
  'update:workspaceRoot',
  'openContextDrawer',
]);

const chatInputRef = ref(null);

const focus = async () => {
  if (chatInputRef.value?.focus) await chatInputRef.value.focus();
};

defineExpose({ focus });

// ── 上下文用量 hover 明细 ──
const contextPopoverOpen = ref(false);
let contextPopoverCloseTimer = null;
const openContextPopover = () => {
  if (contextPopoverCloseTimer) {
    clearTimeout(contextPopoverCloseTimer);
    contextPopoverCloseTimer = null;
  }
  contextPopoverOpen.value = true;
};
// 延迟关闭：鼠标从 trigger 移向 popover 内容时留出过渡窗口。
const scheduleContextPopoverClose = () => {
  if (contextPopoverCloseTimer) clearTimeout(contextPopoverCloseTimer);
  contextPopoverCloseTimer = setTimeout(() => { contextPopoverOpen.value = false; }, 150);
};
const cancelContextPopoverClose = () => {
  if (contextPopoverCloseTimer) {
    clearTimeout(contextPopoverCloseTimer);
    contextPopoverCloseTimer = null;
  }
};
onUnmounted(() => {
  if (contextPopoverCloseTimer) clearTimeout(contextPopoverCloseTimer);
});

// 本 run 累计缓存命中率（provider 实测；命中率 >0 才显示，保留一位小数）。
const contextCacheHit = computed(() => {
  const cu = props.contextUsage;
  if (!cu?.cachedInputTokens || !cu?.inputTokens) return null;
  const rate = cu.cachedInputTokens / cu.inputTokens;
  return rate > 0 ? Number((rate * 100).toFixed(1)) : null;
});

// 缓存明细行：读取/写入任一 >0 即展示（首轮可能只有写入没有命中，写入量应独立可见）。
const contextCacheDetail = computed(() => {
  const cu = props.contextUsage;
  if (!cu) return '';
  const parts = [];
  if (cu.cachedInputTokens > 0) parts.push(`读取 ${formatTokenCount(cu.cachedInputTokens)} tokens`);
  if (cu.cacheCreationInputTokens > 0) parts.push(`写入 ${formatTokenCount(cu.cacheCreationInputTokens)} tokens`);
  return parts.join(' · ');
});

// 上下文构成占比（估算快照）：系统提示词 = system 消息 - 工具 schema；系统工具 = 其余工具。
const contextComposition = computed(() => {
  const cu = props.contextUsage;
  if (!cu) return [];
  const systemTokens = Math.max(0, (cu.systemPromptTokens || 0) - (cu.toolSchemaTokens || 0));
  const builtinToolTokens = Math.max(0, (cu.toolSchemaTokens || 0) - (cu.mcpToolTokens || 0) - (cu.skillToolTokens || 0));
  const items = [
    { key: 'history', label: '消息', tokens: cu.historyTokens || 0 },
    { key: 'system', label: '系统提示词', tokens: systemTokens },
    { key: 'tools', label: '系统工具', tokens: builtinToolTokens },
    ...(cu.skillToolTokens ? [{ key: 'skill', label: '技能', tokens: cu.skillToolTokens }] : []),
    ...(cu.mcpToolTokens ? [{ key: 'mcp', label: 'MCP', tokens: cu.mcpToolTokens }] : []),
  ];
  return items.filter((item) => item.tokens > 0);
});

const contextCompositionTotal = computed(() =>
  contextComposition.value.reduce((sum, item) => sum + item.tokens, 0));

const compositionPct = (item) => contextCompositionTotal.value > 0
  ? Math.round((item.tokens / contextCompositionTotal.value) * 100)
  : 0;
</script>

<style scoped>
.composer-run-controls {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  align-items: center;
  gap: 2px;
}

.image-recognition-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0 auto 8px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--color-border, #444);
  background: var(--color-bg-elevated, #222);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs, 12px);
}

.image-recognition-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--color-border-strong, #666);
  border-top-color: var(--color-brand-accent, #4f8cff);
  animation: image-recognition-spin 0.8s linear infinite;
}

@keyframes image-recognition-spin {
  to { transform: rotate(360deg); }
}

.image-recognition-fade-enter-active,
.image-recognition-fade-leave-active {
  transition: opacity 0.2s ease;
}
.image-recognition-fade-enter-from,
.image-recognition-fade-leave-to {
  opacity: 0;
}

.context-usage-content {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  cursor: pointer;
  padding: 4px;
  margin: -4px;
}

.context-usage-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.compressing-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--color-brand-accent-light);
  margin-left: 6px;
}

.compressing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-brand-accent-light);
  animation: compressing-pulse 1.2s ease-in-out infinite;
}

@keyframes compressing-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

/* ── 上下文用量 hover 明细 ── */
.context-usage-popover {
  width: 280px;
  max-height: 320px;
  padding: 10px 12px;
  overflow-y: auto;
}

.context-usage-popover-inner {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--font-size-xs);
}

.cu-popover-cache {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.cu-popover-cache-label {
  color: var(--color-text-secondary);
  font-weight: 500;
}

.cu-popover-cache-rate {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-brand-accent-light);
}

.cu-popover-cache-detail {
  color: var(--color-text-muted);
}

.cu-popover-composition-title {
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-weight: 500;
}

.cu-popover-bar {
  display: flex;
  gap: 2px;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--color-bg-elevated);
}

.cu-popover-bar-seg {
  height: 100%;
  min-width: 2px;
}

.cu-popover-bar-seg--history { background: var(--color-brand-accent, #4f8cff); }
.cu-popover-bar-seg--system { background: var(--color-success, #4caf7d); }
.cu-popover-bar-seg--tools { background: var(--color-warning, #e0a13c); }
.cu-popover-bar-seg--skill { background: #9b7bf0; }
.cu-popover-bar-seg--mcp { background: #e06f9a; }

.cu-popover-legend {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.cu-popover-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cu-popover-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.cu-popover-legend-dot--history { background: var(--color-brand-accent, #4f8cff); }
.cu-popover-legend-dot--system { background: var(--color-success, #4caf7d); }
.cu-popover-legend-dot--tools { background: var(--color-warning, #e0a13c); }
.cu-popover-legend-dot--skill { background: #9b7bf0; }
.cu-popover-legend-dot--mcp { background: #e06f9a; }

.cu-popover-legend-label {
  color: var(--color-text-secondary);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cu-popover-legend-tokens {
  color: var(--color-text-muted);
  white-space: nowrap;
}

.cu-popover-empty {
  color: var(--color-text-muted);
}

@media (max-width: 480px) {
  .composer-run-controls {
    max-width: 220px;
  }

  .context-usage-content {
    flex: 0 0 auto;
  }

  .context-usage-label,
  .compressing-indicator {
    display: none;
  }
}
</style>
