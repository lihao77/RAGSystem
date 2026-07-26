<template>
  <div
    :class="cn(
      'flex min-w-0 items-start gap-1 rounded-md p-1 transition-colors hover:bg-accent',
      active && 'bg-accent text-accent-foreground',
    )"
  >
    <button
      type="button"
      class="flex min-w-0 flex-1 items-start gap-2 rounded-sm px-1 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      :aria-current="active ? 'page' : undefined"
      @click="$emit('select', item)"
    >
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ displayTitle }}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ timeLabel }}</span>
        </span>
        <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Tooltip v-if="item.origin.type !== 'direct'">
            <TooltipTrigger as-child>
              <Badge variant="secondary" class="max-w-28 shrink truncate">
                {{ originLabel }}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{{ originLabel }}</TooltipContent>
          </Tooltip>
          <span v-else class="truncate">{{ channelLabel }}</span>
          <span v-if="item.origin.type !== 'direct'" class="shrink-0">· {{ channelLabel }}</span>
          <template v-if="item.workspace">
            <span class="shrink-0">·</span>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="min-w-0 truncate">{{ item.workspace.display_name }}</span>
              </TooltipTrigger>
              <TooltipContent class="max-w-80">
                <span class="flex flex-col gap-1">
                  <span>{{ item.workspace.display_name }}</span>
                  <span v-if="item.workspace.root_path">{{ item.workspace.root_path }}</span>
                </span>
              </TooltipContent>
            </Tooltip>
          </template>
          <Badge v-if="item.unread_count > 0" class="ml-auto shrink-0">
            {{ item.unread_count }}
          </Badge>
        </span>
      </span>
    </button>

    <Button
      variant="action-danger"
      size="icon-xs"
      class="shrink-0 opacity-70"
      aria-label="删除会话"
      @click="$emit('delete', item)"
    >
      <Trash2 data-icon="inline-start" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SessionListItem } from '@ragsystem/api-contracts';
import { Trash2 } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatSessionTime } from '@/composables/useSessionListTime.js';

const props = defineProps<{
  item: SessionListItem;
  active?: boolean;
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
const originLabel = computed(() => props.item.origin.type === 'direct'
  ? props.item.origin.display_name
  : `${originTypeLabels[props.item.origin.type]} · ${props.item.origin.display_name}`);
const timeLabel = computed(() => formatSessionTime(props.item.activity_at, props.now));
</script>
