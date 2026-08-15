<template>
  <div
    :class="cn(
      'group/session flex min-w-0 items-center gap-1 rounded-md p-1 transition-colors hover:bg-accent',
      active && 'bg-accent text-accent-foreground',
      compact && 'session-item--compact',
    )"
  >
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      :aria-current="active ? 'page' : undefined"
      :title="detailTitle"
      @click="$emit('select', item)"
    >
      <!-- 左：标题 + 次行，自成一列，右侧时间与之垂直居中 -->
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-sm font-medium leading-5">{{ displayTitle }}</span>
        <span
          v-if="secondaryLabel && !compact"
          class="session-secondary truncate text-xs leading-4"
        >
          {{ secondaryLabel }}
        </span>
      </span>

      <!-- 右：未读 + 时间，与左侧内容块垂直居中；未读用 info 变体保持提醒强调 -->
      <Badge v-if="item.unread_count > 0" variant="info" class="shrink-0">
        {{ item.unread_count }}
      </Badge>
      <span class="session-time shrink-0 text-xs leading-5 text-muted-foreground">
        {{ timeLabel }}
      </span>
    </button>

    <!-- 删除槽与选择按钮同高居中；hover 展开挤时间 -->
    <div class="session-delete-slot">
      <Button
        variant="action-danger"
        size="icon-xs"
        class="session-delete-btn"
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
import { Trash2 } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatSessionTime } from '@/composables/useSessionListTime.js';

const props = defineProps<{
  item: SessionListItem;
  active?: boolean;
  compact?: boolean;
  now: Date;
}>();

defineEmits<{
  select: [item: SessionListItem];
  delete: [item: SessionListItem];
}>();

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

.session-item--compact > button > span:first-child > span:first-child {
  font-size: 13px;
  font-weight: 400;
}

/* icon-xs = size-7 = 1.75rem；默认槽宽 0，hover 展开把时间挤向左 */
.session-delete-slot {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 0;
  height: 1.75rem;
  margin-left: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition:
    width 180ms ease,
    margin-left 180ms ease,
    opacity 150ms ease;
}

.session-delete-btn {
  width: 1.75rem;
  min-width: 1.75rem;
  height: 1.75rem;
  transform: scale(0.88);
  transition: transform 180ms ease;
}

.group\/session:hover .session-delete-slot,
.group\/session:focus-within .session-delete-slot {
  width: 1.75rem;
  margin-left: 0.125rem;
  opacity: 1;
  pointer-events: auto;
}

.group\/session:hover .session-delete-btn,
.group\/session:focus-within .session-delete-btn {
  transform: scale(1);
}

/* 触摸设备没有 hover，删除常显，避免无法删除 */
@media (hover: none) and (pointer: coarse) {
  .session-delete-slot {
    width: 1.75rem;
    margin-left: 0.125rem;
    opacity: 0.75;
    pointer-events: auto;
  }

  .session-delete-btn {
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .session-delete-slot,
  .session-delete-btn {
    transition: none;
  }
}
</style>
