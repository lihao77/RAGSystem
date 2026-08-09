<template>
  <aside v-if="mode === 'desktop'" class="participant-nav" aria-label="会话智能体">
    <div class="participant-nav__header">
      <div class="participant-nav__title">
        <UsersRound />
        <span>智能体</span>
        <Badge variant="secondary">{{ participants.length }}</Badge>
      </div>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon-xs" :disabled="loading" aria-label="刷新智能体" @click="emit('refresh')">
              <RefreshCw data-icon="inline-start" :class="{ 'participant-nav__spin': loading }" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>刷新智能体</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
    <ParticipantList
      :items="treeItems"
      :selected-id="selectedId"
      :loading="loading"
      @select="emit('select', $event)"
    />
  </aside>

  <div v-else class="participant-nav-mobile">
    <Sheet v-model:open="mobileOpen">
      <SheetTrigger as-child>
        <Button variant="ghost" size="sm" class="participant-nav-mobile__trigger">
          <Bot data-icon="inline-start" />
          <span class="truncate">{{ selectedParticipant?.display_name || '智能体' }}</span>
          <Badge v-if="participants.length > 1" variant="secondary">{{ participants.length }}</Badge>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" class="participant-nav-sheet">
        <SheetHeader>
          <SheetTitle>会话智能体</SheetTitle>
          <SheetDescription>{{ participants.length }} 个参与者</SheetDescription>
        </SheetHeader>
        <ParticipantList
          :items="treeItems"
          :selected-id="selectedId"
          :loading="loading"
          @select="selectFromSheet"
        />
      </SheetContent>
    </Sheet>
  </div>
</template>

<script setup>
import { computed, defineComponent, h, ref } from 'vue';
import { Bot, ChevronDown, GitBranch, RefreshCw, UsersRound } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const props = defineProps({
  mode: { type: String, default: 'desktop' },
  participants: { type: Array, default: () => [] },
  selectedId: { type: String, default: 'root' },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'refresh']);
const mobileOpen = ref(false);

const selectedParticipant = computed(() => props.participants.find(
  item => item?.participant_id === props.selectedId,
) || null);

const treeItems = computed(() => {
  const items = props.participants.filter(item => item?.participant_id);
  const byId = new Map(items.map(item => [item.participant_id, item]));
  const children = new Map();
  for (const item of items) {
    if (item.scope === 'root') continue;
    const parentId = item.parent_participant_id && byId.has(item.parent_participant_id)
      ? item.parent_participant_id
      : 'root';
    const siblings = children.get(parentId) || [];
    siblings.push(item);
    children.set(parentId, siblings);
  }
  const output = [];
  const visited = new Set();
  const visit = (item, depth) => {
    if (!item || visited.has(item.participant_id)) return;
    visited.add(item.participant_id);
    output.push({ participant: item, depth });
    for (const child of children.get(item.participant_id) || []) visit(child, depth + 1);
  };
  visit(items.find(item => item.scope === 'root') || byId.get('root'), 0);
  for (const item of items) visit(item, item.scope === 'root' ? 0 : 1);
  return output;
});

const statusLabel = (participant) => {
  const status = participant.last_run_status || participant.lifecycle_status;
  return {
    running: '运行中',
    suspended: '等待中',
    completed: '已完成',
    succeeded: '已完成',
    failed: '失败',
    interrupted: '已中断',
    active: '就绪',
  }[status] || status || '就绪';
};

const statusVariant = (participant) => {
  const status = participant.last_run_status || participant.lifecycle_status;
  if (status === 'running') return 'success';
  if (status === 'suspended') return 'warning';
  if (status === 'failed' || status === 'interrupted') return 'destructive';
  return 'secondary';
};

const ParticipantList = defineComponent({
  props: {
    items: { type: Array, default: () => [] },
    selectedId: { type: String, default: 'root' },
    loading: { type: Boolean, default: false },
  },
  emits: ['select'],
  setup(listProps, { emit: listEmit }) {
    return () => h('div', { class: 'participant-list' }, listProps.loading && !listProps.items.length
      ? [0, 1, 2].map(index => h(Skeleton, { key: index, class: 'participant-list__skeleton' }))
      : listProps.items.map(({ participant, depth }) => h(Button, {
          key: participant.participant_id,
          variant: 'ghost',
          class: 'participant-list__item',
          'data-selected': participant.participant_id === listProps.selectedId ? '' : undefined,
          style: { '--participant-depth': Math.min(depth, 4) },
          onClick: () => listEmit('select', participant.participant_id),
        }, () => [
          h(participant.scope === 'root' ? Bot : GitBranch, { 'data-icon': 'inline-start' }),
          h('span', { class: 'participant-list__identity' }, [
            h('span', { class: 'participant-list__name' }, participant.display_name || participant.agent_name),
            h('span', { class: 'participant-list__agent-name' }, participant.scope === 'root' ? '主智能体' : participant.agent_name),
          ]),
          h(Badge, { variant: statusVariant(participant) }, () => statusLabel(participant)),
        ])));
  },
});

const selectFromSheet = (participantId) => {
  emit('select', participantId);
  mobileOpen.value = false;
};
</script>

<style scoped>
.participant-nav {
  width: 224px;
  flex: 0 0 224px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-primary);
}

.participant-nav__header,
.participant-nav__title {
  display: flex;
  align-items: center;
}

.participant-nav__header {
  min-height: 52px;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--color-border);
}

.participant-nav__title {
  min-width: 0;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.participant-nav__title > svg {
  flex: 0 0 auto;
}

.participant-list {
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
}

.participant-list__item {
  width: 100%;
  height: 48px;
  justify-content: flex-start;
  padding-left: calc(10px + var(--participant-depth, 0) * 12px);
}

.participant-list__item[data-selected] {
  background: var(--color-active-bg);
  color: var(--color-text-primary);
}

.participant-list__identity {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}

.participant-list__name,
.participant-list__agent-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.participant-list__name {
  font-size: 13px;
}

.participant-list__agent-name {
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.participant-list__skeleton {
  height: 48px;
  width: 100%;
}

.participant-nav__spin {
  animation: participant-spin 900ms linear infinite;
}

.participant-nav-mobile {
  display: none;
  min-width: 0;
  padding: 4px 10px;
  border-bottom: 1px solid var(--color-border);
}

.participant-nav-mobile__trigger {
  max-width: 100%;
  min-width: 0;
}

.participant-nav-sheet :deep(.participant-list) {
  margin: 12px -8px 0;
}

@keyframes participant-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 1023px) {
  .participant-nav {
    display: none;
  }

  .participant-nav-mobile {
    display: block;
  }
}
</style>
