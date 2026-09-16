<template>
  <div
    :class="cn(
      'group/session relative flex min-w-0 items-center rounded-md p-1 transition-colors hover:bg-accent',
      active && 'bg-accent text-accent-foreground',
      compact && 'session-item--compact',
      hasTrailingPin && 'session-item--trailing-pin',
    )"
  >
    <!-- 项目与置顶条目固定保留左侧槽：运行图标、悬停图钉和空位共用位置。 -->
    <div v-if="hasLeadingPin" class="session-leading-slot">
      <LoaderCircle
        v-if="running"
        class="session-running session-leading-status animate-spin motion-reduce:animate-none"
        role="status"
        aria-label="会话运行中"
      />
      <Button
        variant="bare"
        size="icon-xs"
        class="session-pin-button size-5"
        :aria-label="pinned ? '取消置顶' : '置顶会话'"
        :title="pinned ? '取消置顶' : '置顶会话'"
        :aria-pressed="Boolean(pinned)"
        @click="$emit('toggle-pin', item)"
      >
        <PinOff v-if="pinned" data-icon="inline-start" />
        <Pin v-else data-icon="inline-start" />
      </Button>
    </div>
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      :aria-current="active ? 'page' : undefined"
      :title="detailTitle"
      @click="$emit('select', item)"
    >
      <!-- 左：标题 + 次行，自成一列，右侧时间与之垂直居中 -->
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="session-title truncate leading-5">{{ displayTitle }}</span>
        <span
          v-if="secondaryLabel && !compact"
          class="session-secondary truncate text-xs leading-4"
        >
          {{ secondaryLabel }}
        </span>
      </span>

      <!-- 状态与时间共用尾部槽，悬停时整体让位给操作。 -->
      <Badge v-if="item.unread_count > 0" variant="info" class="shrink-0">
        {{ item.unread_count }}
      </Badge>
      <span class="session-meta flex shrink-0 items-center gap-2 text-muted-foreground">
        <LoaderCircle v-if="running && !hasLeadingPin" class="session-running animate-spin motion-reduce:animate-none" role="status" aria-label="会话运行中" />
        <span class="session-time text-xs leading-5">{{ timeLabel }}</span>
      </span>
    </button>

    <div class="session-actions">
      <Button
        v-if="hasTrailingPin"
        variant="bare"
        size="icon-xs"
        class="session-pin-button size-5"
        :aria-label="pinned ? '取消置顶' : '置顶会话'"
        :title="pinned ? '取消置顶' : '置顶会话'"
        :aria-pressed="Boolean(pinned)"
        @click="$emit('toggle-pin', item)"
      >
        <PinOff v-if="pinned" data-icon="inline-start" />
        <Pin v-else data-icon="inline-start" />
      </Button>
      <Button
        variant="action-danger"
        size="icon-xs"
        class="session-delete-button size-5"
        aria-label="删除会话"
        title="删除会话"
        @click="$emit('delete', item)"
      >
        <Trash2 data-icon="inline-start" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SessionListItem } from '@ragsystem/api-contracts';
import { LoaderCircle, Pin, PinOff, Trash2 } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatSessionTime } from '@/composables/useSessionListTime.js';

const props = defineProps<{
  item: SessionListItem;
  active?: boolean;
  compact?: boolean;
  running?: boolean;
  pinnable?: boolean;
  pinned?: boolean;
  pinPlacement?: 'leading' | 'trailing';
  now: Date;
}>();

defineEmits<{
  select: [item: SessionListItem];
  delete: [item: SessionListItem];
  'toggle-pin': [item: SessionListItem];
}>();

const hasLeadingPin = computed(() => (props.pinnable || props.pinned) && props.pinPlacement !== 'trailing');
const hasTrailingPin = computed(() => (props.pinnable || props.pinned) && props.pinPlacement === 'trailing');

const channelLabels = {
  web: 'Web',
  api: 'API',
  feishu: '飞书',
  cron: '定时任务',
  widget_embed: 'Widget Embed',
  widget_api: 'Widget API',
} as const;
const originTypeLabels = {
  bot: 'Bot',
  widget: 'Widget',
} as const;

const displayTitle = computed(() => {
  const title = props.item.title.trim();
  if (title) return title;
  const fallback = (props.item.first_message || props.item.last_message).trim();
  return fallback ? fallback.slice(0, 30) : '新会话';
});

const channelLabel = computed(() => channelLabels[props.item.origin.channel]);

const originLabel = computed(() => {
  if (props.item.origin.type === 'direct') return props.item.origin.display_name;
  return `${originTypeLabels[props.item.origin.type]} · ${props.item.origin.display_name}`;
});

/** 次行只保留最有区分度的一条：优先 workspace，其次非 direct 来源 */
const secondaryLabel = computed(() => {
  if (props.item.workspace?.display_name) return props.item.workspace.display_name;
  if (props.item.origin.type !== 'direct') return originLabel.value;
  return '';
});

/** hover title 保留完整元信息，不占布局 */
const detailTitle = computed(() => {
  const parts = [displayTitle.value];
  if (props.item.origin.type !== 'direct') parts.push(originLabel.value);
  parts.push(channelLabel.value);
  if (props.item.workspace?.display_name) {
    parts.push(props.item.workspace.display_name);
  }
  if (props.item.workspace?.root_path) {
    parts.push(props.item.workspace.root_path);
  }
  return parts.join('\n');
});

const timeLabel = computed(() => formatSessionTime(props.item.activity_at, props.now));
</script>

<style scoped>
/* 会话条目：标题保持一级色（参考实现的会话标题就是一级灰 ≈ #d4d4d4，
   时间戳/次行才降到 muted），这里只把字重收常规、字号收到 13px */
.session-title {
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 400;
}

/* 次行辅助信息：比 muted 再淡一档；不用 text-muted/xx（token 是实色 hex，opacity 修饰不生效） */
.session-secondary {
  color: color-mix(in srgb, var(--color-text-muted) 58%, transparent);
}

.session-item--compact {
  min-height: 32px;
  padding-top: 2px;
  padding-bottom: 2px;
}

.session-item--compact > button {
  padding-top: 3px;
  padding-bottom: 3px;
}

.session-leading-slot {
  position: relative;
  display: flex;
  width: 22px;
  height: 28px;
  flex: 0 0 22px;
  align-items: center;
  justify-content: center;
}

.session-running {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.session-leading-status {
  color: var(--color-text-muted);
  scale: 1;
  transition: opacity 150ms ease, scale 180ms ease;
}

.session-leading-slot .session-pin-button {
  position: absolute;
  opacity: 0;
  pointer-events: none;
  transform: scale(0.75);
  transition:
    opacity 150ms ease,
    transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    color 150ms ease,
    background-color 150ms ease;
}

.group\/session:hover .session-leading-slot .session-pin-button,
.group\/session:focus-within .session-leading-slot .session-pin-button {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1);
}

/* 按钮自身的 hover 反馈作用于 SVG，保留 14px 尺寸与透明图钉背景。 */
.session-pin-button :deep(svg),
.session-actions :deep(svg) {
  transition: color 150ms ease, stroke-width 150ms ease, transform 180ms ease;
}

.session-pin-button:is(:hover, :focus-visible) :deep(svg) {
  color: var(--color-text-primary);
  stroke-width: 2.5;
  transform: translateY(-1px) rotate(-12deg);
}

.session-delete-button:is(:hover, :focus-visible) :deep(svg) {
  stroke-width: 2.5;
  transform: translateY(-1px);
}

.group\/session:hover .session-leading-status,
.group\/session:focus-within .session-leading-status {
  opacity: 0;
  scale: 0.75;
}

/* 操作覆盖尾部元信息；标题不跳动，按钮数量可继续扩展。 */
.session-actions {
  position: absolute;
  inset: 0 4px 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: 4px;
  border-radius: inherit;
  opacity: 0;
  pointer-events: none;
  transform: translateX(6px) scale(0.88);
  transform-origin: right center;
  transition: opacity 150ms ease, transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.session-meta {
  min-width: 28px;
  justify-content: flex-end;
  transform: translateX(0);
  transition: opacity 150ms ease, transform 180ms ease;
}

/* 两个 20px 操作按钮及间距的占位，避免悬停时覆盖标题。 */
.session-item--trailing-pin .session-meta {
  min-width: 46px;
}

.group\/session:hover .session-actions,
.group\/session:focus-within .session-actions {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0) scale(1);
}

.group\/session:hover .session-meta,
.group\/session:focus-within .session-meta {
  opacity: 0;
  transform: translateX(-6px);
}

/* 触摸设备常显操作并保留状态，避免依赖不存在的 hover。 */
@media (hover: none) and (pointer: coarse) {
  .session-actions {
    position: static;
    flex-shrink: 0;
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }

  .group\/session .session-meta {
    min-width: 0;
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .session-actions,
  .session-meta,
  .session-leading-slot .session-pin-button,
  .session-leading-status,
  .session-pin-button :deep(svg),
  .session-actions :deep(svg) {
    transition: none;
  }

  .session-pin-button:is(:hover, :focus-visible) :deep(svg),
  .session-delete-button:is(:hover, :focus-visible) :deep(svg) {
    transform: none;
  }
}
</style>
